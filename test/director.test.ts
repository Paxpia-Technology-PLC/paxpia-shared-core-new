// Unit tests for the PRODUCER-DIRECTION brain (§2.1): the pure direction logic
// (vote-aggregation reconcile, serve-to-slot target resolution, scene-switch doc
// rebuild, scene projection) AND a small end-to-end drive of `createDirectorSession`
// over fake seams (no transport/media/compositor SDK), asserting the producer wires.
//
// Runs under Node's native TS type-stripping (same harness as scene.test.ts):
//     node --experimental-strip-types test/director.test.ts

import {
  reconcileOverlayChanged,
  reconcileResultsGen,
  resolveOverlayServeTarget,
  resolveDocServeTarget,
  docForSceneSwitch,
  currentSceneSlots,
  snapshotScene,
  overlaySlotHostId,
  deriveSceneItems,
  sceneFillFor,
  wbBoardIdForItem,
  whiteboardInstanceForItem,
  type ServedDocs,
} from '../src/director/logic.ts';
import { createDirectorSession } from '../src/director/session.ts';
import { buildRenderedScene, type RenderedScene } from '../src/streaming/scene.ts';
import type { WhiteboardPayload } from '../src/overlays/types.ts';
import type {
  DirectorDeps,
  DirectorMedia,
  DirectorTransport,
  DirectorRoomHandle,
  DirectorMaterial,
  DirectorPreloadCache,
  DirectorLiveSync,
} from '../src/director/types.ts';
import type { Scene } from '../src/layout/types.ts';
import type { LiveScene } from '../src/streaming/live.ts';
import type { OverlayInstance } from '../src/overlays/types.ts';
import { activeScene } from '../src/studio/scenes.ts';
import type { ScenesState } from '../src/studio/types.ts';

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
const lItem = (id: string, type: Scene['items'][number]['type'], z: number): Scene['items'][number] => ({
  id,
  type,
  rect: rect(z / 10),
  z,
  fit: 'contain',
});
const poll = (id: string, gen = 1): OverlayInstance => ({
  id,
  kind: 'poll',
  phase: 'active',
  gen,
  payload: { question: id, options: ['a', 'b'] },
  results: {},
});
const docInst = (id: string): OverlayInstance => ({
  id,
  kind: 'doc',
  phase: 'active',
  gen: 1,
  payload: { title: id, pages: ['u'], page: 0 },
  results: {},
});

// Scene A: a doc slot + an overlay slot + a camera. Scene B: overlay slot only.
const sceneA: Scene = {
  id: 'A',
  name: 'A',
  items: [lItem('a-doc', 'doc', 0), lItem('a-ov', 'overlay', 1), lItem('a-cam', 'camera', 2)],
};
const sceneB: Scene = { id: 'B', name: 'B', items: [lItem('b-ov', 'overlay', 0)] };
// Scene WB: a camera + a placed WHITEBOARD tile (the §0.1 case — the board must reach
// the rendered scene the director broadcasts).
const sceneWB: Scene = {
  id: 'WB',
  name: 'WB',
  items: [lItem('wb-cam', 'camera', 0), { ...lItem('wb-board', 'whiteboard', 1), label: 'My Board' }],
};

// ════════════════════════════════════════════════════════════════════════════
// 1. VOTE-AGGREGATION reconcile (the P0.2 streamer-authoritative guards)
// ════════════════════════════════════════════════════════════════════════════
{
  // No local selection + a real echo → adopt.
  eq(
    reconcileOverlayChanged(poll('p1'), null, null),
    { action: 'adopt', overlay: poll('p1') },
    'echo adopted when no local selection',
  );
  // Local selection for a DIFFERENT id → ignore (never flash back to a superseded poll).
  eq(
    reconcileOverlayChanged(poll('p2'), poll('p1'), 'p1').action,
    'ignore',
    'echo for a different id is ignored (streamer-authoritative)',
  );
  // Same id but the echo gen REGRESSES → ignore (never regress).
  eq(
    reconcileOverlayChanged(poll('p1', 1), poll('p1', 3), 'p1').action,
    'ignore',
    'a gen-regressing echo of the same id is ignored',
  );
  // Same id, NEWER gen (the bot's authoritative round) → adopt.
  eq(
    reconcileOverlayChanged(poll('p1', 4), poll('p1', 3), 'p1'),
    { action: 'adopt', overlay: poll('p1', 4) },
    'a newer-gen echo of the same id is adopted',
  );
  // Bot cleared + no local selection + a prev overlay → clear.
  eq(reconcileOverlayChanged(null, poll('p1'), null).action, 'clear', 'bot clear honored when no local selection');
  // Bot cleared but the streamer HAS a local selection → ignore (don't yank it).
  eq(
    reconcileOverlayChanged(null, poll('p1'), 'p1').action,
    'ignore',
    'bot clear ignored while the streamer holds a local selection',
  );
  // A non-overlay (doc) echo never drives the participation slot.
  eq(reconcileOverlayChanged(docInst('d1'), null, null).action, 'ignore', 'a doc-kind echo never drives the overlay slot');

  // Results-gen adopt: a stale local gen for THIS id adopts the bot's newer gen.
  eq(reconcileResultsGen(poll('p1', 2), 'p1', 5), { adopt: true, gen: 5 }, 'results adopt the bot newer gen for the same id');
  eq(reconcileResultsGen(poll('p1', 5), 'p1', 5).adopt, false, 'results do NOT adopt an equal gen');
  eq(reconcileResultsGen(poll('p1', 2), 'other', 9).adopt, false, 'results for a different id never adopt');
  eq(reconcileResultsGen(null, 'p1', 9).adopt, false, 'results never adopt when no overlay is active');
}

