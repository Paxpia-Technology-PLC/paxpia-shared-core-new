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
  type ServedDocs,
} from '../src/director/logic.ts';
import { createDirectorSession } from '../src/director/session.ts';
import type {
  DirectorDeps,
  DirectorMedia,
  DirectorTransport,
  DirectorRoomHandle,
  DirectorMaterial,
  DirectorPreloadCache,
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
      transport: undefined as never,
    };
    let changedCb: ((e: { overlay: OverlayInstance | null }) => void) | null = null;
    let participantCb: (() => void) | null = null;
    rec.transport = {
      publishLiveSync: () => void (rec.liveSyncs += 1),
      publishScene: () => void (rec.scenes += 1),
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

  const scenesStore = makeScenesStore([sceneA, sceneB], 'A');
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

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${passed} assertions passed`);
