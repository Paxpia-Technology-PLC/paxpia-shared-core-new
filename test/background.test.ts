// Unit tests for the BACKGROUND POLICY — what a live session does when the app leaves
// the foreground (WI-4).
//
// The regression this guards: before WI-4 the RN room hook tore the room down on ANY
// AppState transition away from 'active', for EVERY mode. A host who switched apps or
// took a phone call dropped their broadcast — while the Android foreground service and
// the iOS `audio` background mode, both added specifically to prevent that, sat unused.
// And because that teardown path never called endRoom, the server kept listing the room
// as live with no publisher behind it.
//
//     node --experimental-strip-types test/background.test.ts

import { backgroundPolicy, needsVideoResume } from '../src/streaming/background.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}

const ANDROID_FGS = { platform: 'android' as const, hasForegroundService: true };
const ANDROID_NO_FGS = { platform: 'android' as const, hasForegroundService: false };
const IOS = { platform: 'ios' as const, hasForegroundService: false };

// ── hosts keep broadcasting ───────────────────────────────────────────────────
{
  ok(
    backgroundPolicy({ mode: 'publish', ...ANDROID_FGS }) === 'keep',
    'android host behind a running FGS stays fully live',
  );
  // Not a compromise we picked: iOS stops AVCaptureSession for a backgrounded app and
  // no entitlement changes it. UIBackgroundModes `audio` keeps AUDIO, not capture.
  ok(
    backgroundPolicy({ mode: 'publish', ...IOS }) === 'suspend-video',
    'ios host keeps room + mic and suspends video',
  );
  // Publishing a frozen frame while claiming to be live is worse than an honest
  // suspend, and Android kills capture for a backgrounded app with no FGS.
  ok(
    backgroundPolicy({ mode: 'publish', ...ANDROID_NO_FGS }) === 'suspend-video',
    'android host degrades to suspend-video when the FGS is not actually running',
  );
  ok(
    backgroundPolicy({ mode: 'call', ...ANDROID_FGS }) === 'keep',
    'call behind a running FGS stays fully live',
  );
}

// ── a publishing role is NEVER disconnected ───────────────────────────────────
{
  let everDisconnected = false;
  for (const platform of ['ios', 'android'] as const) {
    for (const hasForegroundService of [true, false]) {
      for (const mode of ['publish', 'call'] as const) {
        if (backgroundPolicy({ mode, platform, hasForegroundService }) === 'disconnect') {
          everDisconnected = true;
        }
      }
    }
  }
  ok(!everDisconnected, 'no publishing role is ever disconnected on backgrounding');
}

// ── viewers and previews ──────────────────────────────────────────────────────
{
  // Background audio is the FEATURE for a viewer. "Audio must stop" is enforced on
  // unmount (leaving the screen) and at app boot after a reload — unconditionally, in
  // both cases — not by dropping the room whenever the user checks another app.
  ok(backgroundPolicy({ mode: 'view', ...IOS }) === 'keep', 'ios viewer keeps playing');
  ok(backgroundPolicy({ mode: 'view', ...ANDROID_FGS }) === 'keep', 'android viewer keeps playing');
  // Silent, uncounted, throwaway: a backgrounded app has no visible tiles to feed, so
  // holding the decoders open is pure cost.
  ok(backgroundPolicy({ mode: 'preview', ...IOS }) === 'disconnect', 'ios preview disconnects');
  ok(backgroundPolicy({ mode: 'preview', ...ANDROID_FGS }) === 'disconnect', 'android preview disconnects');
}

// ── totality: no mode can fall through to an accidental default ───────────────
{
  const allowed = new Set(['keep', 'suspend-video', 'disconnect']);
  let allDefined = true;
  for (const mode of ['publish', 'view', 'preview', 'call'] as const) {
    for (const platform of ['ios', 'android'] as const) {
      for (const hasForegroundService of [true, false]) {
        if (!allowed.has(backgroundPolicy({ mode, platform, hasForegroundService }))) {
          allDefined = false;
        }
      }
    }
  }
  ok(allDefined, 'every mode x platform x fgs combination maps to a defined action');
}

// ── resume gate ───────────────────────────────────────────────────────────────
{
  ok(needsVideoResume('suspend-video') === true, 'suspend-video needs a video resume');
  ok(needsVideoResume('keep') === false, 'keep needs no video resume');
  ok(needsVideoResume('disconnect') === false, 'disconnect needs no video resume');
}

if (failures.length) {
  console.error(`background: ${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`background: ${passed} passed`);