// ════════════════════════════════════════════════════════════════════════════
// 2. SERVE-TO-SLOT target resolution (scene-scoped, explicit-drag vs auto)
// ════════════════════════════════════════════════════════════════════════════
{
  const noDocs: ServedDocs = {};
  const slotsA = currentSceneSlots(sceneA, noDocs);
  // Auto-resolve a poll → the one overlay slot in scene A.
  eq(resolveOverlayServeTarget(slotsA, 'poll', undefined), 'a-ov', 'a poll auto-resolves to the scene overlay slot');
  // Auto-resolve a doc → the one (empty) doc slot in scene A.
  eq(resolveDocServeTarget(slotsA, undefined), 'a-doc', 'a material auto-resolves to the empty doc slot');
  // Explicit drag onto the overlay slot (right type) → honored.
  eq(resolveOverlayServeTarget(slotsA, 'poll', 'a-ov'), 'a-ov', 'explicit drag onto the overlay slot is honored');
  // Explicit drag of a poll onto a DOC slot → NO-OP (a poll can't drop on a doc slot).
  eq(resolveOverlayServeTarget(slotsA, 'poll', 'a-doc'), null, 'a poll dragged onto a doc slot is a no-op');
  // Explicit drag of a material onto an OVERLAY slot → NO-OP.
  eq(resolveDocServeTarget(slotsA, 'a-ov'), null, 'a material dragged onto an overlay slot is a no-op');
  // A scene with NO doc slot → a material auto-resolve is a no-op.
  const slotsB = currentSceneSlots(sceneB, noDocs);
  eq(resolveDocServeTarget(slotsB, undefined), null, 'a material in a doc-slot-less scene is a no-op');

  // A filled doc slot still resolves (re-serve/replace), never silently no-ops.
  const withDoc: ServedDocs = { A: { 'a-doc': docInst('srv_a-doc') } };
  const slotsAFilled = currentSceneSlots(sceneA, withDoc);
  eq(resolveDocServeTarget(slotsAFilled, undefined), 'a-doc', 'a filled doc slot re-serves into itself (replace)');
}

