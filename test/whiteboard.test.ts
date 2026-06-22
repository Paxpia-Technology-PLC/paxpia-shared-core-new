// Unit tests for the WHITEBOARD wire + reducer (the new overlay kind on the SHARED
// `overlay` topic that retires the private paxpia.live.data plane): the gen-aware
// applyWb fold (append/erase/wipe/snapshot + the gen-stale "missed wipe ⇒ fresh"
// discipline), encode/decode round-trip + byte-cap rejection of malformed/oversized/
// foreign, and the consume-ladder routing into `overlay.wb`.
//
// Mirrors test/svgOverlay.test.ts + test/overlayConsume.test.ts. Runs under Node's
// native TS type-stripping (same harness):
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/whiteboard.test.ts

import {
  encodeWbMsg,
  decodeWbMsg,
  emptyBoard,
  applyWb,
  WB_WIRE_VERSION,
  WB_MAX_STROKE_BYTES,
  type WbStroke,
  type WbStrokeMsg,
  type WbEraseMsg,
  type WbWipeMsg,
  type WbSnapshotMsg,
} from '../src/overlays/whiteboard.ts';
import { decodeOverlayChannelMsg } from '../src/overlays/consume.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

const S = (id: string): WbStroke => ({ id, d: `M0 0 L10 ${id.length}`, color: '#fff', width: 3 });
const BID = 'board-1';

// ── encode / decode round-trip (all four envelopes) ──────────────────────────
{
  const stroke: WbStrokeMsg = { t: 'overlay.wb.stroke', v: WB_WIRE_VERSION, boardId: BID, gen: 0, stroke: S('a') };
  eq(decodeWbMsg(encodeWbMsg(stroke)), stroke, 'stroke round-trips through encode/decode (utf-8)');

  const erase: WbEraseMsg = { t: 'overlay.wb.erase', v: WB_WIRE_VERSION, boardId: BID, gen: 0, id: 'a' };
  eq(decodeWbMsg(encodeWbMsg(erase)), erase, 'erase round-trips');

  const wipe: WbWipeMsg = { t: 'overlay.wb.wipe', v: WB_WIRE_VERSION, boardId: BID, gen: 1 };
  eq(decodeWbMsg(encodeWbMsg(wipe)), wipe, 'wipe round-trips');

  const snap: WbSnapshotMsg = {
    t: 'overlay.wb.snapshot', v: WB_WIRE_VERSION, boardId: BID, gen: 2, strokes: [S('a'), S('bb')],
  };
  eq(decodeWbMsg(encodeWbMsg(snap)), snap, 'snapshot round-trips');

  // version stamped when the caller omits it.
  const noV = decodeWbMsg(encodeWbMsg({ t: 'overlay.wb.wipe', boardId: BID, gen: 0 } as unknown as WbWipeMsg));
  ok(noV?.t === 'overlay.wb.wipe' && noV.v === WB_WIRE_VERSION, 'absent v gets the wire version');
}

// ── decode: malformed / foreign / oversized → null (never reaches the DOM) ────
{
  ok(decodeWbMsg(new TextEncoder().encode('not json')) === null, 'garbage → null');
  ok(decodeWbMsg(new TextEncoder().encode('{"t":"overlay.changed"}')) === null, 'participation envelope → null');
  ok(decodeWbMsg(new TextEncoder().encode('{"t":"overlay.svg","id":"a","svg":"x"}')) === null, 'svg envelope → null');
  ok(decodeWbMsg(new TextEncoder().encode('{"t":"overlay.wb.stroke","gen":0,"stroke":{}}')) === null, 'missing boardId → null');
  ok(decodeWbMsg(new TextEncoder().encode('{"t":"overlay.wb.stroke","boardId":"b","stroke":{}}')) === null, 'missing gen → null');
  ok(
    decodeWbMsg(new TextEncoder().encode('{"t":"overlay.wb.stroke","boardId":"b","gen":0,"stroke":{"id":"x"}}')) === null,
    'stroke missing d/color/width → null',
  );
  ok(decodeWbMsg(new TextEncoder().encode('{"t":"overlay.wb.erase","boardId":"b","gen":0}')) === null, 'erase with no id → null');
  // A snapshot with one malformed stroke is rejected wholesale.
  ok(
    decodeWbMsg(new TextEncoder().encode('{"t":"overlay.wb.snapshot","boardId":"b","gen":0,"strokes":[{"id":"x"}]}')) === null,
    'snapshot with a malformed stroke → null',
  );

  // Oversized message (> the reliable-packet cap) is rejected at decode.
  const hugeStroke: WbStrokeMsg = {
    t: 'overlay.wb.stroke', v: 1, boardId: BID, gen: 0,
    stroke: { id: 'big', d: 'M0 0 L' + 'x'.repeat(WB_MAX_STROKE_BYTES), color: '#fff', width: 3 },
  };
  ok(decodeWbMsg(encodeWbMsg(hugeStroke)) === null, 'oversized stroke decodes to null (cap enforced)');
}

