// Unit tests for the COMPILER-ENFORCED overlay lifecycle core (Contract v2.4 — Wave 1
// 1A/1B/1C). Three guarantees:
//   1. REGISTRY EXHAUSTIVENESS — every OverlayKind has a module; every module has every
//      callback (the registry compiling IS the enforcement; this asserts the runtime
//      shape too so a future refactor can't strip a member silently).
//   2. PERSISTENCE SURVIVES a SCENE / DOC / PAGE transition — the keyed view store owns
//      the doc page+transform, so a scene toggle never drops it (Bug 1a, model-level).
//   3. DOC RESYNC SNAPS to the streamer's CURRENT transform — never replays the backlog
//      (Bug 2): onResync reads the converged view, not the events that passed.
//
// Runs under Node's native TS type-stripping (same harness as the sibling tests):
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/overlayModule.test.ts

import {
  OVERLAY_MODULES,
  OVERLAY_KINDS,
  overlayModule,
} from '../src/overlays/registry.ts';
import type { OverlayModule } from '../src/overlays/module.ts';
import { docViewPersistKey } from '../src/streaming/persist.ts';
import { wbViewPersistKey } from '../src/overlays/kinds/whiteboard.ts';
import {
  initialViewerState,
  applyLiveSync,
  applySceneSync,
  viewFor,
} from '../src/streaming/viewer.ts';
import { buildRenderedScene, type RenderedScene } from '../src/streaming/scene.ts';
import type { OverlayKind, OverlayInstance } from '../src/overlays/types.ts';
import type { LiveScene, LiveSyncMsg } from '../src/streaming/live.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

// ── 1. REGISTRY EXHAUSTIVENESS ─────────────────────────────────────────────────
{
  // Every kind the type system knows is in the registry. We assert against an
  // INDEPENDENT literal list so a kind added to the union (and registry) without
  // updating this list fails the test (a behavioural mirror of the compile guard).
  const expectedKinds: OverlayKind[] = [
    'svg',
    'poll',
    'vote-button',
    'quiz',
    'doc',
    'gift',
    'whiteboard',
  ];
  eq([...OVERLAY_KINDS].sort(), [...expectedKinds].sort(), 'registry has exactly every OverlayKind');

  // Every module exposes EVERY required OverlayModule member (no callback omitted).
  const REQUIRED_MEMBERS: (keyof OverlayModule<OverlayKind>)[] = [
    'kind',
    'persistKey',
    'snapshot',
    'applyLocal',
    'capture',
    'applyRemote',
    'merge',
    'gen',
    'onResync',
    'onReconnect',
  ];
  for (const kind of OVERLAY_KINDS) {
    const mod = overlayModule(kind) as unknown as Record<string, unknown>;
    ok(mod.kind === kind, `module(${kind}).kind === ${kind}`);
    for (const m of REQUIRED_MEMBERS) {
      const present = m === 'kind' ? mod[m] !== undefined : typeof mod[m] === 'function';
      ok(present, `module(${kind}).${m} present`);
    }
  }

  // overlayModule is total — resolving any registered kind returns its module.
  for (const kind of OVERLAY_KINDS) {
    ok(overlayModule(kind) === OVERLAY_MODULES[kind], `overlayModule(${kind}) resolves the registry entry`);
  }

  // ResyncSnap is gen-discriminated: transform kinds may snap; others NEVER do (return
  // null). This is the runtime shadow of the `ResyncSnap<K> = {transform} | never`
  // compile guard that makes Bug-2 a type error.
  const store = initialViewerState();
  for (const kind of OVERLAY_KINDS) {
    const snap = overlayModule(kind).onResync(store, docViewPersistKey('x') as never);
    if (kind === 'doc' || kind === 'whiteboard') {
      ok(snap !== null && typeof snap === 'object' && 'transform' in snap, `${kind} onResync returns a transform snap`);
    } else {
      ok(snap === null, `${kind} onResync returns null (no view to snap)`);
    }
  }
}

