// Shared CDN-snippet PREVIEW state machine — the platform-agnostic brain behind
// the muted/looping ~480p MP4 preview reels the live grid + "For you" feed tiles
// show (the backend's preview_url on Bunny CDN). Extracted from the web
// StreamPreview so web AND mobile share ONE refresh/back-off/in-flight policy:
// "implement once (web), it applies to mobile."
//
// ── What it owns (the policy) ────────────────────────────────────────────────
//   • A SINGLE stable URL — the sampler OVERWRITES one object per stream every
//     few seconds, so we reload the SAME url (no `?t=` cache-busting, which would
//     mint infinite distinct URLs and explode CDN storage/egress). Freshness
//     comes from the object's short cache headers.
//   • ONE load in flight at a time (the in-flight guard) — never a recursive
//     pile-up that tight-loops and stalls the page.
//   • Exponential BACK-OFF on error (capped) instead of a fixed fast retry loop;
//     a successful load RESETS the back-off to the base refresh cadence.
//   • Configurable refresh cadence (>= the sampler's capture interval).
//
// ── What it does NOT own (the platform seam) ─────────────────────────────────
//   The actual media element + the timer. Web double-buffers two <video> tags
//   for a black-flash-free swap; mobile renders a single RN <Video>. Both call
//   the SAME methods here and act on the returned PreviewAction:
//     - LOAD  → set your (hidden, on web) media element's source to `url`
//     - WAIT  → schedule the next tick `delayMs` from now, then call `tick()`
//     - IDLE  → nothing to do (no url, or stopped)
//   and feed results back via onLoaded() / onError() / tick(). The machine never
//   touches a clock or a DOM/RN node, so it imports cleanly under Vite + Metro.

/** Tunables for the preview loop. All optional; sensible defaults applied. */
export interface PreviewConfig {
  /** How often to reload the (stable) snippet url on success, ms. Should be >=
   *  the sampler capture interval. Default 5000. */
  refreshMs?: number;
  /** Upper bound for the exponential back-off after errors, ms. Default 60000. */
  maxBackoffMs?: number;
}

const DEFAULT_REFRESH_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

/** What the platform render layer should do next, returned by every machine call. */
export type PreviewAction =
  /** Nothing to do (no url set, or the machine is stopped). */
  | { type: 'idle' }
  /** Load `url` into the media element now. A load is in flight until the
   *  platform reports back via onLoaded()/onError(). */
  | { type: 'load'; url: string }
  /** Schedule a refresh: wait `delayMs`, then call tick(). */
  | { type: 'wait'; delayMs: number };

/** Serializable snapshot — handy for a React useReducer/useState mirror or tests. */
export interface PreviewSnapshot {
  /** The stable snippet url, or undefined when none is set. */
  url?: string;
  /** Is a load currently in flight (the in-flight guard)? */
  loading: boolean;
  /** Has ANY frame ever loaded? Drives the "fall back to poster" decision: only
   *  fall back if no frame ever painted; a later transient error keeps the last
   *  good frame. */
  everLoaded: boolean;
  /** Current back-off delay (ms) — base refresh on success, grows on error. */
  backoffMs: number;
  /** True once stop() has been called; the machine then only emits `idle`. */
  stopped: boolean;
}

/**
 * The preview state machine. Construct one per tile, call setUrl() with the
 * room's preview_url, then drive the loop:
 *   const a = m.start();           // → {load} (or {idle} if no url)
 *   // platform loads a.url; on success:
 *   const b = m.onLoaded();        // → {wait, delayMs}
 *   // after delayMs:
 *   const c = m.tick();            // → {load} again
 *   // on a load failure instead:
 *   const d = m.onError();         // → {wait, delayMs} (backed off) or {idle} if first frame failed
 *
 * onError() returns `firstFrameFailed: true` (out-of-band, see method) when the
 * VERY FIRST load fails so the platform can fall back to a poster/gradient.
 */
export class PreviewMachine {
  private url?: string;
  private loading = false;
  private everLoaded = false;
  private stopped = false;
  private readonly refreshMs: number;
  private readonly maxBackoffMs: number;
  private backoffMs: number;

  constructor(cfg: PreviewConfig = {}) {
    this.refreshMs = cfg.refreshMs && cfg.refreshMs > 0 ? cfg.refreshMs : DEFAULT_REFRESH_MS;
    this.maxBackoffMs =
      cfg.maxBackoffMs && cfg.maxBackoffMs > 0 ? cfg.maxBackoffMs : DEFAULT_MAX_BACKOFF_MS;
    this.backoffMs = this.refreshMs;
  }

