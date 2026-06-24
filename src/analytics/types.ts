// @paxpia/core/analytics — impression-metric DOMAIN TYPES (WS5 / D6, 2026-06-24).
//
// The platform-free, JSON-serializable shapes shared by:
//   • Paxpia-web    — creator analytics (the dashboard a streamer/educator sees)
//   • Paxpia-admin  — monitoring (trust-mix, bot %, anomaly boards)
//   • the Go backend — mirrors these as the read-API wire shapes (analytics-service §3,
//     a greenfield creator rollup API; the trust columns ride ClickHouse migration 005).
//
// Types ONLY here (no logic, no DOM, no platform deps). The pure aggregation helpers
// live in ./aggregate.ts; the recharts components consuming these live in
// @paxpia/ui/charts. Mobile reuses these data shapes (native charts later).
//
// Everything below is a plain JSON value (no Date, no Map, no class) so a series can be
// produced by ClickHouse → JSON → fetch → component with zero adapters. Timestamps are
// epoch-based numbers (see TimeBucket.unixMinute).

// ─── Trust ─────────────────────────────────────────────────────────────────────

/** A principal's trust classification, as produced by the gateway's 12-rule trust
 *  classifier (anti-spam.md §11). Ordered best→worst. `adversarial` is a confirmed
 *  bad actor (hard-limited); `suspect` is flagged-but-unconfirmed. */
export type TrustTier = 'verified' | 'normal' | 'low' | 'suspect' | 'adversarial';

/** The canonical tier order (best → worst) — drives stable chart stacking + legends so
 *  every render site colours/orders tiers identically. */
export const TRUST_TIERS: readonly TrustTier[] = [
  'verified',
  'normal',
  'low',
  'suspect',
  'adversarial',
] as const;

/** Tiers a fraud/bot heuristic counts as "not a real human view". Used by `botPct`. */
export const BOTTY_TIERS: readonly TrustTier[] = ['suspect', 'adversarial'] as const;

// ─── Events ──────────────────────────────────────────────────────────────────────

/** The impression/engagement event kinds the client echoes back (with its `pxi.` token)
 *  on the gateway's verify→classify→produce pipeline. `impression` = item entered the
 *  viewport pool; `view` = a qualified view (dwell threshold); `watch_pulse` = a periodic
 *  heartbeat during playback / live (rides the LiveKit data-track for live). The rest are
 *  the engagement + live-presence signals. */
export type ImpressionEventType =
  | 'impression'
  | 'view'
  | 'watch_pulse'
  | 'like'
  | 'comment'
  | 'share'
  | 'follow'
  | 'gift'
  | 'live_join'
  | 'live_leave';

/** All event types, for iteration/validation. */
export const IMPRESSION_EVENT_TYPES: readonly ImpressionEventType[] = [
  'impression',
  'view',
  'watch_pulse',
  'like',
  'comment',
  'share',
  'follow',
  'gift',
  'live_join',
  'live_leave',
] as const;

// ─── Time series ───────────────────────────────────────────────────────────────

/** One point in a time series. `unixMinute` is the bucket key — epoch MINUTES (Unix
 *  seconds ÷ 60, floored) so a bucket is a small integer and JSON stays compact; `count`
 *  is the aggregate value in that minute. Use minutes (not ms) to keep keys dense. */
export interface TimeBucket {
  unixMinute: number;
  count: number;
}

/** A named time series — one line/area on a chart. `points` are ascending by
 *  `unixMinute` (the aggregation helpers guarantee the order). */
export interface Series {
  label: string;
  points: TimeBucket[];
}

// ─── Trust mix ─────────────────────────────────────────────────────────────────

/** The distribution of a metric across trust tiers (counts per tier). Every tier key is
 *  present (the aggregation helpers zero-fill) so a stacked bar never has holes. */
export type TrustMix = Record<TrustTier, number>;

// ─── Aggregate metric ────────────────────────────────────────────────────────────