// ── fixtures for the persistence + resync tests ────────────────────────────────
const docInst = (id: string, page: number): OverlayInstance => ({
  id,
  kind: 'doc',
  phase: 'active',
  gen: 1,
  payload: { title: id, pages: [], page },
});

const sceneWithDoc: LiveScene = {
  id: 'S1',
  name: 'S1',
  items: [{ id: 'd-slot', type: 'doc', rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0, fit: 'contain' }],
};
const sceneNoDoc: LiveScene = {
  id: 'S2',
  name: 'S2',
  items: [{ id: 'ov', type: 'overlay', rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0, fit: 'contain' }],
};
const renderedS1: RenderedScene = buildRenderedScene(sceneWithDoc, 1, () => null);
const renderedS2: RenderedScene = buildRenderedScene(sceneNoDoc, 2, () => null);

const liveSync = (
  doc: OverlayInstance | null,
  scene: LiveScene,
  presenter: { page: number; zoom: number; panX: number; panY: number } | null,
): LiveSyncMsg => ({ t: 'live.sync', v: 1, sceneId: scene.id, scene, doc, docPresenter: presenter });

// ── 2. PERSISTENCE SURVIVES a SCENE / DOC / PAGE transition ────────────────────
{
  let st = initialViewerState();
  const key = docViewPersistKey('d1');

  // The streamer shows doc d1 at page 3, zoomed 2.5x, panned.
  st = applyLiveSync(st, liveSync(docInst('d1', 3), sceneWithDoc, { page: 3, zoom: 2.5, panX: 40, panY: 12 }));
  eq(viewFor(st, key).page, 3, 'doc view persisted: page 3');
  eq(viewFor(st, key).transform.zoom, 2.5, 'doc view persisted: zoom 2.5');
  eq(viewFor(st, key).transform.panX, 40, 'doc view persisted: panX 40');

  // SCENE TRANSITION away to a doc-less scene (scene.sync full-replace + a live.sync
  // that clears the doc slot, mirroring a scene switch). The presented doc goes away…
  st = applySceneSync(st, renderedS2);
  st = applyLiveSync(st, liveSync(null, sceneNoDoc, null));
  // …but the PERSISTED view for d1 MUST still be there (present-not-destroy).
  ok('doc:d1' in st.views, 'persisted view survives the scene switch (not deleted)');
  eq(viewFor(st, key).page, 3, 'doc d1 view STILL page 3 after scene switch');
  eq(viewFor(st, key).transform.zoom, 2.5, 'doc d1 view STILL zoom 2.5 after scene switch');

  // SCENE TRANSITION back + re-serve d1 with NO presenter (a scene-return that re-derives
  // the doc but where the live zoom/pan would otherwise be lost). The persisted view is
  // the source of truth the render-brain re-presents from — it was NOT dropped.
  st = applySceneSync(st, { ...renderedS1, nonce: 3 });
  eq(viewFor(st, key).page, 3, 'doc d1 page+zoom re-presentable on scene return (Bug 1a fixed)');
  eq(viewFor(st, key).transform.zoom, 2.5, 'doc d1 zoom re-presentable on scene return');

  // DOC TRANSITION: serving a DIFFERENT doc d2 keeps d1's entry untouched (keyed per doc).
  st = applyLiveSync(st, liveSync(docInst('d2', 0), sceneWithDoc, { page: 0, zoom: 1, panX: 0, panY: 0 }));
  eq(viewFor(st, docViewPersistKey('d2')).page, 0, 'new doc d2 has its own view');
  eq(viewFor(st, key).transform.zoom, 2.5, 'prior doc d1 view UNCHANGED by a doc switch');

  // PAGE TRANSITION preserves zoom: d2 flips to page 4 at the same broadcast zoom.
  st = applyLiveSync(st, liveSync(docInst('d2', 4), sceneWithDoc, { page: 4, zoom: 1.8, panX: 0, panY: 0 }));
  eq(viewFor(st, docViewPersistKey('d2')).page, 4, 'doc d2 page advanced to 4');
  eq(viewFor(st, docViewPersistKey('d2')).transform.zoom, 1.8, 'doc d2 zoom carried with the page');
}

