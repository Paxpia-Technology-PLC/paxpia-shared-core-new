// Unit tests for TASK D — the pure GATE MACHINE (gate.ts): the two-checklist
// sequencing (visible: join-room/download; hidden: reclaim-decoders/subscribe-tracks/
// mute-applied/manifest-ready/first-snapshot), `canHandOff` ONLY when every step is
// done, the `mute-applied` pre-session step, and — the headline — the
// `expectVideo:false` branch (audio-only rooms pass on audio + manifest alone; the
// video-less boot-loop fix). PURE: no timers/SDK, the driver feeds completion events.
//
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/gate.test.ts

import {
  deriveExpectVideo,
  buildGateSteps,
  initialGateState,
  gateTransition,
  createGate,
  canGateHandOff,
  type GateMachine,
  type GateEvent,
  type GateStepId,
  type GateReadinessSignals,
} from '../src/streaming/gate.ts';
import { emptyRoomManifest, type RoomManifest } from '../src/streaming/prep.ts';
import type { LiveScene } from '../src/streaming/live.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

const stepStatus = (m: GateMachine, id: GateStepId) => m.steps.find((s) => s.id === id)?.status;
const apply = (m: GateMachine, ...evs: GateEvent[]): GateMachine => evs.reduce(gateTransition, m);
const sig = (s: Partial<GateReadinessSignals>): GateReadinessSignals => ({
  hasAudio: false,
  hasVideo: false,
  firstSnapshot: false,
  ...s,
});

// ── deriveExpectVideo: manifest OR scene declaring a video source ──────────────
{
  const videoManifest: RoomManifest = { ...emptyRoomManifest(), empty: false, videoSources: 1 };
  const audioManifest: RoomManifest = { ...emptyRoomManifest(), empty: false, videoSources: 0, audio: true, docs: [{ id: 'd', kind: 'pdf' }] };
  const videoScene: LiveScene = { id: 's', name: 's', items: [{ id: 'cam', type: 'camera', rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0, fit: 'cover' }] };
  const docScene: LiveScene = { id: 's', name: 's', items: [{ id: 'd', type: 'doc', rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0, fit: 'contain' }] };

  ok(deriveExpectVideo(videoManifest, null) === true, 'manifest with a video source → expectVideo true');
  ok(deriveExpectVideo(null, videoScene) === true, 'scene with a camera → expectVideo true');
  ok(deriveExpectVideo(audioManifest, docScene) === false, 'audio+doc-only manifest+scene → expectVideo false');
  ok(deriveExpectVideo(null, null) === false, 'no manifest + no scene → expectVideo false (no positive signal)');
  ok(deriveExpectVideo(emptyRoomManifest(), null) === false, 'empty manifest → expectVideo false');
}

// ── step set is FIXED: 2 visible + 5 hidden, all pending, download has progress ─
{
  const steps = buildGateSteps();
  eq(steps.length, 7, 'gate has 7 steps (2 visible + 5 hidden)');
  eq(steps.filter((s) => s.visible).map((s) => s.id), ['join-room', 'download'], 'visible checklist = join-room, download');
  eq(
    steps.filter((s) => !s.visible).map((s) => s.id),
    ['reclaim-decoders', 'subscribe-tracks', 'mute-applied', 'manifest-ready', 'first-snapshot'],
    'hidden checklist = reclaim-decoders, subscribe-tracks, mute-applied, manifest-ready, first-snapshot',
  );
  ok(steps.every((s) => s.status === 'pending'), 'all steps start pending');
  eq(steps.find((s) => s.id === 'download')?.progress, 0, 'download step carries a 0 progress');
}

// ── initial machine: prepping, no hand-off ──────────────────────────────────────
{
  const m = initialGateState(true);
  eq(m.phase, 'prepping', 'gate starts in prepping (pre-connect beat)');
  ok(!m.canHandOff, 'gate cannot hand off at start');
}

