// Unit tests for TASK B — `LwwSyncSource` (syncSource.ts). The point of the test is
// PARITY: the source's `ingest`/`getState` must converge to the EXACT same
// `ViewerState` the legacy pure reducers (applyLiveSync/applySceneSync/
// applyOverlayChanged) produce when fed the same decoded events. We also exercise
// the producer direction (`localMutate`) + the reconnect plan (`onReconnect`).
//
// Runs under Node's native TS type-stripping (same harness as the sibling tests):
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/syncSource.test.ts

import {
  LwwSyncSource,
  createLwwSyncSource,
  foldEvent,
} from '../src/streaming/syncSource.ts';
import {
  initialViewerState,
  applyLiveSync,
  applySceneSync,
  applyOverlayChanged,
  type ViewerState,
} from '../src/streaming/viewer.ts';
import { buildRenderedScene, decodeSceneSyncMsg, type RenderedScene } from '../src/streaming/scene.ts';
import { decodeLiveSyncMsg } from '../src/streaming/live.ts';
import { decodeOverlayChannelMsg, type OverlayChannelEvent } from '../src/overlays/consume.ts';
import type { LiveScene, LiveSyncMsg, LiveManifest } from '../src/streaming/live.ts';
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

// ── fixtures ──────────────────────────────────────────────────────────────────
const doc = (id: string, page = 0): OverlayInstance => ({
  id,
  kind: 'doc',
  phase: 'active',
  gen: 1,
  payload: { title: id, pages: [], page },
});
const poll = (id: string, gen = 1): OverlayInstance => ({
  id,
  kind: 'poll',
  phase: 'active',
  gen,
  payload: { question: id, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
});
const sceneA: LiveScene = {
  id: 'A',
  name: 'A',
  items: [
    { id: 'a-doc', type: 'doc', rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, z: 0, fit: 'contain' },
    { id: 'a-ov', type: 'overlay', rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 }, z: 1, fit: 'contain' },
  ],
};
const manifest: LiveManifest = {
  entries: [{ id: 'd1', filename: 'd1.pdf', mime: 'application/pdf', sizeBytes: 100, url: 'https://x/d1?token=1' }],
  totalSizeBytes: 100,
  count: 1,
};
const renderedA: RenderedScene = buildRenderedScene(sceneA, 1, () => null);

// Build the three decoded event arms the source ingests.
const liveSyncEv: OverlayChannelEvent = {
  kind: 'live.sync',
  msg: { t: 'live.sync', v: 1, sceneId: 'A', scene: sceneA, doc: doc('d1'), manifest } as LiveSyncMsg,
};
const sceneSyncEv: OverlayChannelEvent = { kind: 'scene.sync', msg: { t: 'scene.sync', v: 1, scene: renderedA } };
const overlayChangedEv: OverlayChannelEvent = {
  kind: 'overlay.changed',
  msg: { t: 'overlay.changed', v: 1, roomName: 'r', overlay: poll('p1') },
};

// ── foldEvent === the legacy reducers (the ingest routing table) ───────────────
{
  const base = initialViewerState();
  eq(foldEvent(base, liveSyncEv), applyLiveSync(base, liveSyncEv.msg), 'foldEvent live.sync === applyLiveSync');
  eq(
    foldEvent(base, sceneSyncEv),
    applySceneSync(base, renderedA),
    'foldEvent scene.sync === applySceneSync',
  );
  eq(
    foldEvent(base, overlayChangedEv),
    applyOverlayChanged(base, poll('p1')),
    'foldEvent overlay.changed === applyOverlayChanged',
  );
  // Non-converging arms (results/response/control/svg/unsupported) leave state by ref.
  ok(foldEvent(base, { kind: 'unsupported', t: 'x' }) === base, 'unsupported → state unchanged (by ref)');
  ok(
    foldEvent(base, { kind: 'overlay.results', msg: { t: 'overlay.results', v: 1, roomName: 'r', overlayId: 'p1', gen: 1, phase: 'active', tallies: {}, total: 0 } }) === base,
    'overlay.results → state unchanged (votes fold elsewhere)',
  );
}

// ── LwwSyncSource.ingest converges identically to a manual reducer fold ─────────
{
  const src = createLwwSyncSource();
  // Drive the SAME events through the source...
  src.ingest(liveSyncEv, 1000);
  src.ingest(sceneSyncEv, 1001);
  src.ingest(overlayChangedEv, 1002);
  // ...and through the bare reducers, in order.
  let manual: ViewerState = initialViewerState();
  manual = applyLiveSync(manual, liveSyncEv.msg);
  manual = applySceneSync(manual, renderedA);
  manual = applyOverlayChanged(manual, poll('p1'));
  eq(src.getState(), manual, 'source.getState() === manual reducer fold (full parity)');
}

// ── subscribe: notified on a converging change, coalesced on a stale/no-op ──────
{
  const src = createLwwSyncSource();
  let notifications = 0;
  let last: ViewerState | null = null;
  const off = src.subscribe((s) => {
    notifications++;
    last = s;
  });
  src.ingest(sceneSyncEv, 1); // nonce 1 — converges
  ok(notifications === 1, 'subscribe: notified once on a converging fold');
  ok(last === src.getState(), 'subscribe: receives the converged state');
  // A STALE scene.sync (nonce 1 again with an OLDER nonce-0 scene) is a no-op → no notify.
  src.ingest({ kind: 'scene.sync', msg: { t: 'scene.sync', v: 1, scene: { sceneId: 'A', nonce: 0, overlays: [] } } }, 2);
  ok(notifications === 1, 'subscribe: a stale (lower-nonce) scene.sync coalesces to zero notifications');
  // unsupported event → no notify.
  src.ingest({ kind: 'unsupported' }, 3);
  ok(notifications === 1, 'subscribe: an unsupported event never notifies');
  off();
  src.ingest(overlayChangedEv, 4);
  ok(notifications === 1, 'subscribe: no notification after unsubscribe');
}

