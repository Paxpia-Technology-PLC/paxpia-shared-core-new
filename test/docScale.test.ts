// Unit tests for the SINGLE-PAGE PDF FIT SCALE (docScale.ts). Same inline assert
// harness as the sibling tests; runs under Node's native TS type-stripping:
//     node --experimental-strip-types test/docScale.test.ts
// Exits non-zero on the first failure so it's CI-able without a test dependency.
//
// The load-bearing test here is the LAST one. Two of the three consumers inject
// the scale into a WebView document as TEXT, so the expression exists twice — as
// `fitScaleToFrame` and as `FIT_SCALE_TO_FRAME_JS`. Hermes drops function source,
// so the text cannot be derived from the function at runtime (see docScale.ts).
// This evaluates the injected source and asserts the two agree, including on the
// pathological aspect ratios the bound exists for. Edit one without the other and
// this fails.

import {
  fitScaleToFrame,
  FIT_SCALE_TO_FRAME_JS,
  FIT_SCALE_TO_FRAME_FN,
  type PdfPageSize,
} from '../src/streaming/docScale.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function close(actual: number, expected: number, name: string, eps = 1e-9): void {
  ok(Math.abs(actual - expected) <= eps, `${name} (got ${actual}, want ${expected})`);
}

// A 430pt-wide phone at dpr 3 — the frame the bound was verified against.
const FW = 430, FH = 763, DPR = 3;

// ── the common cases are UNCHANGED by binding the second axis ────────────────
// This is the promise the original comment makes: width stays the binding
// constraint for real material, so nothing renders at a new resolution.
{
  const deck: PdfPageSize = { width: 1280, height: 720 };      // 16:9 slide
  close(fitScaleToFrame(deck, FW, FH, DPR), (FW / 1280) * DPR, '16:9 deck still binds on width');

  const a4: PdfPageSize = { width: 595, height: 842 };          // A4 portrait
  close(fitScaleToFrame(a4, FW, FH, DPR), (FW / 595) * DPR, 'A4 portrait still binds on width');
}

// ── the pathological case is BOUNDED ─────────────────────────────────────────
{
  // A 20:1 stitched scan. Width-only would give a canvas 1290 × ~25,800 px —
  // past every mobile canvas ceiling. Height must bind instead.
  const scroll: PdfPageSize = { width: 100, height: 2000 };
  const s = fitScaleToFrame(scroll, FW, FH, DPR);
  close(s, (FH / 2000) * DPR, '20:1 scan binds on height');
  ok(s < (FW / 100) * DPR, '20:1 scan scales BELOW the width-only scale');

  // The resulting backing store is at most one frame of pixels on each axis.
  ok(scroll.width * s <= FW * DPR + 1e-9, 'bounded canvas width');
  ok(scroll.height * s <= FH * DPR + 1e-9, 'bounded canvas height');
}
{
  // A0 poster, landscape (3370 × 2384 pt). Width binds, but the point is that the
  // canvas is frame-bounded on BOTH axes whichever one wins.
  const a0: PdfPageSize = { width: 3370, height: 2384 };
  const s = fitScaleToFrame(a0, FW, FH, DPR);
  ok(a0.width * s <= FW * DPR + 1e-9, 'A0 bounded canvas width');
  ok(a0.height * s <= FH * DPR + 1e-9, 'A0 bounded canvas height');
}

// ── dpr is a straight multiplier ─────────────────────────────────────────────
{
  const p: PdfPageSize = { width: 800, height: 600 };
  close(fitScaleToFrame(p, FW, FH, 2), fitScaleToFrame(p, FW, FH, 1) * 2, 'dpr multiplies');
}

// ── the INJECTED JS agrees with the function, expression for expression ──────
{
  const evaluated = new Function(
    `${FIT_SCALE_TO_FRAME_JS}; return ${FIT_SCALE_TO_FRAME_FN};`,
  )() as typeof fitScaleToFrame;

  const table: Array<[PdfPageSize, number, number, number]> = [
    [{ width: 1280, height: 720 }, FW, FH, DPR],     // deck
    [{ width: 595, height: 842 }, FW, FH, DPR],      // A4
    [{ width: 100, height: 2000 }, FW, FH, DPR],     // 20:1 scan
    [{ width: 2000, height: 100 }, FW, FH, DPR],     // 1:20 banner
    [{ width: 3370, height: 2384 }, FW, FH, DPR],    // A0
    [{ width: 612, height: 792 }, 1024, 768, 1],     // desktop iframe, dpr 1
    [{ width: 1, height: 1 }, FW, FH, DPR],          // degenerate but finite
  ];
  let agreed = 0;
  for (const [base, fw, fh, dpr] of table) {
    if (evaluated(base, fw, fh, dpr) === fitScaleToFrame(base, fw, fh, dpr)) agreed++;
  }
  ok(agreed === table.length, `injected JS matches the TS fn (${agreed}/${table.length})`);
  ok(FIT_SCALE_TO_FRAME_JS.includes(FIT_SCALE_TO_FRAME_FN), 'injected JS defines the documented name');
}

if (failures.length) {
  console.error(`docScale: ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`docScale: ${passed} passed`);
