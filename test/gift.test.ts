// Unit tests for the GIFT overlay kind (Contract v2.4 / kinds/gift) — the append-only,
// id-deduped, capped toast feed and its end-to-end wire path. The gift MODULE itself is
// registry-enforced (kinds/gift.ts); these tests prove the VIEWER fold + the consume
// route + the `foldEvent` ingest converge a remote `overlay.gift` toast into the
// converged `ViewerState.gifts` feed exactly the way a viewer paints it.
//
// Asserts:
//   1. FOLD APPENDS — `applyGiftMsg` grows the feed by one (seq bumps; toast lands last).
//   2. IDEMPOTENT BY ID — re-folding the SAME toast id is a no-op (SAME state ref; the
//      render-brain coalesces to zero re-renders).
//   3. CAP at GIFT_FEED_CAP — past the cap the feed keeps only the most-recent CAP toasts
//      (an append-only log can't grow unbounded).
//   4. CONSUME ROUTE — `decodeOverlayChannelMsg` classifies gift bytes as `overlay.gift`
//      (and a foreign payload does NOT), and `encodeGiftMsg`/`decodeGiftMsg` round-trip.
//   5. INGEST PARITY — `foldEvent` routes an `overlay.gift` event through `applyGiftMsg`
//      (the same fold a LwwSyncSource runs), so web + mobile converge identically.
//   6. EMPTY SENTINEL — an empty-id toast (the module's late-joiner snapshot of an empty
//      feed) folds to a no-op (SAME ref).
//
// Runs under Node's native TS type-stripping (same harness as the sibling tests):
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/gift.test.ts

import {
  initialViewerState,
  applyGiftMsg,
  giftFeed,
} from '../src/streaming/viewer.ts';
import { foldEvent } from '../src/streaming/syncSource.ts';
import {
  decodeOverlayChannelMsg,
  encodeGiftMsg,
  decodeGiftMsg,
} from '../src/overlays/consume.ts';
import { emptyGiftFeed } from '../src/overlays/module.ts';
import { GIFT_FEED_CAP, GIFT_WIRE_VERSION } from '../src/overlays/kinds/gift.ts';
import type { GiftDeltaMsg, GiftToast } from '../src/overlays/module.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

const toast = (n: number): GiftToast => ({ id: `g-${n}`, from: `user${n}`, giftId: 'rose', atUnix: 1000 + n });
const giftMsg = (t: GiftToast): GiftDeltaMsg => ({ t: 'overlay.gift', v: GIFT_WIRE_VERSION, toast: t });

// ── 1. FOLD APPENDS ─────────────────────────────────────────────────────────────
{
  let st = initialViewerState();
  eq(st.gifts, emptyGiftFeed(), 'a fresh viewer starts with an empty gift feed');
  st = applyGiftMsg(st, giftMsg(toast(0)));
  st = applyGiftMsg(st, giftMsg(toast(1)));
  eq(giftFeed(st).toasts.map((t) => t.id), ['g-0', 'g-1'], 'two distinct toasts append in arrival order');
  eq(giftFeed(st).seq, 2, 'the feed sequence bumps once per appended toast');
}

// ── 2. IDEMPOTENT BY ID ─────────────────────────────────────────────────────────
{
  let st = initialViewerState();
  st = applyGiftMsg(st, giftMsg(toast(0)));
  const before = st;
  const after = applyGiftMsg(st, giftMsg(toast(0))); // same id again
  ok(after === before, 're-folding the SAME toast id returns the SAME state ref (no churn)');
  eq(giftFeed(after).toasts.length, 1, 'a duplicate toast does NOT grow the feed');
}

// ── 3. CAP at GIFT_FEED_CAP ──────────────────────────────────────────────────────
{
  let st = initialViewerState();
  const n = GIFT_FEED_CAP + 25;
  for (let i = 0; i < n; i++) st = applyGiftMsg(st, giftMsg(toast(i)));
  eq(giftFeed(st).toasts.length, GIFT_FEED_CAP, 'the feed is capped at GIFT_FEED_CAP toasts');
  // The MOST RECENT toasts are kept (the oldest are dropped).
  eq(giftFeed(st).toasts[0].id, `g-${n - GIFT_FEED_CAP}`, 'the oldest toasts past the cap are dropped (most-recent kept)');
  eq(giftFeed(st).toasts[GIFT_FEED_CAP - 1].id, `g-${n - 1}`, 'the newest toast is last in the capped window');
}

// ── 4. CONSUME ROUTE + codec round-trip ──────────────────────────────────────────
{
  const t = toast(7);
  const bytes = encodeGiftMsg(giftMsg(t));
  const decoded = decodeGiftMsg(bytes);
  eq(decoded, giftMsg(t), 'encodeGiftMsg → decodeGiftMsg round-trips the toast');

  const ev = decodeOverlayChannelMsg(bytes);
  ok(ev.kind === 'overlay.gift', 'decodeOverlayChannelMsg classifies gift bytes as overlay.gift');
  if (ev.kind === 'overlay.gift') eq(ev.msg.toast.id, 'g-7', 'the classified gift event carries the toast');

  // A foreign payload (a participation envelope) is NOT a gift.
  const foreign = new TextEncoder().encode(JSON.stringify({ t: 'overlay.results', v: 1 }));
  ok(decodeGiftMsg(foreign) === null, 'decodeGiftMsg returns null for a non-gift payload');
  // A malformed gift (missing toast fields) decodes to null.
  const bad = new TextEncoder().encode(JSON.stringify({ t: 'overlay.gift', v: 1, toast: { id: 'x' } }));
  ok(decodeGiftMsg(bad) === null, 'decodeGiftMsg returns null for a malformed toast');
}

// ── 5. INGEST PARITY — foldEvent routes overlay.gift through applyGiftMsg ─────────
{
  let st = initialViewerState();
  st = foldEvent(st, { kind: 'overlay.gift', msg: giftMsg(toast(0)) });
  st = foldEvent(st, { kind: 'overlay.gift', msg: giftMsg(toast(1)) });
  eq(giftFeed(st).toasts.map((t) => t.id), ['g-0', 'g-1'], 'foldEvent ingests overlay.gift into the converged feed');
  // Parity: the same bytes a viewer receives, decoded then folded, land identically.
  const ev = decodeOverlayChannelMsg(encodeGiftMsg(giftMsg(toast(2))));
  st = foldEvent(st, ev);
  eq(giftFeed(st).toasts.length, 3, 'a decoded-from-bytes gift event folds the same as a typed one');
}

// ── 6. EMPTY SENTINEL — an empty-id toast is a no-op ─────────────────────────────
{
  let st = initialViewerState();
  const before = st;
  const after = applyGiftMsg(st, { t: 'overlay.gift', v: 1, toast: { id: '', from: '', giftId: '', atUnix: 0 } });
  ok(after === before, 'an empty-id sentinel toast folds to a no-op (SAME ref)');
}

// ── report ─────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`gift: ${passed} assertions passed`);