/** The headline impression aggregate for a window (creator card / admin tile). */
export interface ImpressionMetrics {
  /** Total impression events in the window (raw, includes botty tiers). */
  total: number;
  /** Distinct principals that produced an impression (deduped upstream). */
  unique: number;
  /** Impression count split across trust tiers. */
  byTier: TrustMix;
  /** Per-series time breakdown (e.g. one series per event type, or per tier). */
  series: Series[];
  /** Fraction (0..1) of impressions attributed to botty tiers — `botPct(byTier)`. */
  bot_pct: number;
}

// ─── Creator-analytics read-API wire shapes (greenfield) ─────────────────────────
//
// These mirror the read API the backend `analytics-service §3` rollup will serve. Kept
// JSON-serializable + snake_case on the wire fields the backend owns, camelCase on the
// nested domain objects already defined above (Series/TrustMix). A creator dashboard
// fetches a `CreatorOverview`; a per-item drill fetches `VideoMetrics` / `LiveMetrics`.

/** A traffic source attribution row (where impressions came from). */
export interface SourceBreakdown {
  /** e.g. 'feed' | 'search' | 'profile' | 'share' | 'live' | 'external'. Free-form so
   *  the backend can add sources without a shared-lib bump. */
  source: string;
  impressions: number;
  views: number;
}

/** A geo split row (country-level; `/24`-truncated + MaxMind-enriched upstream). */
export interface GeoBreakdown {
  /** ISO-3166 alpha-2 (e.g. 'ET'), or 'XX' when geo is unknown. */
  country: string;
  impressions: number;
  views: number;
  unique_viewers: number;
}

/** The window a metric covers (epoch seconds, inclusive-from / exclusive-to). */
export interface MetricWindow {
  from_unix: number;
  to_unix: number;
  /** The bucket granularity these series were rolled up at, in seconds (e.g. 60). */
  bucket_seconds: number;
}

/** The creator-dashboard headline rollup across all of a creator's content. */
export interface CreatorOverview {
  creator_id: string;
  window: MetricWindow;
  impressions: number;
  views: number;
  unique_viewers: number;
  /** Total watch time across the window, in seconds. */
  watch_time_seconds: number;
  /** Trust split of impressions (drives the bot-quality gauge). */
  trust_mix: TrustMix;
  bot_pct: number;
  /** Impression trend over the window (typically one series: 'impressions'). */
  trend: Series[];
  top_sources: SourceBreakdown[];
  geo_split: GeoBreakdown[];
}

/** Per-video metrics (one feed item drill-down). */
export interface VideoMetrics {
  video_id: string;
  creator_id: string;
  window: MetricWindow;
  impressions: number;
  views: number;
  unique_viewers: number;
  watch_time_seconds: number;
  /** Mean completion fraction (0..1) of a qualified view. */
  avg_watch_ratio: number;
  likes: number;
  comments: number;
  shares: number;
  trust_mix: TrustMix;
  bot_pct: number;
  /** Impression + view series over the window. */
  series: Series[];
  top_sources: SourceBreakdown[];
  geo_split: GeoBreakdown[];
}

/** Per-live-session metrics (a finished or in-progress stream). */
export interface LiveMetrics {
  room_id: string;
  creator_id: string;
  window: MetricWindow;
  /** Peak concurrent viewers during the session. */
  peak_concurrent: number;
  /** Distinct accounts that joined at any point. */
  unique_viewers: number;
  /** Sum of every viewer's connected time, in seconds. */
  total_watch_time_seconds: number;
  joins: number;
  leaves: number;
  gifts: number;
  /** Coins gifted during the session (creator-share, pre-platform-cut display value). */
  gift_coins: number;
  comments: number;
  trust_mix: TrustMix;
  bot_pct: number;
  /** Concurrent-viewer ('concurrency') + watch-pulse series over the session. */
  series: Series[];
  geo_split: GeoBreakdown[];
}