// ── reducer: snapshot REPLACES, wipe clears+gen, stroke appends ──────────────
{
  let b = emptyBoard();
  eq(b, { gen: 0, strokes: [] }, 'emptyBoard is gen 0 / no strokes');

  b = applyWb(b, { t: 'overlay.wb.stroke', v: 1, boardId: BID, gen: 0, stroke: S('a') });
  b = applyWb(b, { t: 'overlay.wb.stroke', v: 1, boardId: BID, gen: 0, stroke: S('b') });
  eq(b.strokes.map((s) => s.id), ['a', 'b'], 'strokes append in order');

  // snapshot REPLACES the whole board at its gen.
  b = applyWb(b, { t: 'overlay.wb.snapshot', v: 1, boardId: BID, gen: 0, strokes: [S('x'), S('y'), S('z')] });
  eq(b.strokes.map((s) => s.id), ['x', 'y', 'z'], 'snapshot replaces the board');

  // erase removes by id within the current gen.
  b = applyWb(b, { t: 'overlay.wb.erase', v: 1, boardId: BID, gen: 0, id: 'y' });
  eq(b.strokes.map((s) => s.id), ['x', 'z'], 'erase removes the id');

  // an erase of an absent id is a no-op → SAME ref (no churn).
  const before = b;
  ok(applyWb(b, { t: 'overlay.wb.erase', v: 1, boardId: BID, gen: 0, id: 'ghost' }) === before, 'erase of absent id returns same ref');

  // wipe bumps gen + clears.
  b = applyWb(b, { t: 'overlay.wb.wipe', v: 1, boardId: BID, gen: 1 });
  eq(b, { gen: 1, strokes: [] }, 'wipe bumps gen and clears');
}

// ── reducer: gen-stale discipline (the late-joiner / missed-wipe correctness) ─
{
  // Start at gen 1 with content.
  let b = applyWb(emptyBoard(), { t: 'overlay.wb.snapshot', v: 1, boardId: BID, gen: 1, strokes: [S('a')] });

  // A stroke at a NEWER gen ⇒ we missed a wipe ⇒ start FRESH from that stroke.
  b = applyWb(b, { t: 'overlay.wb.stroke', v: 1, boardId: BID, gen: 2, stroke: S('fresh') });
  eq(b, { gen: 2, strokes: [S('fresh')] }, 'stroke at a newer gen starts fresh (missed wipe)');

  // A stroke at an OLDER gen is stale ⇒ dropped (same ref).
  const cur = b;
  ok(applyWb(b, { t: 'overlay.wb.stroke', v: 1, boardId: BID, gen: 1, stroke: S('old') }) === cur, 'stale older-gen stroke dropped (same ref)');

  // An older-gen snapshot is ignored (we've advanced past it).
  ok(applyWb(b, { t: 'overlay.wb.snapshot', v: 1, boardId: BID, gen: 1, strokes: [S('q')] }) === cur, 'older-gen snapshot ignored');

  // An older-gen wipe is ignored.
  ok(applyWb(b, { t: 'overlay.wb.wipe', v: 1, boardId: BID, gen: 0 }) === cur, 'older-gen wipe ignored');

  // A newer-gen erase implies a missed wipe ⇒ board empty at that gen.
  const erased = applyWb(b, { t: 'overlay.wb.erase', v: 1, boardId: BID, gen: 5, id: 'whatever' });
  eq(erased, { gen: 5, strokes: [] }, 'newer-gen erase ⇒ empty board at that gen');
}

// ── consume routing: each wb envelope classifies to `overlay.wb` ─────────────
{
  const stroke = encodeWbMsg({ t: 'overlay.wb.stroke', v: 1, boardId: BID, gen: 0, stroke: S('a') });
  ok(decodeOverlayChannelMsg(stroke).kind === 'overlay.wb', 'overlay.wb.stroke routes to overlay.wb');

  const erase = encodeWbMsg({ t: 'overlay.wb.erase', v: 1, boardId: BID, gen: 0, id: 'a' });
  ok(decodeOverlayChannelMsg(erase).kind === 'overlay.wb', 'overlay.wb.erase routes to overlay.wb');

  const wipe = encodeWbMsg({ t: 'overlay.wb.wipe', v: 1, boardId: BID, gen: 1 });
  ok(decodeOverlayChannelMsg(wipe).kind === 'overlay.wb', 'overlay.wb.wipe routes to overlay.wb');

  const snap = encodeWbMsg({ t: 'overlay.wb.snapshot', v: 1, boardId: BID, gen: 0, strokes: [S('a')] });
  const ev = decodeOverlayChannelMsg(snap);
  ok(ev.kind === 'overlay.wb', 'overlay.wb.snapshot routes to overlay.wb');
  ok(ev.kind === 'overlay.wb' && ev.msg.t === 'overlay.wb.snapshot', 'routed event carries the decoded msg');

  // a foreign / unknown envelope on the topic still becomes `unsupported`, not `overlay.wb`.
  ok(decodeOverlayChannelMsg(new TextEncoder().encode('{"t":"overlay.future"}')).kind === 'unsupported', 'unknown t stays unsupported');
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`whiteboard: ${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`whiteboard: ${passed} passed`);