// ════════════════════════════════════════════════════════════════════════════
// 3. SCENE-SWITCH doc rebuild + scene projection
// ════════════════════════════════════════════════════════════════════════════
{
  const served: ServedDocs = { A: { 'a-doc': docInst('srv_a-doc') }, B: {} };
  // Switching to A picks up A's served doc; switching to B (no fill) clears the doc.
  eq(docForSceneSwitch('A', served)?.id, 'srv_a-doc', 'a scene switch lands the new scene served doc');
  eq(docForSceneSwitch('B', served), null, 'a scene switch to a doc-less scene clears the live doc');
  eq(docForSceneSwitch('C', served), null, 'a scene switch to an unknown scene clears the live doc');

  // overlaySlotHostId picks the FIRST overlay-type item in draw order, only for a
  // live participation overlay (never for a doc, never when none is live).
  const liveA: LiveScene = snapshotScene(sceneA);
  eq(overlaySlotHostId(liveA, poll('p1')), 'a-ov', 'the overlay host is the first overlay item in draw order');
  eq(overlaySlotHostId(liveA, null), null, 'no overlay host when no participation overlay is live');
  eq(overlaySlotHostId(liveA, docInst('d1')), null, 'a doc instance never claims the overlay host');

  // deriveSceneItems projects served docs + the overlay host for the manifest.
  const items = deriveSceneItems(liveA, served, poll('p1'), 'a-ov');
  eq(items.length, 3, 'deriveSceneItems projects every scene item');
  eq(
    items.find((i) => i.type === 'doc'),
    { type: 'doc', instanceId: 'srv_a-doc', docUrl: 'u', docKind: 'image' },
    'the doc item carries its presigned source + image kind',
  );
  eq(
    items.find((i) => i.type === 'overlay'),
    { type: 'overlay', instanceId: 'p1', overlayType: 'poll' },
    'the overlay host carries the live participation overlay',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 3b. WHITEBOARD placement fill (the §0.1 fix — board reaches the rendered scene)
// ════════════════════════════════════════════════════════════════════════════
{
  // The board id is layout-stable (wb_tile_<itemId>) so placement + strokes + viewer
  // resolution agree. MUST match web StudioWhiteboardTile's `wb_tile_${item.id}`.
  eq(wbBoardIdForItem('wb-board'), 'wb_tile_wb-board', 'the board id is derived layout-stably from the item id');

  // The operator instance carries identity + canvas geometry only (strokes ride
  // overlay.wb.* out-of-band); title falls back to the item label.
  const inst = whiteboardInstanceForItem({ id: 'wb-board', label: 'My Board' });
  eq(inst.kind, 'whiteboard', 'the whiteboard instance is kind:whiteboard');
  eq(inst.id, 'wb_tile_wb-board', 'the instance id IS the board id');
  eq((inst.payload as WhiteboardPayload).boardId, 'wb_tile_wb-board', 'the payload boardId resolves the converged stroke set');
  eq((inst.payload as WhiteboardPayload).canvas, { w: 1000, h: 1000 }, 'the payload carries the authoring canvas geometry');
  eq((inst.payload as WhiteboardPayload).title, 'My Board', 'the payload title falls back to the item label');

  // sceneFillFor fills a whiteboard slot from a synthesized instance; buildRenderedScene
  // (now whiteboard-aware) carries it as a first-class entry the director broadcasts.
  const liveWB: LiveScene = snapshotScene(sceneWB);
  const rendered: RenderedScene = buildRenderedScene(liveWB, 1, sceneFillFor(liveWB, {}, null, null));
  const board = rendered.overlays.find((o) => o.itemId === 'wb-board');
  eq(board?.type, 'whiteboard', 'broadcastScene carries the whiteboard item as a first-class slot (was DROPPED before)');
  eq(board?.instance?.kind, 'whiteboard', 'the carried slot holds the kind:whiteboard instance the viewer renders');
  eq(board?.instance?.id, 'wb_tile_wb-board', 'the carried board uses the layout-stable id');
  eq(rendered.overlays.some((o) => o.itemId === 'wb-cam'), false, 'the camera item rides the composited video, not this layer');
}

// ════════════════════════════════════════════════════════════════════════════
// 4. END-TO-END drive of createDirectorSession over fake seams
// ════════════════════════════════════════════════════════════════════════════
{
  // ── A scriptable scenes store (the StoreHandle the brain reads + subscribes to) ─
  function makeScenesStore(initial: Scene[], activeId: string) {
    let st: ScenesState = { scenes: initial, activeId };
    const subs = new Set<(s: ScenesState, prev: ScenesState) => void>();
    return {
      handle: {
        getState: () => st,
        setState: (p: Partial<ScenesState>) => {
          const prev = st;
          st = { ...st, ...p };
          for (const cb of subs) cb(st, prev);
        },
        subscribe: (cb: (s: ScenesState, prev: ScenesState) => void) => {
          subs.add(cb);
          return () => subs.delete(cb);
        },
      },
      switchTo: (id: string) => {
        const prev = st;
        st = { ...st, activeId: id };
        for (const cb of subs) cb(st, prev);
      },
    };
  }

  // ── A recording fake transport ───────────────────────────────────────────────
  interface Recorder {
    transport: DirectorTransport;
    scenes: number;
    liveSyncs: number;
    manifests: number;
    createdOverlays: OverlayInstance[];
    closed: string[];
    lastScene: RenderedScene | null;
    lastLiveSync: DirectorLiveSync | null;
    fireChanged?: (o: OverlayInstance | null) => void;
    fireParticipant?: () => void;
  }
  function makeTransport(): Recorder {
    const rec: Recorder = {
      scenes: 0,
      liveSyncs: 0,
      manifests: 0,
      createdOverlays: [],
      closed: [],
      lastScene: null,
      lastLiveSync: null,
      transport: undefined as never,
    };
    let changedCb: ((e: { overlay: OverlayInstance | null }) => void) | null = null;
    let participantCb: (() => void) | null = null;
    rec.transport = {
      publishLiveSync: (m) => void ((rec.liveSyncs += 1), (rec.lastLiveSync = m)),
      publishScene: (s) => void ((rec.scenes += 1), (rec.lastScene = s)),
      publishManifest: () => void (rec.manifests += 1),
      createAndActivate: (o) => void rec.createdOverlays.push(o),
      closeOverlay: (id) => void rec.closed.push(id),
      revealOverlay: () => {},
      refreshOverlay: () => 99,
      enableAggregator: () => () => {},
      onOverlayChanged: (cb) => {
        changedCb = cb;
        return () => {};
      },
      onResults: () => () => {},
      onParticipantConnected: (cb) => {
        participantCb = cb;
        return () => {};
      },
      dispose: () => {},
    };
    rec.fireChanged = (o) => changedCb?.({ overlay: o });
    rec.fireParticipant = () => participantCb?.();
    return rec;
  }

  // ── A fake preload cache + media + materials runtime ─────────────────────────
  function makeCache(): DirectorPreloadCache {
    const m = new Map<string, { id: string; doc: never; bytes: number }>();
    return {
      has: (id) => m.has(id),
      get: (id) => m.get(id) as never,
      set: (id, e) => void m.set(id, e as never),
    };
  }

  const scenesStore = makeScenesStore([sceneA, sceneB, sceneWB], 'A');
  const rec = makeTransport();
  const fakeRoom: DirectorRoomHandle = { name: 'room-1' };
  const media: DirectorMedia = {
    provisionScene: async () => true,
    sceneHasMedia: () => false, // treat as audio-only-ish so no compositor track needed
    openRoom: async () => ({ roomName: 'room-1', room: fakeRoom }),
    mediaSourceFor: () => undefined,
    publishVideoTrack: async () => {},
    publishMic: async () => {},
    buildTransport: () => rec.transport,
    closeRoom: async () => {},
  };

  const deps: DirectorDeps = {
    media,
    compositorFactory: () => ({
      setScene: () => {},
      setActiveScene: () => {},
      upsertItem: () => {},
      removeItem: () => {},
      getOutputTrack: () => null,
      start: () => {},
      stop: () => {},
    }),
    materials: { baseUrl: '', fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), authHeader: () => ({}) },
    materialsRuntime: {
      buildDocPayload: async (m: DirectorMaterial) => ({ title: m.id, pages: ['u'], page: 0, sourceUrl: 'u' }),
      warmManifest: async () => {},
    },
    newPreloadCache: makeCache,
    scenes: scenesStore.handle,
    scheduling: { getState: () => ({ scheduled: [], activeStreamId: null }), setState: () => {}, subscribe: () => () => {}, setActiveStream: () => {} },
    isAuthed: () => true,
  };

  const session = createDirectorSession(deps);

  // Go live in audio-only mode (no media items in scene A's media → simplest path).
  await session.goLive('Class', 'public', true);
  eq(session.getState().status, 'live', 'session reaches live status');
  ok(rec.scenes >= 1 && rec.liveSyncs >= 1, 'go-live broadcasts the initial scene + live-sync');

  // Serve a poll → routes to scene A's overlay slot + creates the overlay on the bot.
  const target = session.serveOverlayToSlot({ kind: 'poll', title: 'Q1', payload: { question: 'Q1', options: ['a', 'b'] } });
  eq(target, 'a-ov', 'serveOverlayToSlot resolves to the scene A overlay slot');
  eq(rec.createdOverlays.length, 1, 'serving a poll creates+activates it on the transport');
  eq(rec.createdOverlays[0].id, 'srv_poll:Q1', 'the served overlay id is stable per (kind,title) for vote persistence');
  eq(session.getState().activeOverlay?.id, 'srv_poll:Q1', 'the served poll fills the participation slot locally');

  // Serve a material → routes to scene A's doc slot + sets the live doc.
  const docTarget = await session.serveMaterialToSlot({ id: 'mat-1', sizeBytes: 10, kind: 'renderable' });
  eq(docTarget, 'a-doc', 'serveMaterialToSlot resolves to the scene A doc slot');
  eq(session.getState().activeDoc?.id, 'srv_a-doc', 'the served material fills the doc slot');
  eq(session.getState().servedDocs['A']?.['a-doc']?.id, 'srv_a-doc', 'the served doc is recorded per-scene');

  // ── WHITEBOARD-ON-DOC ANNOTATION (Message D item 2 + R7): the board id keys off the
  //    STABLE DOCUMENT identity (path-stripped sourceUrl 'u'), NOT the slot id 'srv_a-doc'
  //    — so a different doc in the same slot starts blank, not the slot's old strokes. ──
  session.setDocAnnotation(true);
  eq(session.getState().docAnn, { on: true, boardId: 'wbann:u:0', mode: 'single' }, 'setDocAnnotation(true) keys the board off the doc identity (sourceUrl), not the slot id (R7)');
  eq(rec.lastLiveSync?.docAnn, { on: true, boardId: 'wbann:u:0', mode: 'single' }, 'the live-sync broadcast carries the annotation descriptor (on)');
  // Toggling off keeps the SAME board id but on:false → viewers HIDE the layer while the
  // strokes persist (present-not-destroy). The board never changes identity on a toggle.
  session.setDocAnnotation(false);
  eq(session.getState().docAnn?.on, false, 'setDocAnnotation(false) flips the descriptor off (board id unchanged)');
  eq(rec.lastLiveSync?.docAnn?.boardId, 'wbann:u:0', 'toggle-off broadcasts the same board id (strokes persist)');

  // ── R1: single⇆scroll mode is SYNCED on the presenter, and swaps the annotation board
  //    between per-page (single → wbann:<doc>:<page>) and per-doc (scroll → wbann:<doc>). ─
  session.setDocAnnotation(true);
  session.setDocMode('scroll');
  eq(rec.lastLiveSync?.docPresenter?.mode, 'scroll', 'setDocMode broadcasts the mode on the presenter (R1)');
  eq(session.getState().docAnn?.boardId, 'wbann:u', 'scroll mode → the annotation board is per-DOC (no page suffix)');
  session.setDocMode('single');
  eq(session.getState().docAnn?.boardId, 'wbann:u:0', 'single mode → the annotation board is per-PAGE again');
  session.setDocAnnotation(false);

  // A participant join replays the doc + scene.
  const scenesBefore = rec.scenes;
  rec.fireParticipant?.();
  ok(rec.scenes > scenesBefore, 'a participant join re-broadcasts the scene');

  // Hot-swap to scene B (no doc slot) → the live doc is rebuilt from B's fill (none).
  scenesStore.switchTo('B');
  eq(session.getState().activeDoc, null, 'a scene switch to a doc-less scene clears the live doc');
  // Serving a material in scene B (no doc slot) → NO-OP.
  const noop = await session.serveMaterialToSlot({ id: 'mat-2', sizeBytes: 10, kind: 'renderable' });
  eq(noop, null, 'serving a material into a doc-slot-less scene is a no-op');

  // Hot-swap to the WHITEBOARD scene → the director's broadcast scene CARRIES the placed
  // board as a first-class kind:whiteboard entry (the §0.1 fix: a dashboard-authored
  // whiteboard now reaches the rendered scene a viewer receives — was DROPPED before).
  // A scene switch broadcasts in a `.finally()` after the (async) media provision, so
  // flush the microtask queue before reading the recorded scene.
  scenesStore.switchTo('WB');
  await new Promise((r) => setTimeout(r, 0));
  const wbBoard = rec.lastScene?.overlays.find((o) => o.itemId === 'wb-board');
  eq(rec.lastScene?.sceneId, 'WB', 'a scene switch to the whiteboard scene re-broadcasts it');
  eq(wbBoard?.type, 'whiteboard', 'the broadcast scene carries the whiteboard as a first-class slot');
  eq(wbBoard?.instance?.kind, 'whiteboard', 'the carried slot holds the kind:whiteboard instance the web viewer renders');
  eq(wbBoard?.instance?.id, 'wb_tile_wb-board', 'the carried board uses the layout-stable id (placement+strokes+resolution agree)');
  ok((rec.lastScene?.nonce ?? 0) >= 1, 'the carried scene rides the director monotonic nonce (no nonce:1 race)');

  // ── SYNCED whiteboard view-flags (transparent + hidden) ride scene.sync ─────────
  // transparent → the board PAYLOAD (every viewer renders the same transparency).
  session.setWhiteboardTransparent('wb-board', true);
  const wbT = rec.lastScene?.overlays.find((o) => o.itemId === 'wb-board');
  eq((wbT?.instance?.payload as WhiteboardPayload)?.transparent, true, 'setWhiteboardTransparent carries transparent:true in the synced board payload');
  // hidden → the board is DROPPED from the viewer rendered set (instance null), so a viewer
  // paints nothing ("for viewers it's gone"); the operator keeps a ghosted tile.
  session.setWhiteboardHidden('wb-board', true);
  const wbH = rec.lastScene?.overlays.find((o) => o.itemId === 'wb-board');
  ok(wbH !== undefined && wbH.instance === null, 'setWhiteboardHidden DROPS the board from the viewer set (instance null)');
  // un-hiding re-presents the board (with transparent still true — settings persist).
  session.setWhiteboardHidden('wb-board', false);
  const wbU = rec.lastScene?.overlays.find((o) => o.itemId === 'wb-board');
  ok(wbU?.instance?.kind === 'whiteboard', 'un-hiding re-presents the board to viewers');
  eq((wbU?.instance?.payload as WhiteboardPayload)?.transparent, true, 'the transparent setting PERSISTS across a hide/unhide');
  eq(session.getState().wbSettings['wb-board'], { transparent: true, hidden: false }, 'wbSettings holds the synced per-item view-flags');

  // An inbound bot clear with no local selection clears the participation slot. The
  // streamer holds a local selection from the earlier serve, so a clear is ignored…
  rec.fireChanged?.(null);
  eq(session.getState().activeOverlay?.id, 'srv_poll:Q1', 'a bot clear is ignored while a local selection is held');
  // …until the streamer explicitly closes it (drops the local selection).
  session.closeActive('overlay');
  eq(session.getState().activeOverlay, null, 'closeActive(overlay) clears the participation slot');
  eq(rec.closed.length, 1, 'closeActive(overlay) closes the overlay on the transport');

  // End live resets to idle.
  await session.endLive();
  eq(session.getState().status, 'idle', 'endLive returns the session to idle');
  eq(session.getState().activeDoc, null, 'endLive clears the doc slot');
  eq(session.getState().servedDocs, {}, 'endLive clears served docs');
}

// ════════════════════════════════════════════════════════════════════════════
// 5. WI-8 — VIDEO TRACK LIFECYCLE: scene-switch republish + lost-track safety net
//    (the brain must keep the LiveKit video publication alive across a scene switch on
//     a platform whose compositor output track CHANGES per scene — RN — and must
//     RENEGOTIATE a lost track back to the SFU, not just the local preview.)
// ════════════════════════════════════════════════════════════════════════════
{
  // Two CAMERA scenes whose compositor output is a DIFFERENT token per scene (the RN
  // single-source passthrough). The fake compositor returns the active scene's token.
  const camA: Scene = { id: 'CA', name: 'CA', items: [lItem('ca-cam', 'camera', 0)] };
  const camB: Scene = { id: 'CB', name: 'CB', items: [lItem('cb-cam', 'camera', 0)] };

  // A scriptable scenes store (same shape as section 4's helper).
  let st: ScenesState = { scenes: [camA, camB], activeId: 'CA' };
  const subs = new Set<(s: ScenesState, prev: ScenesState) => void>();
  const scenesHandle = {
    getState: () => st,
    setState: (p: Partial<ScenesState>) => { const prev = st; st = { ...st, ...p }; for (const cb of subs) cb(st, prev); },
    subscribe: (cb: (s: ScenesState, prev: ScenesState) => void) => { subs.add(cb); return () => subs.delete(cb); },
  };
  const switchScene = (id: string) => { const prev = st; st = { ...st, activeId: id }; for (const cb of subs) cb(st, prev); };

  // The fake compositor: its output token is the active scene's primary cam id (so it
  // CHANGES per scene, like RN). Drive `setActiveScene` so it tracks the brain's switch.
  let compActive = 'CA';
  const compositor = {
    setScene: () => {},
    setActiveScene: (id: string) => { compActive = id; },
    upsertItem: () => {},
    removeItem: () => {},
    getOutputTrack: () => (compActive === 'CA' ? 'track-CA' : 'track-CB'),
    start: () => {},
    stop: () => {},
  };

  // Recording media seam WITH the new WI-8 hooks.
  const published: unknown[] = [];     // publishVideoTrack calls (go-live first publish)
  const republished: unknown[] = [];   // republishVideoTrack calls (scene switch / recovery)
  let provisionCount = 0;
  let lostCb: (() => void) | null = null;
  const fakeRoom2: DirectorRoomHandle = { name: 'room-2' };
  // A minimal no-op transport (this section only exercises the media seam, not overlays).
  const transport2: DirectorTransport = {
    publishLiveSync: () => {},
    publishScene: () => {},
    publishManifest: () => {},
    createAndActivate: () => {},
    closeOverlay: () => {},
    revealOverlay: () => {},
    refreshOverlay: () => 1,
    enableAggregator: () => () => {},
    onOverlayChanged: () => () => {},
    onResults: () => () => {},
    onParticipantConnected: () => () => {},
    dispose: () => {},
  };
  // A minimal preload cache (no materials are warmed in this section).
  const cache2: DirectorPreloadCache = (() => {
    const m = new Map<string, { id: string; doc: never; bytes: number }>();
    return { has: (id: string) => m.has(id), get: (id: string) => m.get(id) as never, set: (id: string, e: { id: string; doc: never; bytes: number }) => void m.set(id, e) };
  })();
  const media2: DirectorMedia = {
    provisionScene: async () => { provisionCount += 1; return true; },
    sceneHasMedia: () => true,
    openRoom: async () => ({ roomName: 'room-2', room: fakeRoom2 }),
    mediaSourceFor: () => ({}),
    publishVideoTrack: async (_r, t) => { published.push(t); },
    republishVideoTrack: async (_r, t) => { republished.push(t); },
    onVideoTrackLost: (cb) => { lostCb = cb; return () => { if (lostCb === cb) lostCb = null; }; },
    publishMic: async () => {},
    buildTransport: () => transport2,
    closeRoom: async () => {},
  };
  const deps2: DirectorDeps = {
    media: media2,
    compositorFactory: () => compositor,
    materials: { baseUrl: '', fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), authHeader: () => ({}) },
    materialsRuntime: {
      buildDocPayload: async (m: DirectorMaterial) => ({ title: m.id, pages: ['u'], page: 0, sourceUrl: 'u' }),
      warmManifest: async () => {},
    },
    newPreloadCache: () => cache2,
    scenes: scenesHandle as never,
    scheduling: { getState: () => ({ scheduled: [], activeStreamId: null }), setState: () => {}, subscribe: () => () => {}, setActiveStream: () => {} },
    isAuthed: () => true,
  };

  const s2 = createDirectorSession(deps2);
  await s2.goLive('Cam class', 'public'); // VIDEO mode (audioOnly defaults false)
  eq(s2.getState().status, 'live', 'WI-8: video session reaches live');
  eq(published.length, 1, 'WI-8: go-live publishes the initial scene output track once');
  eq(published[0], 'track-CA', 'WI-8: the first published track is scene CA output');
  ok(lostCb !== null, 'WI-8: the brain wired the lost-track safety net on go-live');

  // HOT-SWAP to scene CB → the compositor output token changes; the brain MUST republish
  // the NEW track to the SFU (the WI-8 fix). The switch broadcasts in a `.then/.finally`
  // after the async provision, so flush microtasks.
  const provBefore = provisionCount;
  switchScene('CB');
  await new Promise((r) => setTimeout(r, 0));
  ok(provisionCount > provBefore, 'WI-8: a scene switch re-provisions the new scene media');
  eq(republished.length, 1, 'WI-8: a scene switch RE-PUBLISHES the new output track (no dropped feed)');
  eq(republished[republished.length - 1], 'track-CB', 'WI-8: the republished track is the NEW scene (CB) output');

  // SAFETY NET — simulate the published track being lost (ended/mute). The brain must
  // re-provision the active scene AND republish a live track back to the SFU.
  const reBefore = republished.length;
  const provBefore2 = provisionCount;
  lostCb?.();
  await new Promise((r) => setTimeout(r, 0));
  ok(provisionCount > provBefore2, 'WI-8: a lost track triggers a re-provision of the active scene');
  ok(republished.length > reBefore, 'WI-8: a lost track RENEGOTIATES the track back to the SFU (not just preview)');
  eq(republished[republished.length - 1], 'track-CB', 'WI-8: recovery republishes the active scene (CB) live track');

  await s2.endLive();
  eq(s2.getState().status, 'idle', 'WI-8: endLive returns to idle');
}

