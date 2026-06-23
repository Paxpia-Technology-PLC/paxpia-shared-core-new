// Unit tests for the FULL-REPLACE scene-overlay model (the P0.3 fix): the producer
// builds a COMPLETE rendered overlay set per scene; the viewer replaces its whole
// overlay layer wholesale, monotonic by nonce, never carrying a previous scene's
// overlays and never snapping to a centered default.
//
// Runs under Node's native TS type-stripping (same harness as target.test.ts):
//     node --experimental-strip-types test/scene.test.ts
// Imports ONLY scene.ts (its cross-module imports are type-only → erased), matching
// the self-contained convention of target.test.ts. The viewer.ts wiring that folds
// the bot's participation overlay into this set is exercised here against the SAME
// pure scene helpers (applyFullScene/buildRenderedScene/visibleOverlays).

import {
  applyFullScene,
  buildRenderedScene,
  emptyRenderedScene,
  slotItemForInstance,
  visibleOverlays,
  sceneOverlayFor,
  encodeSceneSyncMsg,
  decodeSceneSyncMsg,
  type RenderedScene,
  type SceneOverlay,
  type SceneSyncMsg,
} from '../src/streaming/scene.ts';
import type { LiveScene, LiveSceneItem } from '../src/streaming/live.ts';
import type { OverlayInstance } from '../src/overlays/types.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

const rect = (x: number) => ({ x, y: x, w: 0.3, h: 0.3 });
const item = (id: string, type: LiveSceneItem['type'], z: number): LiveSceneItem => ({
  id,
  type,
  rect: rect(z / 10),
  z,
  fit: 'contain',
});
const doc = (id: string): OverlayInstance => ({ id, kind: 'doc', phase: 'active', gen: 1, payload: { title: id, pages: [], page: 0 } });
const poll = (id: string): OverlayInstance => ({ id, kind: 'poll', phase: 'active', gen: 1, payload: { question: id, options: [] } });
// A placed whiteboard's operator instance — identity + canvas geometry only (strokes
// ride overlay.wb.* out-of-band). Mirrors the director's whiteboardInstanceForItem.
const wb = (boardId: string): OverlayInstance => ({
  id: boardId,
  kind: 'whiteboard',
  phase: 'active',
  gen: 0,
  payload: { boardId, canvas: { w: 1000, h: 1000 }, title: 'Whiteboard' },
});

const sceneA: LiveScene = {
  id: 'A',
  name: 'A',
  items: [item('a-doc', 'doc', 0), item('a-ov', 'overlay', 1), item('a-cam', 'camera', 2)],
};
const sceneB: LiveScene = {
  id: 'B',
  name: 'B',
  items: [item('b-doc', 'doc', 0)],
};
// A scene placing a WHITEBOARD tile alongside a camera — the §0.1 regression case:
// the whiteboard item must become a first-class rendered entry (it was DROPPED before).
const sceneWB: LiveScene = {
  id: 'WB',
  name: 'WB',
  items: [item('wb-cam', 'camera', 0), item('wb-board', 'whiteboard', 1)],
};

// The viewer's "fold the bot poll into the first overlay slot" step, replicated
// against the pure scene model (mirrors viewer.foldParticipationOverlay).
function foldPoll(scene: RenderedScene, overlay: OverlayInstance | null): RenderedScene {
  const idx = scene.overlays.findIndex((o) => o.type === 'overlay');
  if (idx < 0) return scene;
  const overlays = scene.overlays.map(
    (o, i): SceneOverlay => (i === idx ? { ...o, instance: overlay } : o),
  );
  return { ...scene, overlays };
}

// ── buildRenderedScene: EVERY overlay/doc item becomes an entry at its rect ────
{
  const r = buildRenderedScene(sceneA, 1, (id, type) => (id === 'a-doc' && type === 'doc' ? doc('d1') : null));
  eq(r.overlays.length, 2, 'build: only overlay/doc items become entries (camera excluded)');
  eq(r.overlays[0].itemId, 'a-doc', 'build: ordered by z (doc first)');
  eq(r.overlays[0].rect, rect(0), 'build: doc entry carries the AUTHORED rect (never defaulted)');
  eq(r.overlays[0].instance?.id, 'd1', 'build: doc slot filled from fillFor');
  eq(r.overlays[1].instance, null, 'build: unfilled overlay slot has instance null');
  eq(visibleOverlays(r).length, 1, 'build: only filled entries are visible');
}

