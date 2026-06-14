// Unit tests for the DOC VIEWPORT zoom/pan math (zoom-at-cursor, clamp scale,
// clamp pan, reset-to-fit). Same inline assert harness as the sibling tests; runs
// under Node's native TS type-stripping:
//     node --experimental-strip-types test/docViewport.test.ts
// Exits non-zero on the first failure so it's CI-able without a test dependency.

import {
  fitViewport,
  clampPan,
  panBy,
  zoomAtPoint,
  zoomByFactor,
  DOC_ARROW_PAN_FRACTION,
  DOC_MIN_ZOOM,
  DOC_MAX_ZOOM,
  type DocViewport,
  type ViewportSize,
} from '../src/streaming/docViewport.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function close(actual: number, expected: number, name: string, eps = 1e-6): void {
  ok(Math.abs(actual - expected) <= eps, `${name} (got ${actual}, want ${expected})`);
}

const C: ViewportSize = { width: 400, height: 800 };
const fit = fitViewport();

// ── fit / clamp scale ────────────────────────────────────────────────────────
close(fit.scale, DOC_MIN_ZOOM, 'fit is min zoom');
close(fit.panX, 0, 'fit panX 0');
close(fit.panY, 0, 'fit panY 0');
ok(zoomAtPoint(fit, 99, { x: 0, y: 0 }, C).scale === DOC_MAX_ZOOM, 'scale clamps to MAX');
ok(zoomAtPoint({ ...fit, scale: 2 }, -5, { x: 0, y: 0 }, C).scale === DOC_MIN_ZOOM, 'scale clamps to MIN');

// ── zoom-at-point keeps the focal content point fixed ────────────────────────
// Zoom toward the top-left corner; that screen point must map to the SAME content
// point before and after. With centre-origin transform the invariant is
//   (focus - centre - pan) / scale  is constant across the zoom.
function contentAtFocus(vp: DocViewport, fx: number, fy: number): { x: number; y: number } {
  return { x: (fx - C.width / 2 - vp.panX) / vp.scale, y: (fy - C.height / 2 - vp.panY) / vp.scale };
}
{
  const focus = { x: 40, y: 60 };
  const before = contentAtFocus(fit, focus.x, focus.y);
  const after = zoomAtPoint(fit, 3, focus, C);
  const afterContent = contentAtFocus(after, focus.x, focus.y);
  close(afterContent.x, before.x, 'zoom-at-cursor holds content X under cursor');
  close(afterContent.y, before.y, 'zoom-at-cursor holds content Y under cursor');
  close(after.scale, 3, 'zoom-at-cursor applied target scale');
}

// ── pan clamp: bound is half the overflow per axis; scale 1 ⇒ no pan ──────────
ok(clampPan({ scale: 1, panX: 999, panY: -999 }, C).panX === 0, 'no pan at scale 1 (X)');
ok(clampPan({ scale: 1, panX: 999, panY: -999 }, C).panY === 0, 'no pan at scale 1 (Y)');
{
  // scale 2: overflow = (2-1)*size, half each way → bound = size/2.
  const boundX = C.width / 2; // 200
  const boundY = C.height / 2; // 400
  ok(clampPan({ scale: 2, panX: 1000, panY: 1000 }, C).panX === boundX, 'panX clamps to +bound');
  ok(clampPan({ scale: 2, panX: -1000, panY: -1000 }, C).panY === -boundY, 'panY clamps to -bound');
  ok(clampPan({ scale: 2, panX: 50, panY: -30 }, C).panX === 50, 'in-bounds pan passes through');
}

// ── panBy steps + re-clamps ──────────────────────────────────────────────────
{
  const z = { scale: 2, panX: 0, panY: 0 };
  close(panBy(z, 30, -20, C).panX, 30, 'panBy adds dx');
  close(panBy(z, 30, -20, C).panY, -20, 'panBy adds dy');
  // A huge step is held at the bound, not past it.
  ok(panBy(z, 99999, 0, C).panX === C.width / 2, 'panBy re-clamps to bound');
}

// ── zoomByFactor zooms about the centre (centre content point fixed) ──────────
{
  const out = zoomByFactor(fit, 2, C);
  close(out.scale, 2, 'zoomByFactor applies factor');
  // Focus = centre ⇒ pan stays 0 (centre content point is the fixed point).
  close(out.panX, 0, 'centre zoom leaves panX 0');
  close(out.panY, 0, 'centre zoom leaves panY 0');
}

// ── arrow-pan fraction is sane ───────────────────────────────────────────────
ok(DOC_ARROW_PAN_FRACTION > 0 && DOC_ARROW_PAN_FRACTION < 0.5, 'arrow-pan fraction in (0,0.5)');

if (failures.length) {
  console.error(`docViewport: ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`docViewport: ${passed} passed`);