// ── 3. DOC RESYNC SNAPS to CURRENT (not replay) ────────────────────────────────
{
  // A viewer is "taken over"; meanwhile the streamer flips through pages 1→2→3 and zooms.
  // onResync must read the CURRENT converged view (page 3, zoom 3x) — NOT replay the
  // intermediate 1/2 states. The converged store holds only the latest (LWW), so a snap
  // to getState() can only be the current value: that IS the never-replay guarantee.
  let st = initialViewerState();
  const key = docViewPersistKey('d1');
  st = applyLiveSync(st, liveSync(docInst('d1', 1), sceneWithDoc, { page: 1, zoom: 1, panX: 0, panY: 0 }));
  st = applyLiveSync(st, liveSync(docInst('d1', 2), sceneWithDoc, { page: 2, zoom: 2, panX: 10, panY: 0 }));
  st = applyLiveSync(st, liveSync(docInst('d1', 3), sceneWithDoc, { page: 3, zoom: 3, panX: 20, panY: 5 }));

  const snap = overlayModule('doc').onResync(st, key);
  ok(snap !== null, 'doc onResync returns a snap');
  eq(snap!.transform.page, 3, 'doc resync snaps to CURRENT page 3 (not replayed 1/2)');
  eq(snap!.transform.zoom, 3, 'doc resync snaps to CURRENT zoom 3x');
  eq(snap!.transform.panX, 20, 'doc resync snaps to CURRENT panX 20');
}

// ── 4. WHITEBOARD onResync snaps to the board's persisted transform ────────────
{
  // The whiteboard module Agent C consumes: onResync reads the board's view from the
  // SAME keyed store, so a board transform snaps to current exactly as the doc does.
  // (Strokes are content — folded in `boards` — not part of the transform snap.)
  let st = initialViewerState();
  const bkey = wbViewPersistKey('wb_tile_x');
  // Seed a board transform via the shared view store (a presenter-follow would write it).
  st = { ...st, views: { ...st.views, [bkey]: { page: 0, transform: { zoom: 4, panX: 7, panY: 9, page: 0 } } } };
  const snap = overlayModule('whiteboard').onResync(st, bkey);
  ok(snap !== null, 'whiteboard onResync returns a snap');
  eq(snap!.transform.zoom, 4, 'whiteboard resync snaps to the board transform zoom 4x');
  eq(snap!.transform.panX, 7, 'whiteboard resync snaps to the board transform panX 7');
}

// ── 5. applyRemote parity — the module fold equals the legacy reducer ──────────
{
  // The whiteboard module's applyRemote IS the gen-aware applyWb; a stroke at the board
  // gen appends, a snapshot replaces. (Proves 1B is behaviour-identical.)
  const wb = overlayModule('whiteboard');
  const empty = { gen: 0, strokes: [] as { id: string; d: string; color: string; width: number }[] };
  const s1 = { id: 's1', d: 'M0 0', color: '#000', width: 2 };
  const afterStroke = wb.applyRemote(empty, { t: 'overlay.wb.stroke', v: 1, boardId: 'b', gen: 0, stroke: s1 });
  eq(afterStroke.strokes.length, 1, 'wb module applyRemote appends a stroke');
  const afterWipe = wb.applyRemote(afterStroke, { t: 'overlay.wb.wipe', v: 1, boardId: 'b', gen: 1 });
  eq(afterWipe.strokes.length, 0, 'wb module applyRemote wipe clears + bumps gen');
  eq(afterWipe.gen, 1, 'wb module applyRemote wipe bumped gen to 1');
}

// ── report ─────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${passed} assertions passed`);