// ── WHITEBOARD is a first-class placement (the §0.1 fix) ──────────────────────
// Before the fix, buildRenderedScene `continue`d past any non-doc/overlay item, so a
// placed whiteboard tile was SILENTLY DROPPED — the director's scene.sync carried no
// board and a web viewer painted nothing. It must now become a kind:'whiteboard' entry.
{
  // (a) A whiteboard layout-item becomes a type:'whiteboard' SceneOverlay carrying the
  //     operator's kind:'whiteboard' instance at the item's authored rect.
  const r = buildRenderedScene(sceneWB, 1, (id, type) =>
    type === 'whiteboard' ? wb('wb_tile_wb-board') : null,
  );
  eq(r.overlays.length, 1, 'wb: the whiteboard item becomes an entry (camera excluded)');
  const board = sceneOverlayFor(r, 'wb-board');
  eq(board?.type, 'whiteboard', 'wb: the entry is a first-class type:whiteboard slot (was DROPPED before)');
  eq(board?.instance?.kind, 'whiteboard', 'wb: the entry carries the kind:whiteboard instance the viewer plane renders');
  eq(board?.instance?.id, 'wb_tile_wb-board', 'wb: the entry carries the layout-stable board id');
  eq((board?.instance?.payload as { boardId?: string }).boardId, 'wb_tile_wb-board', 'wb: payload.boardId resolves the converged stroke set');
  eq(board?.rect, rect(0.1), 'wb: painted at the authored rect (never centered/defaulted)');
  eq(visibleOverlays(r).length, 1, 'wb: the filled whiteboard slot is visible to the viewer');

  // An empty (unfilled) whiteboard slot is still emitted (instance null) so a full
  // replace clears a previously-filled board — and is simply not painted.
  const empty = buildRenderedScene(sceneWB, 1, () => null);
  eq(sceneOverlayFor(empty, 'wb-board')?.instance, null, 'wb: an unfilled whiteboard slot has instance null');
  eq(visibleOverlays(empty).length, 0, 'wb: an unfilled whiteboard slot is not painted');

  // (b) applyFullScene carries the whiteboard entry MONOTONICALLY: a viewer folding the
  //     director's scene keeps the board; a stale (lower-nonce) snapshot can't drop it.
  let v = emptyRenderedScene();
  v = applyFullScene(v, r); // nonce 1: adopt the scene WITH the board
  eq(sceneOverlayFor(v, 'wb-board')?.instance?.kind, 'whiteboard', 'wb: applyFullScene carries the whiteboard to the viewer layer');
  // A newer director scene (nonce 2) still carrying the board is adopted (idempotent).
  const r2 = buildRenderedScene(sceneWB, 2, (id, type) => (type === 'whiteboard' ? wb('wb_tile_wb-board') : null));
  v = applyFullScene(v, r2);
  eq(v.nonce, 2, 'wb: a newer-nonce scene re-carrying the board is adopted');
  eq(sceneOverlayFor(v, 'wb-board')?.instance?.kind, 'whiteboard', 'wb: the board survives a monotonic re-broadcast');
  // A STALE (lower-nonce) snapshot is rejected — the board is NOT regressed/dropped.
  const stale = applyFullScene(v, r); // r.nonce=1 < v.nonce=2
  eq(stale.nonce, 2, 'wb: a stale scene is rejected (monotonic)');
  eq(sceneOverlayFor(stale, 'wb-board')?.instance?.kind, 'whiteboard', 'wb: a stale scene cannot drop the carried board');
}

