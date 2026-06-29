// Unit tests for the CANONICAL scene→output placement math (WI-17) — the shared
// `composeScene`/`sceneNeedsComposite`/`isFullFrameRect`/`tileDraw` in
// `src/compositor/layout.ts`. Asserts:
//   • media items (camera/screen only) are placed in z-ascending draw order; overlay/
//     doc/whiteboard items are excluded (composed on the viewer, not baked).
//   • each tile's `dest` is the shared `rectToPixels` projection against the output.
//   • `sceneNeedsComposite` is true for >1 media tile, a single NON-full-frame tile,
//     or a single full-frame CONTAIN (letterbox) tile; false for a single full-frame
//     COVER camera (raw passthrough is the correct composite) + an empty scene.
//   • `tileDraw` letterboxes (contain) / crops (cover) inside `dest` via `fitToBox`.
//
//     node --experimental-strip-types test/compositorLayout.test.ts

import {
  composeScene,
  sceneNeedsComposite,
  isFullFrameRect,
  mediaItemsInDrawOrder,
  tileDraw,
  defaultCompositeOutput,
} from '../src/compositor/layout.ts';
import { makeItem, makeScene } from '../src/layout/factory.ts';
import type { Scene } from '../src/layout/types.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
const approx = (a: number, b: number, eps = 0.5): boolean => Math.abs(a - b) <= eps;

const OUT = { w: 720, h: 1280 };

// A scene with ONE full-frame cover camera (the default first-source placement).
function fullFrameScene(): Scene {
  const s = makeScene('s1', 'Solo');
  s.items = [makeItem('cam', 'camera', 0)]; // defaultRect(0) = {0,0,1,1}, cover
  return s;
}

// ── isFullFrameRect ───────────────────────────────────────────────────────────
{
  ok(isFullFrameRect({ x: 0, y: 0, w: 1, h: 1 }), 'full frame rect → true');
  ok(isFullFrameRect({ x: 0.0005, y: 0, w: 0.9999, h: 1 }), 'within eps → true');
  ok(!isFullFrameRect({ x: 0.1, y: 0.1, w: 0.4, h: 0.3 }), 'PiP rect → false');
  ok(!isFullFrameRect({ x: 0, y: 0, w: 0.5, h: 1 }), 'half-width → false');
}

// ── defaultCompositeOutput is 9:16 ────────────────────────────────────────────
{
  const o = defaultCompositeOutput();
  ok(o.h === 1280 && o.w === 720, `default output is 720x1280 (got ${o.w}x${o.h})`);
}

// ── composeScene: order + media filtering + dest projection ───────────────────
{
  const s = makeScene('s2', 'Multi');
  // Add a doc (excluded), a background camera (z low), a PiP screen (z high).
  const cam = makeItem('cam', 'camera', 0); // {0,0,1,1} z0
  const doc = makeItem('doc', 'doc', 1); // excluded from media
  const pip = makeItem('pip', 'screen', 2, { rect: { x: 0.6, y: 0.05, w: 0.35, h: 0.25 } });
  // Shuffle z so we prove sorting: give pip z=2, cam z=0, doc z=1.
  s.items = [pip, doc, cam];

  const plan = composeScene(s, OUT);
  ok(plan.tiles.length === 2, `composeScene drops non-media (2 media tiles, got ${plan.tiles.length})`);
  ok(plan.tiles[0].item.id === 'cam', 'draw order: lowest-z camera first');
  ok(plan.tiles[1].item.id === 'pip', 'draw order: higher-z screen second');
  ok(plan.primary?.item.id === 'cam', 'primary = lowest-z media tile');

  // dest of the full-frame camera = whole output.
  const camDest = plan.tiles[0].dest;
  ok(camDest.x === 0 && camDest.y === 0 && camDest.w === 720 && camDest.h === 1280, 'cam dest = full output');
  // dest of the PiP = rectToPixels({0.6,0.05,0.35,0.25}).
  const pipDest = plan.tiles[1].dest;
  ok(
    approx(pipDest.x, 0.6 * 720) && approx(pipDest.y, 0.05 * 1280) && approx(pipDest.w, 0.35 * 720) && approx(pipDest.h, 0.25 * 1280),
    'pip dest = rectToPixels(authored rect)',
  );
  ok(plan.needsComposite === true, 'scene with >1 media tile needs composite');
}

// ── mediaItemsInDrawOrder excludes overlays ───────────────────────────────────
{
  const s = makeScene('s3', 'Overlays');
  s.items = [makeItem('cam', 'camera', 0), makeItem('q', 'overlay', 1), makeItem('wb', 'whiteboard', 2)];
  const media = mediaItemsInDrawOrder(s);
  ok(media.length === 1 && media[0].id === 'cam', 'mediaItemsInDrawOrder keeps only camera/screen');
}

// ── sceneNeedsComposite: the WI-17 decision ───────────────────────────────────
{
  ok(sceneNeedsComposite(undefined) === false, 'undefined scene → no composite');
  ok(sceneNeedsComposite(makeScene('e', 'Empty')) === false, 'empty scene → no composite');

  // Single full-frame COVER camera → passthrough is correct → NO composite.
  ok(sceneNeedsComposite(fullFrameScene()) === false, 'single full-frame cover camera → passthrough (no composite)');

  // Single PLACED (PiP) camera → must composite at its rect (the WI-17 fix).
  const placed = makeScene('p', 'Placed');
  placed.items = [makeItem('cam', 'camera', 0, { rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.4 } })];
  ok(sceneNeedsComposite(placed) === true, 'single PLACED camera → needs composite (WI-17)');

  // Single full-frame CONTAIN camera → letterbox can't be done by raw passthrough → composite.
  const letter = makeScene('l', 'Letterbox');
  letter.items = [makeItem('cam', 'camera', 0, { fit: 'contain' })];
  ok(sceneNeedsComposite(letter) === true, 'single full-frame CONTAIN camera → needs composite');
}

// ── tileDraw: contain letterboxes, cover crops, inside dest ───────────────────
{
  const s = fullFrameScene();
  const plan = composeScene(s, OUT);
  const tile = plan.tiles[0]; // full-frame cover
  // A 16:9 landscape source (1920x1080) into a 9:16 cover box → drawn larger than dest
  // (crops sides), centered.
  const cover = tileDraw(tile, { w: 1920, h: 1080 });
  ok(cover.clip.w === 720 && cover.clip.h === 1280, 'cover clip = dest box');
  ok(cover.draw.w >= 720 && cover.draw.h >= 1280, 'cover draw fills/overflows dest (crop)');

  // Same source with contain → fits entirely inside (letterbox bars), draw ≤ dest.
  const containItem = { ...tile, fit: 'contain' as const, cover: false };
  const contain = tileDraw(containItem, { w: 1920, h: 1080 });
  ok(contain.draw.w <= 720 + 0.5 && contain.draw.h <= 1280 + 0.5, 'contain draw fits inside dest (letterbox)');
  ok(approx(contain.draw.w, 720), 'contain landscape → width-limited (full box width)');
}

// ── report ────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`compositorLayout: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`compositorLayout: ${passed} passed`);
