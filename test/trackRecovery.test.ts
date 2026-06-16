// Unit tests for the TRACK-RECOVERY video-source gate — the fix that stops a
// "reconnecting video" hint from showing on an audio+doc-only room (the jazz
// docrooms). Asserts:
//   • trackRecoveryPhase / nextTrackRecoveryAction stay inert when the room has NO
//     video source (expectVideo === false), regardless of hasVideo.
//   • the existing video-bearing behavior is unchanged (expectVideo omitted/true).
//   • manifestHasVideoSource / sceneHasVideoSource derive the gate correctly.
//
//     node --experimental-strip-types test/trackRecovery.test.ts

import {
  trackRecoveryPhase,
  nextTrackRecoveryAction,
  DEFAULT_TRACK_RECOVERY_POLICY,
} from '../src/streaming/connection.ts';
import { manifestHasVideoSource, emptyRoomManifest, parseRoomManifest } from '../src/streaming/prep.ts';
import { sceneHasVideoSource } from '../src/streaming/live.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}

const POLICY = DEFAULT_TRACK_RECOVERY_POLICY;

// ── phase: audio+doc-only room (no video source) is always 'ok' while connected ──
{
  ok(
    trackRecoveryPhase({ connected: true, hasVideo: false, expectVideo: false }) === 'ok',
    'connected, no video, no video source → ok (never recovering)',
  );
  ok(
    trackRecoveryPhase({ connected: true, hasVideo: false, expectVideo: true }) === 'recovering',
    'connected, no video, HAS video source → recovering',
  );
  ok(
    trackRecoveryPhase({ connected: true, hasVideo: false }) === 'recovering',
    'expectVideo omitted defaults to true (unchanged legacy behavior)',
  );
  ok(
    trackRecoveryPhase({ connected: true, hasVideo: true, expectVideo: true }) === 'ok',
    'connected with video → ok',
  );
  ok(
    trackRecoveryPhase({ connected: false, hasVideo: false, expectVideo: false }) === 'idle',
    'disconnected → idle (disconnect axis owns it)',
  );
}

// ── action: no video source → never nudges a re-subscribe ─────────────────────
{
  // Even past the grace window with budget remaining, a no-video-source room does nothing.
  ok(
    nextTrackRecoveryAction({
      connected: true, hasVideo: false, expectVideo: false,
      msSinceVideoLost: POLICY.graceMs + 10_000, resubscribesSpent: 0, policy: POLICY,
    }) === 'none',
    'no video source past grace → none (no resubscribe spin)',
  );
  // A real video room past grace with budget → resubscribe (unchanged).
  ok(
    nextTrackRecoveryAction({
      connected: true, hasVideo: false, expectVideo: true,
      msSinceVideoLost: POLICY.graceMs + 100, resubscribesSpent: 0, policy: POLICY,
    }) === 'resubscribe',
    'video room past grace with budget → resubscribe',
  );
  // Inside grace → wait (unchanged).
  ok(
    nextTrackRecoveryAction({
      connected: true, hasVideo: false, expectVideo: true,
      msSinceVideoLost: 0, resubscribesSpent: 0, policy: POLICY,
    }) === 'wait',
    'video room inside grace → wait',
  );
}

// ── helpers: manifest + scene video-source detection ──────────────────────────
{
  ok(manifestHasVideoSource(emptyRoomManifest()) === false, 'empty manifest → no video source');
  ok(manifestHasVideoSource(null) === false, 'null manifest → no video source');
  ok(manifestHasVideoSource(undefined) === false, 'undefined manifest → no video source');

  // A doc-only listing manifest (videoSources:0, has a doc) → no video source.
  const docOnly = parseRoomManifest({ v: 1, video_sources: 0, audio: true, docs: [{ id: 'd', kind: 'pdf', url: 'u' }] });
  ok(manifestHasVideoSource(docOnly) === false, 'audio+doc-only manifest → no video source');

  // A camera room → has a video source.
  const cam = parseRoomManifest({ v: 1, video_sources: 1, audio: true, overlays: [], docs: [] });
  ok(manifestHasVideoSource(cam) === true, 'camera manifest → has video source');

  // Scene-based detection.
  ok(sceneHasVideoSource(null) === false, 'null scene → no video source');
  ok(
    sceneHasVideoSource({ id: 's', name: 'n', items: [{ id: 'i', type: 'doc', rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0, fit: 'contain' }] }) === false,
    'doc-only scene → no video source',
  );
  ok(
    sceneHasVideoSource({ id: 's', name: 'n', items: [{ id: 'i', type: 'camera', rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0, fit: 'cover' }] }) === true,
    'camera scene → has video source',
  );
  ok(
    sceneHasVideoSource({ id: 's', name: 'n', items: [{ id: 'i', type: 'screen', rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0, fit: 'contain' }] }) === true,
    'screen scene → has video source',
  );
}

if (failures.length) {
  console.error(`trackRecovery: ${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`trackRecovery: ${passed} passed`);