// ── FULL video path: every step must be done before hand-off ────────────────────
{
  let m = initialGateState(/* expectVideo */ true);
  m = apply(m, { type: 'prep-done' });
  eq(m.phase, 'connecting', 'prep-done → connecting');
  eq(stepStatus(m, 'join-room'), 'active', 'prep-done marks join-room active');

  m = apply(m, { type: 'joined' });
  eq(stepStatus(m, 'join-room'), 'done', 'joined → join-room done');
  ok(!m.canHandOff, 'join alone does not hand off');

  // Download reaches 100% — but that ALONE never hands off (the §5a rule).
  m = apply(m, { type: 'download-progress', progress: 1 });
  eq(stepStatus(m, 'download'), 'active', '100% download keeps the step active (download-done is authoritative)');
  ok(!m.canHandOff, '100% download alone does NOT hand off');
  m = apply(m, { type: 'download-done' });
  eq(stepStatus(m, 'download'), 'done', 'download-done → download done');

  m = apply(m, { type: 'decoders-reclaimed' }, { type: 'manifest-ready' }, { type: 'mute-applied' });
  ok(!m.canHandOff, 'still gated on subscribe-tracks + first-snapshot');

  // Readiness with audio but NO video yet → subscribe-tracks NOT done (expectVideo true).
  m = apply(m, { type: 'readiness', signals: sig({ hasAudio: true, hasVideo: false, firstSnapshot: true }) });
  eq(stepStatus(m, 'subscribe-tracks'), 'active', 'video room: audio-only readiness keeps subscribe-tracks active');
  eq(stepStatus(m, 'first-snapshot'), 'done', 'first-snapshot done on the snapshot signal');
  ok(!m.canHandOff, 'video room: cannot hand off until video subscribes');

  // Video arrives → subscribe-tracks done → ALL steps done → hand off.
  m = apply(m, { type: 'readiness', signals: sig({ hasAudio: true, hasVideo: true, firstSnapshot: true }) });
  eq(stepStatus(m, 'subscribe-tracks'), 'done', 'video room: subscribe-tracks done once audio+video subscribe');
  ok(m.canHandOff, 'video room: hand off ONLY when every step (incl. video) is done');
  eq(m.phase, 'ready', 'all steps done → phase ready');
  ok(canGateHandOff(m), 'canGateHandOff agrees');
}

// ── VIDEO-LESS path: audio-only room hands off WITHOUT a video track ─────────────
// THE boot-loop fix: an audio-only/jazz docroom must pass on audio + manifest +
// first-snapshot alone — never blocking on a video track that will never arrive.
{
  let m = createGate({ manifest: { ...emptyRoomManifest(), empty: false, videoSources: 0, audio: true, docs: [{ id: 'd', kind: 'pdf' }] } });
  ok(m.expectVideo === false, 'audio-only room → expectVideo false');

  m = apply(
    m,
    { type: 'prep-done' },
    { type: 'joined' },
    { type: 'download-done' },
    { type: 'decoders-reclaimed' },
    { type: 'manifest-ready' },
    { type: 'mute-applied' },
  );
  ok(!m.canHandOff, 'audio-only: still gated on subscribe-tracks + first-snapshot');

  // Readiness with audio + first-snapshot but NO video → subscribe-tracks DONE
  // (video-less branch) → ALL steps done → HAND OFF. No video ever needed.
  m = apply(m, { type: 'readiness', signals: sig({ hasAudio: true, hasVideo: false, firstSnapshot: true }) });
  eq(stepStatus(m, 'subscribe-tracks'), 'done', 'audio-only: subscribe-tracks done on AUDIO ALONE (no video wait)');
  ok(m.canHandOff, 'audio-only room HANDS OFF without a video track (the boot-loop fix)');
  eq(m.phase, 'ready', 'audio-only: ready once all steps (sans video) are done');
}

// ── mute-applied is a REQUIRED pre-session step (no hand-off without it) ─────────
{
  let m = createGate({ manifest: { ...emptyRoomManifest(), empty: false, videoSources: 0, audio: true } });
  m = apply(
    m,
    { type: 'prep-done' },
    { type: 'joined' },
    { type: 'download-done' },
    { type: 'decoders-reclaimed' },
    { type: 'manifest-ready' },
    { type: 'readiness', signals: sig({ hasAudio: true, firstSnapshot: true }) },
  );
  eq(stepStatus(m, 'mute-applied'), 'pending', 'mute-applied still pending');
  ok(!m.canHandOff, 'cannot hand off until mute is applied pre-session');
  m = apply(m, { type: 'mute-applied' });
  ok(m.canHandOff, 'mute applied → now every step is done → hand off');
}

// ── failed is terminal: no hand-off, further events are no-ops ───────────────────
{
  let m = initialGateState(false);
  m = apply(m, { type: 'prep-done' }, { type: 'failed' });
  eq(m.phase, 'failed', 'failed → phase failed');
  ok(!m.canHandOff, 'failed → no hand-off');
  // Subsequent completion events cannot resurrect a failed gate.
  const after = apply(m, { type: 'joined' }, { type: 'download-done' }, { type: 'readiness', signals: sig({ hasAudio: true, hasVideo: true, firstSnapshot: true }) });
  ok(after === m, 'failed is terminal — later events are no-ops (by ref)');
}

// ── stable identity: a no-op event returns the SAME machine (React-dep friendly) ─
{
  let m = initialGateState(true);
  m = apply(m, { type: 'prep-done' }, { type: 'joined' });
  const same = gateTransition(m, { type: 'joined' }); // already done → no change
  ok(same === m, 'a redundant completion event returns the same machine instance');
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${passed} assertions passed`);