// ── applyFullScene: REPLACE semantics + monotonic nonce ───────────────────────
{
  const a = buildRenderedScene(sceneA, 1, (id) => (id === 'a-doc' ? doc('d1') : null));
  const b = buildRenderedScene(sceneB, 2, () => null);
  // Switch A → B: the result is EXACTLY B's set — no remnant of A's d1.
  const switched = applyFullScene(a, b);
  eq(switched.sceneId, 'B', 'replace: scene id becomes B');
  eq(switched.overlays.map((o) => o.itemId), ['b-doc'], "replace: ONLY B's items remain (no a-doc/a-ov remnant)");
  eq(visibleOverlays(switched).length, 0, 'replace: B has no fills → nothing visible (no centered remnant)');
  // A STALE snapshot (lower nonce) is ignored — never regress to a previous scene.
  const stale = applyFullScene(switched, a); // a.nonce=1 < switched.nonce=2
  eq(stale.sceneId, 'B', 'monotonic: a stale (lower-nonce) snapshot is ignored');
  // An equal-or-newer snapshot is adopted (idempotent join replay).
  const replay = applyFullScene(switched, { ...b });
  eq(replay.sceneId, 'B', 'monotonic: equal-nonce re-apply is idempotent (adopted)');
}

// ── Scene switch FULLY REPLACES, poll re-folds at the NEW scene's overlay rect ─
{
  // Scene A with a doc + an empty overlay slot; bot poll folds into a-ov at its rect.
  let r = foldPoll(buildRenderedScene(sceneA, 1, (id) => (id === 'a-doc' ? doc('d1') : null)), poll('p1'));
  const aOv = sceneOverlayFor(r, 'a-ov');
  eq(aOv?.instance?.id, 'p1', 'poll folded into scene A overlay slot');
  eq(aOv?.rect, rect(0.1), "poll painted at A's overlay rect (not centered)");
  eq(visibleOverlays(r).length, 2, 'scene A shows doc + poll');

  // Switch to scene B (only a doc slot). FULL REPLACE: A's doc + poll are GONE.
  r = applyFullScene(r, buildRenderedScene(sceneB, 2, () => null));
  // Re-fold the still-active poll — B has no overlay slot, so it is NOT shown.
  r = foldPoll(r, poll('p1'));
  eq(r.sceneId, 'B', 'now on scene B');
  eq(sceneOverlayFor(r, 'a-doc'), undefined, 'scene A doc REMOVED (no remnant)');
  eq(sceneOverlayFor(r, 'a-ov'), undefined, 'scene A overlay REMOVED (no remnant)');
  eq(visibleOverlays(r).length, 0, 'B has no overlay slot → poll not rendered, no center fallback');
}

// ── slotItemForInstance: served slot wins; else first of type; else null ──────
{
  eq(slotItemForInstance(sceneA.items, { kind: 'poll' }, 'a-ov'), 'a-ov', 'served overlay slot wins');
  eq(slotItemForInstance(sceneA.items, { kind: 'poll' }, null), 'a-ov', 'first overlay slot by draw order');
  eq(slotItemForInstance(sceneB.items, { kind: 'poll' }, null), null, 'no overlay slot → null (poll has nowhere to go)');
  eq(slotItemForInstance(sceneA.items, { kind: 'doc' }, 'a-ov'), 'a-doc', 'served id of wrong type ignored → first doc slot');
}

// ── wire encode/decode round-trips; foreign bytes decode to null ──────────────
{
  const msg: SceneSyncMsg = { t: 'scene.sync', v: 1, scene: buildRenderedScene(sceneA, 7, () => null) };
  const round = decodeSceneSyncMsg(encodeSceneSyncMsg(msg));
  eq(round?.scene.nonce, 7, 'scene-sync round-trips through encode/decode');
  eq(round?.scene.sceneId, 'A', 'scene-sync round-trip keeps scene id');
  const foreign = new TextEncoder().encode(JSON.stringify({ t: 'overlay.changed' }));
  eq(decodeSceneSyncMsg(foreign), null, 'a non-scene envelope decodes to null (safely ignored)');
}

// emptyRenderedScene is the zero value.
eq(emptyRenderedScene(), { sceneId: null, nonce: 0, overlays: [] }, 'emptyRenderedScene is the zero value');

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${passed} assertions passed`);