  /** Point the machine at a (new) stable snippet url. Passing undefined/empty
   *  parks it (idle). Resets per-url state so a url change starts fresh. */
  setUrl(url: string | undefined): void {
    this.url = url || undefined;
    this.loading = false;
    this.everLoaded = false;
    this.backoffMs = this.refreshMs;
  }

  /** Begin the loop: emits the first load (or idle if no url / stopped). */
  start(): PreviewAction {
    if (this.stopped || !this.url) return { type: 'idle' };
    return this.beginLoad();
  }

  /** A scheduled refresh fired. Kicks the next load if free; otherwise re-waits
   *  (defends against a tick landing while a load is still in flight). */
  tick(): PreviewAction {
    if (this.stopped || !this.url) return { type: 'idle' };
    if (this.loading) return { type: 'wait', delayMs: this.backoffMs };
    return this.beginLoad();
  }

  /** The platform reports the current load SUCCEEDED. Clears in-flight, resets
   *  back-off, and schedules the next refresh at the base cadence. */
  onLoaded(): PreviewAction {
    this.loading = false;
    this.everLoaded = true;
    this.backoffMs = this.refreshMs;
    if (this.stopped || !this.url) return { type: 'idle' };
    return { type: 'wait', delayMs: this.refreshMs };
  }

  /**
   * The platform reports the current load FAILED. Behaviour:
   *   • If NO frame has EVER loaded → this is a hard failure for the tile; the
   *     caller should fall back to poster/gradient. We signal that via
   *     `firstFrameFailed` and emit `idle` (the platform decides whether to keep
   *     retrying or show the poster; the web tile shows the poster).
   *   • Otherwise a previous good frame is still showing — keep it, back off
   *     (capped), and retry. Returns `{wait}` with the grown delay.
   */
  onError(): { action: PreviewAction; firstFrameFailed: boolean } {
    this.loading = false;
    if (!this.everLoaded) {
      return { action: { type: 'idle' }, firstFrameFailed: true };
    }
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    if (this.stopped || !this.url) return { action: { type: 'idle' }, firstFrameFailed: false };
    return { action: { type: 'wait', delayMs: this.backoffMs }, firstFrameFailed: false };
  }

  /** Tear down: every subsequent call emits `idle`. Call on unmount. */
  stop(): void {
    this.stopped = true;
    this.loading = false;
  }

  /** Read-only snapshot (tests / React mirror). */
  snapshot(): PreviewSnapshot {
    return {
      url: this.url,
      loading: this.loading,
      everLoaded: this.everLoaded,
      backoffMs: this.backoffMs,
      stopped: this.stopped,
    };
  }

  private beginLoad(): PreviewAction {
    if (!this.url) return { type: 'idle' };
    if (this.loading) return { type: 'wait', delayMs: this.backoffMs };
    this.loading = true;
    return { type: 'load', url: this.url };
  }
}

/** Convenience constructor (mirrors the rest of the streaming module's fn style). */
export function newPreviewMachine(cfg?: PreviewConfig): PreviewMachine {
  return new PreviewMachine(cfg);
}

// ── PREVIEW HOT-SWAP GATE ─────────────────────────────────────────────────────
// The shared "preload the NEXT preview, keep showing the CURRENT one, swap ONLY
// when the next has genuinely decoded a frame" ready-gate. PreviewMachine above
// owns the *same-url refresh* loop (freshness via cache headers); THIS owns the
// orthogonal *url-CHANGE* transition — when the backend assigns a new preview
// version to a tile, the visible source must never blank to avatar (web) or black
// (mobile) mid-swap.
//
// The bug it fixes: platforms used to point the visible element at the new url
// immediately (or flip to a not-yet-loaded buffer). For the few hundred ms before
// the new bytes decode, the element paints nothing → the poster (avatar/cold
// image) shows through. The gate inverts the ordering: PRELOAD into a hidden slot,
// hold the current frame, and SWAP only on the platform's decoded-frame signal.
//
// Pure + clockless + DOM/RN-free, exactly like PreviewMachine, so web (two <video>
// buffers + requestVideoFrameCallback/canplaythrough) and mobile (two RN players +
// onReadyToDisplay) drive the IDENTICAL logic; only the leaf preload/ready signal
// differs.

/** Which of the two media slots a platform double-buffers between. */
export type PreviewSlot = 'a' | 'b';

/** What the platform should do with its two slots after a gate call. */
export type SwapAction =
  /** Nothing changed — current slot stays visible, no preload needed. */
  | { type: 'idle' }
  /** Preload `url` into the HIDDEN slot (`into`) and wait for its decoded-frame
   *  signal. Keep the currently visible slot painted untouched until then. */
  | { type: 'preload'; url: string; into: PreviewSlot }
  /** The hidden slot is decoded-ready — make `slot` the visible one NOW. The new
   *  url is fully painted, so this swap shows no intermediate frame. */
  | { type: 'swap'; slot: PreviewSlot };