// ── localMutate(set-scene): produces a scene.sync outbound + folds locally ──────
{
  const src = createLwwSyncSource();
  const out = src.localMutate({ kind: 'set-scene', scene: renderedA });
  ok(out.length === 1, 'set-scene → one outbound');
  const decoded = decodeSceneSyncMsg(out[0].bytes);
  ok(!!decoded && decoded.t === 'scene.sync', 'set-scene outbound decodes as scene.sync');
  ok((decoded!.scene.nonce ?? 0) >= 1, 'set-scene stamps a monotonic nonce (≥1)');
  // The producer paints from getState() too → its rendered layer reflects the scene.
  eq(src.getState().rendered.sceneId, 'A', 'set-scene folds into local converged state');
  // A second set-scene bumps the nonce monotonically (so a viewer accepts both).
  const out2 = src.localMutate({ kind: 'set-scene', scene: renderedA });
  const decoded2 = decodeSceneSyncMsg(out2[0].bytes);
  ok(decoded2!.scene.nonce > decoded!.scene.nonce, 'set-scene bumps nonce monotonically across calls');
}

// ── localMutate(set-doc / set-manifest): produces a live.sync outbound ──────────
{
  const src = createLwwSyncSource();
  src.localMutate({ kind: 'set-live-scene', scene: sceneA });
  const out = src.localMutate({ kind: 'set-doc', doc: doc('d1', 2) });
  const decoded = decodeLiveSyncMsg(out[0].bytes) as LiveSyncMsg | null;
  ok(!!decoded && decoded.t === 'live.sync', 'set-doc outbound decodes as live.sync');
  eq(decoded!.doc?.id, 'd1', 'set-doc live.sync carries the doc');
  // The local converged state reflects the doc slot too.
  eq(src.getState().slots.activeDoc?.id, 'd1', 'set-doc folds into the local doc slot');

  // set-manifest dedupes a re-granted presigned url before it rides the wire.
  const dupManifest: LiveManifest = {
    entries: [
      { id: 'd1', filename: 'd1.pdf', mime: 'application/pdf', sizeBytes: 100, url: 'https://x/d1?token=1' },
      { id: 'd1b', filename: 'd1.pdf', mime: 'application/pdf', sizeBytes: 100, url: 'https://x/d1?token=2' },
    ],
    totalSizeBytes: 200,
    count: 2,
  };
  const outM = src.localMutate({ kind: 'set-manifest', manifest: dupManifest });
  const decodedM = decodeLiveSyncMsg(outM[0].bytes) as LiveSyncMsg | null;
  eq(decodedM!.manifest?.entries.length, 1, 'set-manifest dedupes the re-granted same-path entry');
}

// ── localMutate(end-live): the {doc:null,scene:null} wipe ───────────────────────
{
  const src = createLwwSyncSource();
  src.localMutate({ kind: 'set-live-scene', scene: sceneA });
  src.localMutate({ kind: 'set-doc', doc: doc('d1') });
  const out = src.localMutate({ kind: 'end-live' });
  const decoded = decodeLiveSyncMsg(out[0].bytes) as LiveSyncMsg | null;
  eq(decoded!.doc, null, 'end-live broadcasts doc:null');
  eq(decoded!.scene, null, 'end-live broadcasts scene:null');
}

// ── onReconnect: a CONSUMER re-requests state; a PRODUCER also replays its scene ─
{
  // Pure consumer (never mutated) → requestState true, empty replay.
  const consumer = createLwwSyncSource();
  const planC = consumer.onReconnect();
  ok(planC.requestState === true, 'consumer onReconnect requests state');
  eq(planC.replay.length, 0, 'consumer onReconnect has an empty replay (nothing to re-broadcast)');

  // Producer (set a scene + doc) → replay carries scene.sync + live.sync.
  const producer = createLwwSyncSource();
  producer.localMutate({ kind: 'set-scene', scene: renderedA });
  producer.localMutate({ kind: 'set-live-scene', scene: sceneA });
  producer.localMutate({ kind: 'set-doc', doc: doc('d1') });
  producer.localMutate({ kind: 'set-manifest', manifest });
  const planP = producer.onReconnect();
  ok(planP.requestState === true, 'producer onReconnect still requests state');
  ok(planP.replay.length >= 2, 'producer onReconnect replays scene.sync + live.sync');
  const kinds = planP.replay.map((o) => {
    const ev = decodeOverlayChannelMsg(o.bytes);
    return ev.kind;
  });
  ok(kinds.includes('scene.sync'), 'producer replay includes a scene.sync');
  ok(kinds.includes('live.sync'), 'producer replay includes a live.sync');
}

// ── ingest is decoder-faithful: bytes → decodeOverlayChannelMsg → ingest ────────
{
  const src = createLwwSyncSource();
  // Build a real scene.sync byte payload and decode it the way the platform binding
  // would, then ingest — the source converges exactly as the typed-event path did.
  const { encodeSceneSyncMsg } = await import('../src/streaming/scene.ts');
  const bytes = encodeSceneSyncMsg({ t: 'scene.sync', v: 1, scene: renderedA });
  const ev = decodeOverlayChannelMsg(bytes);
  src.ingest(ev, 1);
  eq(src.getState().rendered.sceneId, 'A', 'ingest(decodeOverlayChannelMsg(bytes)) converges the scene');
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${passed} assertions passed`);
