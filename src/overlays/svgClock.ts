// SHARED SVG ANIMATION CLOCK + BAKED-STRING CACHE — the perf spine for the mobile
// SMIL baker (and any platform that has to re-render SVG per frame to animate it).
//
// ── Why this exists (the divergence-from-web root cause) ─────────────────────
// Web renders SMIL <animate*> NATIVELY: the browser advances the animation on the
// compositor/GPU, OFF the JS thread, so the live SVG set's TTL pruner (a 1s timer on
// the JS thread) always fires on time and the set converges exactly as the shared
// reducer dictates.
//
// Mobile has no native SMIL: react-native-svg's <SvgXml> drops <animate*>, so each
// overlay must be RE-BAKED in JS every frame (svgAnimate.ts). The first cut gave EACH
// SvgHost its OWN requestAnimationFrame loop AND re-ran bakeSvgAnimations (a full
// string tokenize+rebuild) inside the render body. With N live overlays that is N rAF
// loops + N full re-bakes per frame on the JS thread. The thread saturates, frame-rate
// drops below 60, AND — the load-bearing consequence — the 1s prune setInterval STARVES
// (timer callbacks queue behind the rAF/render storm and fire late/coalesced). Expired
// overlays therefore linger far past their TTL and visibly PILE UP, even though the
// shared reducer is correct. The perf bug IS the lifecycle bug.
//
// This module removes that load at the source:
//   1. ONE clock (a single rAF when available, else a setInterval) ticks at a ~30fps
//      QUANTUM and fans out to every subscriber — replacing N independent rAF loops
//      with 1, regardless of how many overlays are live.
//   2. The clock only notifies subscribers when the quantum bucket actually advances,
//      so a 120Hz display still bakes at ~30fps (no wasted bakes).
//   3. It PAUSES when no one is subscribed and can be paused/resumed by the platform
//      (e.g. on AppState background) so a buried/backgrounded room burns nothing.
//   4. bakeCached() memoizes the baked output per (svg, quantum-bucket) in a bounded
//      LRU, so re-rendering the SAME overlay at the SAME bucket (a spurious React
//      re-render) reuses the last bake instead of re-tokenizing — and the work for a
//      bucket is done at most ONCE across ALL hosts sharing that svg.
//
// PURE + platform-free: feature-detects requestAnimationFrame/performance off
// globalThis (no lib.dom). The view layer (@paxpia/ui) drives it; the host leaves the
// rAF loop entirely.

import { bakeSvgAnimations } from './svgAnimate';

/** The animation quantum (~30fps). The clock advances its bucket every ANIM_QUANTUM_MS
 *  and only then notifies subscribers, so the bake advances at ~30fps even on a 60/120Hz
 *  display. Exported so the view layer and tests share the exact cadence. */
export const SVG_ANIM_QUANTUM_MS = 33;

type Now = () => number;

const gg = globalThis as unknown as {
  requestAnimationFrame?: (cb: (t: number) => void) => number;
  cancelAnimationFrame?: (h: number) => void;
  performance?: { now(): number };
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
};

const now: Now = () =>
  gg.performance && typeof gg.performance.now === 'function' ? gg.performance.now() : Date.now();

/**
 * A single shared animation clock. One driver (rAF when present, else a ~30fps
 * interval) fans a monotonically-advancing quantum bucket out to every subscriber.
 * The driver runs ONLY while there is ≥1 subscriber AND the clock isn't paused, so an
 * idle/backgrounded layer costs nothing.
 */
export class SvgAnimationClock {
  private subs = new Set<(bucket: number) => void>();
  private rafHandle: number | null = null;
  private intervalHandle: unknown = null;
  private startedAt = now();
  private lastBucket = -1;
  private paused = false;

  /** The current quantum bucket (ms-since-start / quantum). Hosts read this to bake the
   *  correct frame in their render body WITHOUT running their own clock. */
  bucket(): number {
    return Math.floor((now() - this.startedAt) / SVG_ANIM_QUANTUM_MS);
  }

  /** The animation clock time (ms) for the current bucket — what the baker wants as
   *  `nowMs`. Quantized so it matches the cached bake key exactly. */
  timeMs(): number {
    return this.bucket() * SVG_ANIM_QUANTUM_MS;
  }