// ════════════════════════════════════════════════════════════════════════════
// 6. WI-7c — PERSISTENT SOURCE LAYER (brain side): a cam → cam+screenshare switch
//    MAINTAINS the camera (provisionScene must REUSE the already-live camera source and
//    acquire ONLY the new screenshare) and republishes the correct primary output. The
//    per-source-key REUSE itself lives in the mobile `mediaRegistry`; here we assert the
//    brain re-provisions + republishes the new scene WITHOUT ever publishing a null/blank
//    track, so the camera never blanks on the switch.
// ════════════════════════════════════════════════════════════════════════════
{
  // Scene CAM = camera only. Scene MIX = the SAME camera (full-frame primary, z 0) + a
  // screenshare PiP (z 1). A real registry keys both cameras to the one `camera` source
  // key, so the camera carries over; this fake models that by acquiring per source key.
  const camOnly: Scene = { id: 'CAM', name: 'CAM', items: [lItem('cam-a', 'camera', 0)] };
  const camPlusScreen: Scene = {
    id: 'MIX',
    name: 'MIX',
    items: [lItem('mix-cam', 'camera', 0), lItem('mix-screen', 'screen', 1)],
  };

  let st: ScenesState = { scenes: [camOnly, camPlusScreen], activeId: 'CAM' };
  const subs = new Set<(s: ScenesState, prev: ScenesState) => void>();
  const scenesHandle = {
    getState: () => st,
    setState: (p: Partial<ScenesState>) => { const prev = st; st = { ...st, ...p }; for (const cb of subs) cb(st, prev); },
    subscribe: (cb: (s: ScenesState, prev: ScenesState) => void) => { subs.add(cb); return () => subs.delete(cb); },
  };
  const switchScene = (id: string) => { const prev = st; st = { ...st, activeId: id }; for (const cb of subs) cb(st, prev); };

  // A fake media seam modelling the PERSISTENT SOURCE LAYER: streams are keyed by SOURCE
  // KEY (camera/screen), acquired ONCE, reused across scenes. provisionScene acquires only
  // the keys a scene needs that aren't already live (the WI-7c diff).
  const liveSourceKeys = new Set<string>();
  const acquiredCalls: string[] = []; // each NEW acquire (a getUserMedia) — must NOT include a repeat camera
  const keyForItem = (type: string) => (type === 'screen' ? 'screen' : 'camera');
  const itemsOf = (id: string) => (st.scenes.find((s) => s.id === id)?.items ?? []).filter((i) => i.type === 'camera' || i.type === 'screen');

  // The fake compositor's output = the active scene's PRIMARY (lowest-z) media item's
  // source key token, so it's never null while a camera source is live.
  let compActive = 'CAM';
  const primaryTokenFor = (sceneId: string): string | null => {
    const media = itemsOf(sceneId).slice().sort((a, b) => a.z - b.z);
    const primary = media.find((i) => liveSourceKeys.has(keyForItem(i.type))) ?? media[0];
    if (!primary) return null;
    return liveSourceKeys.has(keyForItem(primary.type)) ? `out:${keyForItem(primary.type)}` : null;
  };
  const compositor = {
    setScene: () => {},
    setActiveScene: (id: string) => { compActive = id; },
    upsertItem: () => {},
    removeItem: () => {},
    getOutputTrack: () => primaryTokenFor(compActive),
    start: () => {},
    stop: () => {},
  };

  const republished: (string | null)[] = [];
  const transport3: DirectorTransport = {
    publishLiveSync: () => {}, publishScene: () => {}, publishManifest: () => {},
    createAndActivate: () => {}, closeOverlay: () => {}, revealOverlay: () => {}, refreshOverlay: () => 1,
    enableAggregator: () => () => {}, onOverlayChanged: () => () => {}, onResults: () => () => {},
    onParticipantConnected: () => () => {}, dispose: () => {},
  };
  const cache3: DirectorPreloadCache = (() => {
    const m = new Map<string, { id: string; doc: never; bytes: number }>();
    return { has: (id: string) => m.has(id), get: (id: string) => m.get(id) as never, set: (id: string, e: { id: string; doc: never; bytes: number }) => void m.set(id, e) };
  })();
  const published3: (string | null)[] = [];
  const media3: DirectorMedia = {
    provisionScene: async (sceneId) => {
      // DIFF: acquire only the source keys this scene needs that aren't already live.
      for (const it of itemsOf(sceneId)) {
        const key = keyForItem(it.type);
        if (!liveSourceKeys.has(key)) { liveSourceKeys.add(key); acquiredCalls.push(key); }
      }
      return itemsOf(sceneId).length > 0;
    },
    sceneHasMedia: (id) => itemsOf(id).length > 0,
    openRoom: async () => ({ roomName: 'room-3', room: { name: 'room-3' } }),
    mediaSourceFor: () => ({}),
    publishVideoTrack: async (_r, t) => { published3.push(t as string | null); },
    republishVideoTrack: async (_r, t) => { republished.push(t as string | null); },
    onVideoTrackLost: () => () => {},
    publishMic: async () => {},
    buildTransport: () => transport3,
    closeRoom: async () => { liveSourceKeys.clear(); },
  };
  const deps3: DirectorDeps = {
    media: media3,
    compositorFactory: () => compositor,
    materials: { baseUrl: '', fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), authHeader: () => ({}) },
    materialsRuntime: { buildDocPayload: async (m: DirectorMaterial) => ({ title: m.id, pages: ['u'], page: 0, sourceUrl: 'u' }), warmManifest: async () => {} },
    newPreloadCache: () => cache3,
    scenes: scenesHandle as never,
    scheduling: { getState: () => ({ scheduled: [], activeStreamId: null }), setState: () => {}, subscribe: () => () => {}, setActiveStream: () => {} },
    isAuthed: () => true,
  };

  const s3 = createDirectorSession(deps3);
  await s3.goLive('Mixed class', 'public');
  eq(s3.getState().status, 'live', 'WI-7c: video session reaches live');
  eq(acquiredCalls.filter((k) => k === 'camera').length, 1, 'WI-7c: go-live acquires the camera ONCE');
  eq(published3[0], 'out:camera', 'WI-7c: go-live publishes the camera as the primary output');

  // HOT-SWAP to the cam+screenshare scene. The brain re-provisions → the diff acquires ONLY
  // the screenshare (the camera is REUSED, not re-acquired), then republishes.
  switchScene('MIX');
  await new Promise((r) => setTimeout(r, 0));
  eq(acquiredCalls.filter((k) => k === 'camera').length, 1, 'WI-7c: the cam→cam+screen switch does NOT re-acquire the camera (maintained source)');
  eq(acquiredCalls.filter((k) => k === 'screen').length, 1, 'WI-7c: the switch acquires ONLY the new screenshare source');
  ok(liveSourceKeys.has('camera') && liveSourceKeys.has('screen'), 'WI-7c: both the maintained camera and the new screenshare are live after the switch');
  ok(republished.length >= 1 && republished[republished.length - 1] !== null, 'WI-7c: the switch republishes a live (non-null) primary output — camera never blanks');

  await s3.endLive();
  eq(s3.getState().status, 'idle', 'WI-7c: endLive returns to idle');
  eq(liveSourceKeys.size, 0, 'WI-7c: end-live releases every shared source');
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${passed} assertions passed`);
