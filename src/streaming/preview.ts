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