/** Serializable snapshot of the gate (tests / React mirror). */
export interface SwapSnapshot {
  /** The slot currently painted to the user. */
  visible: PreviewSlot;
  /** The url that slot is showing (undefined before the first preview lands). */
  visibleUrl?: string;
  /** The url being preloaded into the hidden slot, if a transition is in flight. */
  pendingUrl?: string;
}

/**
 * The hot-swap gate. One per tile, alongside (not replacing) the PreviewMachine.
 *
 *   const g = new PreviewSwapGate();
 *   // url assigned/changes:
 *   const a = g.request(url);     // first url → {preload into:'a'}; a CHANGE → {preload into:hidden}
 *   // platform preloads a.url into a.into, waits for a DECODED frame, then:
 *   const b = g.onReady(a.into);  // → {swap slot} (or {idle} if it's stale)
 *   // if the preload errors instead:
 *   g.onError(a.into);            // → drops the pending transition; current frame stays
 *
 * Invariants that kill the avatar/black flash:
 *   • The visible slot is NEVER changed except by an explicit {swap}, which is only
 *     emitted AFTER the platform confirms the hidden slot decoded a frame.
 *   • A url-change targets the HIDDEN slot, so the visible slot keeps its last good
 *     frame the entire time the new url is loading.
 *   • Re-requesting the url that's already visible is a no-op ({idle}) — no reload,
 *     no flicker. A request matching the in-flight pending url is also a no-op.
 */
export class PreviewSwapGate {
  private visible: PreviewSlot = 'a';
  private visibleUrl?: string;
  private pendingUrl?: string;

  /** First url, or a changed url. Returns the slot to preload into (the hidden one)
   *  or idle when nothing needs to change. The visible slot is left untouched. */
  request(url: string | undefined): SwapAction {
    const next = url || undefined;
    // Already showing it, with no competing transition → nothing to do.
    if (next === this.visibleUrl && !this.pendingUrl) return { type: 'idle' };
    // Already preloading exactly this → don't restart the load (avoids a flicker
    // loop if request() fires repeatedly with the same new url).
    if (next === this.pendingUrl) return { type: 'idle' };
    // Cleared → nothing to preload; visible slot keeps its last frame (the platform
    // decides whether to hide the element, but the gate never forces a blank).
    if (!next) {
      this.pendingUrl = undefined;
      return { type: 'idle' };
    }
    // A genuine change: preload into the hidden slot, keep the visible one painted.
    this.pendingUrl = next;
    return { type: 'preload', url: next, into: this.hidden() };
  }

  /** The hidden slot reported a DECODED first frame for its preload. If it still
   *  matches the pending transition, swap it to visible; otherwise it's stale. */
  onReady(slot: PreviewSlot): SwapAction {
    // Stale ready (a newer request superseded this one, or it's the visible slot
    // re-firing its own ready) → ignore; don't disturb what's painted.
    if (slot === this.visible || this.pendingUrl === undefined) return { type: 'idle' };
    this.visible = slot;
    this.visibleUrl = this.pendingUrl;
    this.pendingUrl = undefined;
    return { type: 'swap', slot };
  }

  /** The pending preload failed. Drop the transition; the visible slot keeps its
   *  current frame (no avatar/black fallback). Returns idle — the caller's own
   *  PreviewMachine back-off governs whether/when to retry the url. */
  onError(slot: PreviewSlot): SwapAction {
    if (slot === this.hidden()) this.pendingUrl = undefined;
    return { type: 'idle' };
  }

  /** The slot NOT currently visible — where a preload goes. */
  hidden(): PreviewSlot {
    return this.visible === 'a' ? 'b' : 'a';
  }

  /** The slot currently painted. */
  visibleSlot(): PreviewSlot {
    return this.visible;
  }

  /** Make `slot` visible directly — used by the SAME-url refresh path, where the
   *  hidden buffer has been reloaded with the CURRENT url and decoded a fresh
   *  frame. Like {swap}, the platform only calls this AFTER a decoded-frame signal,
   *  so it never reveals the poster. (A url-CHANGE goes through request()/onReady()
   *  instead, which also tracks visibleUrl/pendingUrl.) */
  setVisible(slot: PreviewSlot): void {
    this.visible = slot;
  }

  snapshot(): SwapSnapshot {
    return { visible: this.visible, visibleUrl: this.visibleUrl, pendingUrl: this.pendingUrl };
  }
}

/** Convenience constructor (matches the module's fn style). */
export function newPreviewSwapGate(): PreviewSwapGate {
  return new PreviewSwapGate();
}
