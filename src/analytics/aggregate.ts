// @paxpia/core/analytics — PURE aggregation helpers (WS5 / D6, 2026-06-24).
//
// Side-effect-free reducers that turn raw event/row arrays into the chart-ready shapes in
// ./types.ts. No clock, no I/O, no DOM — `Date.now()` is never read here (the caller
// supplies timestamps), so every function is deterministic and fully unit-testable. Web
// (creator analytics) + admin (monitoring) call the SAME helpers so a number on a creator
// card and the same number on an admin tile are computed identically.

import {
  TRUST_TIERS,
  BOTTY_TIERS,
  type ImpressionEventType,
  type Series,
  type TimeBucket,
  type TrustMix,
  type TrustTier,
} from './types';

/** Seconds in one minute — the bucket granularity for `unixMinute` keys. */
export const SECONDS_PER_MINUTE = 60;

/** Floor a timestamp to its epoch-minute bucket key. Accepts epoch SECONDS or
 *  MILLISECONDS — values that look like ms (≥ 1e12, i.e. after ~2001 in ms) are scaled
 *  down so a caller can pass `Date.now()` OR a Unix-seconds column without an adapter. */
export function toUnixMinute(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  const seconds = ts >= 1e12 ? ts / 1000 : ts;
  return Math.floor(seconds / SECONDS_PER_MINUTE);
}

/**
 * Bucket events into per-minute counts, ascending by minute. PURE — does not mutate the
 * input. Empty minutes are NOT zero-filled (sparse series); callers that need a dense
 * axis can densify at render time. The `type` field is accepted for call-site symmetry
 * with the event shape but every event counts as 1 here (filter upstream for a per-type
 * series, or use `mergeSeries` to combine pre-filtered slices).
 */
export function bucketByMinute(
  events: { ts: number; type: ImpressionEventType }[],
): TimeBucket[] {
  const counts = new Map<number, number>();
  for (const e of events) {
    const key = toUnixMinute(e.ts);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([unixMinute, count]) => ({ unixMinute, count }));
}

/** A fully zero-filled TrustMix (every tier key present at 0). */
export function emptyTrustMix(): TrustMix {
  const mix = {} as TrustMix;
  for (const tier of TRUST_TIERS) mix[tier] = 0;
  return mix;
}

/**
 * Tally rows by their `trust_tier` into a complete TrustMix (all five tier keys present,
 * zero-filled). PURE. Rows with an unrecognized tier are ignored (defensive against a
 * wire value the client doesn't know yet) rather than crashing a dashboard.
 */
export function trustMix(rows: { trust_tier: TrustTier }[]): TrustMix {
  const mix = emptyTrustMix();
  for (const row of rows) {
    if (row.trust_tier in mix) mix[row.trust_tier] += 1;
  }
  return mix;
}

/** Sum of every tier's count in a mix. */
export function trustMixTotal(mix: TrustMix): number {
  let total = 0;
  for (const tier of TRUST_TIERS) total += mix[tier] ?? 0;
  return total;
}

/**
 * The fraction (0..1) of a TrustMix attributed to botty tiers (`suspect` + `adversarial`).
 * Returns 0 for an empty mix (no impressions ⇒ no bots, never NaN). PURE.
 */
export function botPct(mix: TrustMix): number {
  const total = trustMixTotal(mix);
  if (total <= 0) return 0;
  let botty = 0;
  for (const tier of BOTTY_TIERS) botty += mix[tier] ?? 0;
  return botty / total;
}

/**
 * Merge any number of pre-bucketed series-point arrays into ONE ascending series,
 * summing counts that share a `unixMinute`. PURE — inputs are not mutated. Used to fold
 * several per-shard or per-type slices into a single line.
 */
export function mergeSeries(...seriesPoints: TimeBucket[][]): TimeBucket[] {
  const counts = new Map<number, number>();
  for (const points of seriesPoints) {
    for (const p of points) {
      counts.set(p.unixMinute, (counts.get(p.unixMinute) ?? 0) + p.count);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([unixMinute, count]) => ({ unixMinute, count }));
}

/**
 * Build one labelled `Series` per event type from a flat event array — the common case
 * for a multi-series ImpressionTrendChart. Only types that actually occur get a series
 * (no empty lines). Series are ordered by first appearance for a stable legend. PURE.
 */
export function seriesByEventType(
  events: { ts: number; type: ImpressionEventType }[],
): Series[] {
  const byType = new Map<ImpressionEventType, { ts: number; type: ImpressionEventType }[]>();
  for (const e of events) {
    const arr = byType.get(e.type);
    if (arr) arr.push(e);
    else byType.set(e.type, [e]);
  }
  const out: Series[] = [];
  for (const [type, evs] of byType) {
    out.push({ label: type, points: bucketByMinute(evs) });
  }
  return out;
}

/** Sum every count across a series' points (the series total). PURE. */
export function seriesTotal(series: Series): number {
  let total = 0;
  for (const p of series.points) total += p.count;
  return total;
}
