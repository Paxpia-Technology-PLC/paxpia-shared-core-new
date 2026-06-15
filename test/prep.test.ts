// Unit tests for the PRE-JOIN PREP machine (prep.ts): the room-listing manifest
// parser/normalizer, the producer-side deriveManifest, and the clockless
// createEntryPrep state machine — its ordering, the EMPTY-skip, and the MIN-FLOOR
// gate. Same inline assert harness as the sibling tests; runs under Node's native
// TS type-stripping:
//     node --experimental-strip-types test/prep.test.ts
// Exits non-zero on the first failure so it's CI-able without a test dependency.

import {
  parseRoomManifest,
  emptyRoomManifest,
  manifestNeedsPrep,
  deriveManifest,
  roomManifestToWire,
  createEntryPrep,
  beginPrep,
  prepWork,
  onMediaReleased,
  onSettleFloorElapsed,
  onDocsPreloaded,
  isPrepReady,
  isPrepping,
  PREP_MIN_FLOOR_MS,
  type RoomManifest,
  type DeriveScene,
} from '../src/streaming/prep.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

// ── parseRoomManifest: tolerant of missing / malformed → empty ────────────────
{
  eq(parseRoomManifest(undefined), emptyRoomManifest(), 'undefined → empty manifest');
  eq(parseRoomManifest(null), emptyRoomManifest(), 'null → empty manifest');
  eq(parseRoomManifest({}), emptyRoomManifest(), 'no v marker → empty manifest');
  eq(parseRoomManifest({ v: 2, docs: [{ id: 'x' }] }), emptyRoomManifest(), 'wrong version → empty');
  eq(parseRoomManifest({ v: 1, empty: true }), emptyRoomManifest(), 'empty:true → empty manifest');
  // A "non-empty" manifest with nothing to prep normalizes to empty.
  eq(
    parseRoomManifest({ v: 1, empty: false, video_sources: 0, docs: [], overlays: [] }),
    emptyRoomManifest(),
    'nothing to prep → normalized to empty',
  );

  // Snake_case wire (the Go contract) parses fully.
  const wire = {
    v: 1,
    empty: false,
    scene_nonce: 7,
    video_sources: 2,
    audio: true,
    overlays: [{ type: 'poll', id: 'p1' }, 'garbage', { type: '', id: '' }],
    docs: [
      { id: 'd1', kind: 'pdf', url: 'https://x/d1', pages: 12 },
      { id: 'd2', kind: 'image', url: 'https://x/d2' },
      { kind: 'pdf' }, // no id → dropped
    ],
  };
  const m = parseRoomManifest(wire);
  eq(m.sceneNonce, 7, 'scene_nonce parsed from snake_case');
  eq(m.videoSources, 2, 'video_sources parsed');
  eq(m.audio, true, 'audio parsed');
  eq(m.overlays.length, 1, 'malformed/empty overlays dropped (1 valid kept)');
  eq(m.docs.length, 2, 'doc without id dropped (2 valid kept)');
  eq(m.docs[0], { id: 'd1', kind: 'pdf', url: 'https://x/d1', pages: 12 }, 'pdf doc parsed with pages');
  eq(m.docs[1], { id: 'd2', kind: 'image', url: 'https://x/d2' }, 'image doc parsed (no pages)');
  ok(manifestNeedsPrep(m), 'a populated manifest needs prep');
  ok(!manifestNeedsPrep(emptyRoomManifest()), 'the empty manifest needs no prep');
  // String-typed numerics (Redis-hash style) coerce.
  const sm = parseRoomManifest({ v: 1, empty: false, scene_nonce: '3', video_sources: '1', docs: [] });
  eq(sm.sceneNonce, 3, 'string scene_nonce coerced');
  eq(sm.videoSources, 1, 'string video_sources coerced');
}

// ── deriveManifest: PRODUCER builds the v1 manifest from the rendered scene ────
{
  const scene: DeriveScene = {
    items: [
      { type: 'camera' },
      { type: 'screen' },
      { type: 'doc', instanceId: 'd1', docUrl: 'u1', docKind: 'pdf', docPages: 5 },
      { type: 'doc' }, // empty doc slot → not listed
      { type: 'overlay', instanceId: 'ov1', overlayType: 'poll' },
      { type: 'overlay' }, // empty overlay slot → not listed
    ],
  };
  const m = deriveManifest(scene, { audio: true, sceneNonce: 4 });
  eq(m.videoSources, 2, 'derive: camera+screen counted as video sources');
  eq(m.audio, true, 'derive: audio from track config');
  eq(m.sceneNonce, 4, 'derive: scene nonce from track config');
  eq(m.docs, [{ id: 'd1', kind: 'pdf', url: 'u1', pages: 5 }], 'derive: only FILLED doc slots listed');
  eq(m.overlays, [{ type: 'poll', id: 'ov1' }], 'derive: only FILLED overlay slots listed');
  ok(!m.empty, 'derive: a populated scene is not empty');

  // A plain scene (no media, no filled slots) derives the EMPTY manifest.
  const plain = deriveManifest({ items: [{ type: 'doc' }, { type: 'overlay' }] }, { audio: false, sceneNonce: 9 });
  ok(plain.empty, 'derive: a scene with no media + empty slots → empty manifest');
  eq(plain.sceneNonce, 9, 'derive: empty manifest still carries the scene nonce');
  eq(deriveManifest(null, { audio: false, sceneNonce: 0 }).empty, true, 'derive: null scene → empty');

  // Wire round-trip: derive → wire → parse is stable.
  const round = parseRoomManifest(roomManifestToWire(m));
  eq(round.docs, m.docs, 'wire round-trip preserves docs');
  eq(round.overlays, m.overlays, 'wire round-trip preserves overlays');
  eq(round.videoSources, m.videoSources, 'wire round-trip preserves video_sources');
}

