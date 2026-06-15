// Unit tests for the SVG OVERLAY wire + reducer (the new overlay kind on the
// shared `overlay` topic): decode (round-trip + rejection of malformed/oversized/
// foreign), the TTL expiry pruner, and the id-replace semantics.
//
// Runs under Node's native TS type-stripping (same harness as chat.test.ts):
//     node --experimental-strip-types test/svgOverlay.test.ts

import {
  encodeSvgOverlayMsg,
  decodeSvgOverlayMsg,
  emptySvgOverlays,
  setSvgOverlay,
  deleteSvgOverlay,
  pruneExpiredSvgOverlays,
  liveSvgOverlays,
  SVG_OVERLAY_WIRE_VERSION,
  SVG_OVERLAY_DEFAULT_TTL_MS,
  SVG_OVERLAY_MAX_BYTES,
  type SvgOverlaySetMsg,
  type SvgOverlayDeleteMsg,
} from '../src/overlays/svg.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

const SVG = '<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="red"/></svg>';

// ── decode: SET + DELETE round-trip through encode/decode ────────────────────
{
  const set: SvgOverlaySetMsg = { t: 'overlay.svg', v: SVG_OVERLAY_WIRE_VERSION, id: 'a', svg: SVG, ttlMs: 5000 };
  eq(decodeSvgOverlayMsg(encodeSvgOverlayMsg(set)), set, 'SET round-trips through encode/decode (utf-8)');

  const del: SvgOverlayDeleteMsg = { t: 'overlay.svg.delete', v: SVG_OVERLAY_WIRE_VERSION, id: 'a' };
  eq(decodeSvgOverlayMsg(encodeSvgOverlayMsg(del)), del, 'DELETE round-trips through encode/decode');

  // ttlMs omitted on the wire stays undefined on the decoded SET (default applied at reduce time).
  const noTtl = decodeSvgOverlayMsg(encodeSvgOverlayMsg({ t: 'overlay.svg', v: 1, id: 'b', svg: SVG }));
  ok(noTtl?.t === 'overlay.svg' && (noTtl as SvgOverlaySetMsg).ttlMs === undefined, 'absent ttlMs decodes to undefined');
}

// ── decode: malformed / foreign / oversized → null (never reaches the DOM) ────
{
  ok(decodeSvgOverlayMsg(new TextEncoder().encode('not json')) === null, 'garbage decodes to null');
  ok(decodeSvgOverlayMsg(new TextEncoder().encode('{"t":"overlay.changed"}')) === null, 'participation envelope → null');
  ok(decodeSvgOverlayMsg(new TextEncoder().encode('{"t":"overlay.svg","id":""}')) === null, 'empty id → null');
  ok(decodeSvgOverlayMsg(new TextEncoder().encode('{"t":"overlay.svg","id":"a"}')) === null, 'missing svg → null');
  ok(
    decodeSvgOverlayMsg(new TextEncoder().encode('{"t":"overlay.svg.delete"}')) === null,
    'delete with no id → null',
  );

  // Oversized svg (> the reliable-packet cap) is rejected at decode.
  const huge = '<svg>' + 'x'.repeat(SVG_OVERLAY_MAX_BYTES) + '</svg>';
  const overMsg: SvgOverlaySetMsg = { t: 'overlay.svg', v: 1, id: 'big', svg: huge };
  ok(decodeSvgOverlayMsg(encodeSvgOverlayMsg(overMsg)) === null, 'oversized svg decodes to null (cap enforced)');
}

// ── reducer: set, default-ttl, id-replace ────────────────────────────────────
{
  let s = emptySvgOverlays();
  s = setSvgOverlay(s, { t: 'overlay.svg', v: 1, id: 'x', svg: SVG, ttlMs: 1000 }, 100);
  eq(s['x'].expiresAtMs, 1100, 'expiry = receivedAt + ttlMs');
  eq(s['x'].svg, SVG, 'svg stored raw');

  // absent ttl → default ttl applied at reduce time
  let d = setSvgOverlay(emptySvgOverlays(), { t: 'overlay.svg', v: 1, id: 'y', svg: SVG }, 0);
  eq(d['y'].expiresAtMs, SVG_OVERLAY_DEFAULT_TTL_MS, 'absent ttl uses the default');

  // id-REPLACE: same id re-sent swaps the svg AND refreshes the expiry
  const SVG2 = '<svg viewBox="0 0 10 10"><circle r="5"/></svg>';
  s = setSvgOverlay(s, { t: 'overlay.svg', v: 1, id: 'x', svg: SVG2, ttlMs: 2000 }, 500);
  eq(Object.keys(s), ['x'], 'id-replace keeps a single entry for the id');
  eq(s['x'].svg, SVG2, 'id-replace swaps the svg');
  eq(s['x'].expiresAtMs, 2500, 'id-replace refreshes the expiry');
}

// ── reducer: delete (present + absent) ───────────────────────────────────────
{
  let s = emptySvgOverlays();
  s = setSvgOverlay(s, { t: 'overlay.svg', v: 1, id: 'a', svg: SVG }, 0);
  s = setSvgOverlay(s, { t: 'overlay.svg', v: 1, id: 'b', svg: SVG }, 0);
  s = deleteSvgOverlay(s, 'a');
  eq(Object.keys(s), ['b'], 'delete removes the id');

  const before = s;
  ok(deleteSvgOverlay(s, 'ghost') === before, 'delete of an absent id returns the same ref (no churn)');
}

// ── reducer: TTL expiry pruning ──────────────────────────────────────────────
{
  let s = emptySvgOverlays();
  s = setSvgOverlay(s, { t: 'overlay.svg', v: 1, id: 'short', svg: SVG, ttlMs: 1000 }, 0); // expires at 1000
  s = setSvgOverlay(s, { t: 'overlay.svg', v: 1, id: 'long', svg: SVG, ttlMs: 5000 }, 0); // expires at 5000

  // Before either expires: same ref back (render-free tick).
  ok(pruneExpiredSvgOverlays(s, 500) === s, 'prune before any expiry is a no-op (same ref)');

  // At the short expiry boundary: an entry whose expiry == now is dropped (at/before).
  const afterShort = pruneExpiredSvgOverlays(s, 1000);
  eq(Object.keys(afterShort), ['long'], 'expired-at-boundary entry is pruned, live one remains');

  // After both expire: empty.
  const afterAll = pruneExpiredSvgOverlays(s, 9999);
  eq(Object.keys(afterAll), [], 'all expired → empty');
  eq(liveSvgOverlays(afterAll), [], 'liveSvgOverlays reflects the empty set');
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`svgOverlay: ${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`svgOverlay: ${passed} passed`);