  /** Subscribe to bucket-advance ticks. The callback fires (with the new bucket) at
   *  ~30fps while the clock runs. Returns an unsubscribe fn; the driver stops when the
   *  last subscriber leaves. */
  subscribe(cb: (bucket: number) => void): () => void {
    this.subs.add(cb);
    this.ensureRunning();
    return () => {
      this.subs.delete(cb);
      if (this.subs.size === 0) this.stop();
    };
  }

  /** Pause the driver (e.g. AppState → background) — subscribers stay registered but
   *  receive no ticks and no frames are computed until resume(). */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.stop();
  }

  /** Resume after pause(); restarts the driver if anyone is still subscribed. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.ensureRunning();
  }

  private ensureRunning(): void {
    if (this.paused || this.subs.size === 0) return;
    if (this.rafHandle != null || this.intervalHandle != null) return;
    if (gg.requestAnimationFrame) {
      const loop = () => {
        this.tick();
        // Re-check: tick() may have been the last frame before a stop().
        if (this.rafHandle != null) this.rafHandle = gg.requestAnimationFrame!(loop);
      };
      this.rafHandle = gg.requestAnimationFrame(loop);
    } else if (gg.setInterval) {
      this.intervalHandle = gg.setInterval(() => this.tick(), SVG_ANIM_QUANTUM_MS);
    }
  }

  private stop(): void {
    if (this.rafHandle != null && gg.cancelAnimationFrame) gg.cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    if (this.intervalHandle != null && gg.clearInterval) gg.clearInterval(this.intervalHandle);
    this.intervalHandle = null;
  }

  private tick(): void {
    const b = this.bucket();
    if (b === this.lastBucket) return; // same quantum → no bake, no notify
    this.lastBucket = b;
    for (const cb of this.subs) cb(b);
  }
}

/** The process-wide shared clock every SvgHost subscribes to. ONE rAF loop for the
 *  whole live set instead of one-per-overlay. */
export const sharedSvgClock = new SvgAnimationClock();

// ── Bounded baked-string LRU ─────────────────────────────────────────────────
// Keyed by (svg, bucket). Re-rendering the SAME overlay at the SAME bucket reuses the
// bake; and because the cache is shared, the heavy tokenize+rebuild for a given bucket
// runs at most ONCE even if multiple hosts render the same svg. Bounded so a long-lived
// room with churning overlays can't grow it without bound.

const BAKE_CACHE_MAX = 96;
const bakeCache = new Map<string, string>();

/**
 * Bake `svg` at the clock time for `bucket`, memoized in a bounded LRU keyed by
 * (svg, bucket). The heavy svgAnimate.bakeSvgAnimations runs at most once per key.
 * A static svg (no SMIL) round-trips through bakeSvgAnimations cheaply (it early-returns
 * the input unchanged), but callers should gate on hasSmilAnimation before subscribing
 * to the clock at all.
 */
export function bakeCached(svg: string, bucket: number): string {
  // A compact key: the svg length + a cheap rolling hash keeps the key short without
  // holding the whole (possibly 15 KiB) string as a Map key per bucket.
  const key = `${bucket}|${svg.length}|${cheapHash(svg)}`;
  const hit = bakeCache.get(key);
  if (hit !== undefined) {
    // LRU touch: re-insert to mark most-recently-used.
    bakeCache.delete(key);
    bakeCache.set(key, hit);
    return hit;
  }
  const baked = bakeSvgAnimations(svg, bucket * SVG_ANIM_QUANTUM_MS);
  bakeCache.set(key, baked);
  if (bakeCache.size > BAKE_CACHE_MAX) {
    // Evict the oldest (first) entry — Map preserves insertion order.
    const oldest = bakeCache.keys().next().value;
    if (oldest !== undefined) bakeCache.delete(oldest);
  }
  return baked;
}

/** Clear the bake cache (tests / room teardown). */
export function clearBakeCache(): void {
  bakeCache.clear();
}

/** A fast, allocation-free 32-bit rolling hash (FNV-1a style) for the cache key. Not
 *  cryptographic — only used to disambiguate same-length svg strings within a bucket. */
function cheapHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
