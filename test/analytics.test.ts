// Unit tests for @paxpia/core/analytics — the impression-metric aggregation helpers
// (WS5 / D6, 2026-06-24). Pure reducers, no platform deps, no clock. Same harness as the
// sibling tests:
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/analytics.test.ts
//
// Asserts: minute-bucketing (sec + ms inputs, ascending, summed, sparse) · toUnixMinute
// scaling + guards · trustMix zero-fill + unknown-tier ignore · botPct (empty → 0, no NaN,
// botty = suspect+adversarial) · mergeSeries fold + sort · seriesByEventType split ·
// seriesTotal · the tier-order/event-type constants are stable.

import {
  TRUST_TIERS,
  BOTTY_TIERS,
  IMPRESSION_EVENT_TYPES,
} from '../src/analytics/types.ts';
import {
  toUnixMinute,
  bucketByMinute,
  emptyTrustMix,
  trustMix,
  trustMixTotal,
  botPct,
  mergeSeries,
  seriesByEventType,
  seriesTotal,
  SECONDS_PER_MINUTE,
} from '../src/analytics/aggregate.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}
function close(actual: number, expected: number, name: string): void {
  ok(Math.abs(actual - expected) < 1e-9, `${name} (got ${actual})`);
}

// ── 1. CONSTANTS ─────────────────────────────────────────────────────────────────
{
  eq([...TRUST_TIERS], ['verified', 'normal', 'low', 'suspect', 'adversarial'], 'tier order is best→worst');
  eq([...BOTTY_TIERS], ['suspect', 'adversarial'], 'botty tiers = suspect + adversarial');
  ok(IMPRESSION_EVENT_TYPES.length === 10, 'ten event types');
  ok(IMPRESSION_EVENT_TYPES.includes('watch_pulse'), 'watch_pulse is an event type');
  ok(SECONDS_PER_MINUTE === 60, 'a minute is 60 seconds');
}

// ── 2. toUnixMinute (sec/ms scaling + guards) ──────────────────────────────────────
{
  eq(toUnixMinute(120), 2, '120s → minute 2');
  eq(toUnixMinute(0), 0, 'epoch 0 → minute 0');
  eq(toUnixMinute(-5), 0, 'a negative ts is guarded to 0');
  eq(toUnixMinute(NaN), 0, 'NaN is guarded to 0');
  // 1_700_000_000 s == 1_700_000_000_000 ms → same minute bucket (ms auto-scaled).
  eq(toUnixMinute(1_700_000_000), toUnixMinute(1_700_000_000_000), 'sec and ms of the same instant bucket equally');
  eq(toUnixMinute(1_700_000_000), Math.floor(1_700_000_000 / 60), 'seconds floored to the minute');
}

// ── 3. bucketByMinute (ascending, summed, sparse, pure) ────────────────────────────
{
  const events = [
    { ts: 60, type: 'impression' as const },   // minute 1
    { ts: 119, type: 'view' as const },        // minute 1
    { ts: 120, type: 'impression' as const },  // minute 2
    { ts: 305, type: 'like' as const },        // minute 5
  ];
  const frozen = JSON.stringify(events);
  const buckets = bucketByMinute(events);
  eq(buckets, [
    { unixMinute: 1, count: 2 },
    { unixMinute: 2, count: 1 },
    { unixMinute: 5, count: 1 },
  ], 'events grouped per minute, ascending, summed, sparse (no empty minutes 3/4)');
  eq(JSON.stringify(events), frozen, 'bucketByMinute is PURE — input not mutated');
  eq(bucketByMinute([]), [], 'no events → empty series');
}

// ── 4. trustMix (zero-fill, unknown ignore, total) ─────────────────────────────────
{
  const mix = trustMix([
    { trust_tier: 'verified' },
    { trust_tier: 'verified' },
    { trust_tier: 'normal' },
    { trust_tier: 'adversarial' },
    // an unrecognized wire value must be ignored, not crash:
    { trust_tier: 'martian' as never },
  ]);
  eq(mix, { verified: 2, normal: 1, low: 0, suspect: 0, adversarial: 1 }, 'rows tallied; every tier key present (zero-filled); unknown ignored');
  eq(trustMixTotal(mix), 4, 'total counts only the known tiers');
  eq(emptyTrustMix(), { verified: 0, normal: 0, low: 0, suspect: 0, adversarial: 0 }, 'emptyTrustMix is fully zero-filled');
  eq(trustMix([]), emptyTrustMix(), 'no rows → a zeroed mix (not {})');
}

// ── 5. botPct (empty → 0, botty fraction, no NaN) ──────────────────────────────────
{
  close(botPct(emptyTrustMix()), 0, 'an empty mix has 0 bot fraction (no NaN)');
  const mix = { verified: 6, normal: 2, low: 0, suspect: 1, adversarial: 1 }; // 10 total, 2 botty
  close(botPct(mix), 0.2, 'botPct = (suspect+adversarial)/total');
  const allBot = { verified: 0, normal: 0, low: 0, suspect: 3, adversarial: 1 };
  close(botPct(allBot), 1, 'all-botty mix → 1.0');
}

// ── 6. mergeSeries (fold + sort) ───────────────────────────────────────────────────
{
  const a = [{ unixMinute: 2, count: 1 }, { unixMinute: 5, count: 3 }];
  const b = [{ unixMinute: 5, count: 2 }, { unixMinute: 1, count: 4 }];
  eq(mergeSeries(a, b), [
    { unixMinute: 1, count: 4 },
    { unixMinute: 2, count: 1 },
    { unixMinute: 5, count: 5 },
  ], 'series merged: shared minutes summed, result ascending');
  eq(mergeSeries(), [], 'no inputs → empty');
  eq(mergeSeries(a), a, 'a single series passes through (sorted)');
}

// ── 7. seriesByEventType (per-type split) ──────────────────────────────────────────
{
  const series = seriesByEventType([
    { ts: 60, type: 'impression' },
    { ts: 90, type: 'impression' },
    { ts: 65, type: 'view' },
  ]);
  ok(series.length === 2, 'one series per occurring event type');
  const imp = series.find((s) => s.label === 'impression')!;
  eq(imp.points, [{ unixMinute: 1, count: 2 }], 'the impression series bucketed correctly');
  ok(series.every((s) => s.points.length > 0), 'no empty series produced');
}

// ── 8. seriesTotal ─────────────────────────────────────────────────────────────────
{
  eq(seriesTotal({ label: 'x', points: [{ unixMinute: 1, count: 2 }, { unixMinute: 2, count: 5 }] }), 7, 'seriesTotal sums every point');
  eq(seriesTotal({ label: 'empty', points: [] }), 0, 'an empty series totals 0');
}

// ── report ───────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`analytics: ${passed} assertions passed`);