// ── createEntryPrep: EMPTY manifest jumps straight to ready (skip prep) ────────
{
  const s = createEntryPrep(emptyRoomManifest());
  ok(isPrepReady(s), 'empty manifest → ready immediately');
  ok(!isPrepping(s), 'empty manifest → not prepping');
  eq(prepWork(s).do, 'connect', 'empty manifest → work is connect');
}

// ── createEntryPrep: ORDERING release → settle → preload → ready ──────────────
{
  const manifest: RoomManifest = {
    v: 1,
    empty: false,
    sceneNonce: 1,
    videoSources: 1,
    audio: false,
    overlays: [],
    docs: [{ id: 'd1', kind: 'pdf', url: 'u1', pages: 3 }],
  };
  let s = createEntryPrep(manifest);
  eq(s.phase, 'fetchedManifest', 'non-empty manifest starts at fetchedManifest');
  ok(!isPrepReady(s), 'not ready at start');

  // FIRST work is to release background media (decoders freed BEFORE the room's).
  const w0 = prepWork(s);
  eq(w0.do, 'releaseMedia', 'first work: release background media');
  ok(w0.do === 'releaseMedia' && w0.videoSources === 1, 'release carries the video-source hint');

  s = beginPrep(s);
  eq(s.phase, 'releasingMedia', 'beginPrep → releasingMedia');

  // The settle/yield beat comes AFTER releasing media (the ordering invariant).
  s = onMediaReleased(s);
  eq(s.phase, 'settling', 'after media released → settling (the yield beat)');
  ok(!isPrepReady(s), 'settling is not ready (min-floor still pending)');
  const wSettle = prepWork(s);
  eq(wSettle.do, 'preload', 'while settling, preload the docs in parallel with the floor');
  ok(wSettle.do === 'preload' && wSettle.docs.length === 1, 'preload carries the manifest docs');

  // Docs finishing FIRST does NOT lift the gate — the min-floor still holds.
  s = onDocsPreloaded(s);
  ok(!isPrepReady(s), 'docs done but min-floor not elapsed → STILL not ready (min-floor holds)');
  ok(s.docsPreloaded, 'docs latch set');

  // The min-floor elapsing is what finally lifts to ready.
  s = onSettleFloorElapsed(s);
  ok(isPrepReady(s), 'docs done AND min-floor elapsed → ready');
  eq(prepWork(s).do, 'connect', 'ready → work is connect');
}

// ── MIN-FLOOR: floor elapsing FIRST surfaces preloading, docs lift to ready ───
{
  const manifest: RoomManifest = {
    v: 1,
    empty: false,
    sceneNonce: 1,
    videoSources: 0,
    audio: false,
    overlays: [],
    docs: [{ id: 'd1', kind: 'image', url: 'u1' }],
  };
  let s = createEntryPrep(manifest);
  s = beginPrep(s);
  s = onMediaReleased(s);
  eq(s.phase, 'settling', 'reached settling');

  // The floor elapses BEFORE the (slow) docs finish → phase reflects "waiting on docs".
  s = onSettleFloorElapsed(s);
  eq(s.phase, 'preloading', 'floor elapsed but docs pending → preloading');
  ok(!isPrepReady(s), 'still gated: docs not done');

  // Docs landing now lifts to ready (the floor already cleared).
  s = onDocsPreloaded(s);
  ok(isPrepReady(s), 'docs done after the floor → ready');
}

// ── MIN-FLOOR is configurable + defaults to PREP_MIN_FLOOR_MS ─────────────────
{
  const m: RoomManifest = { ...emptyRoomManifest(), empty: false, videoSources: 1 };
  eq(createEntryPrep(m).minFloorMs, PREP_MIN_FLOOR_MS, 'default min-floor is PREP_MIN_FLOOR_MS');
  eq(createEntryPrep(m, { minFloorMs: 1500 }).minFloorMs, 1500, 'min-floor is overridable');
  ok(PREP_MIN_FLOOR_MS >= 500, 'default min-floor is a meaningful settle window');
}

// ── A media-only room (no docs) still runs the full prep, gated only on the floor ─
{
  const m: RoomManifest = { ...emptyRoomManifest(), empty: false, videoSources: 2 };
  let s = createEntryPrep(m);
  ok(!isPrepReady(s), 'media-only room still preps (frees decoders)');
  s = beginPrep(s);
  s = onMediaReleased(s);
  eq(s.phase, 'settling', 'media-only → settling');
  eq(prepWork(s).do, 'none', 'no docs → nothing to preload (just hold the floor)');
  s = onSettleFloorElapsed(s);
  ok(isPrepReady(s), 'media-only: floor elapsed (no docs) → ready');
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${passed} assertions passed`);
