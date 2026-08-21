// BACKGROUND POLICY — what a live session should do when the app leaves the foreground.
//
// ── The bug this replaces ────────────────────────────────────────────────────
// The RN room hook used to tear the whole room down on ANY AppState transition away
// from 'active', for every mode. That was a blunt fix for real "audio never stops"
// reports, and it defeated infrastructure built for the opposite behaviour:
//   • Android: a foreground service is started with camera|microphone|mediaPlayback
//     types specifically so capture and playback SURVIVE backgrounding;
//   • iOS: UIBackgroundModes declares `audio` for the same reason.
// So a host who switched apps or took a phone call dropped their broadcast — and
// because the teardown path doesn't call endRoom, the server kept listing the room as
// live with no publisher behind it.
//
// The two ORIGINAL ghost-audio causes are both addressed elsewhere now, which is what
// makes removing that teardown safe:
//   1. navigating away without teardown → the hook's unconditional, idempotent
//      teardown on unmount;
//   2. a Metro reload orphaning a Room in a dead JS context → resetLiveNativeState()
//      at boot (which, until WI-1, was written but never actually called).
//
// ── Why iOS cannot simply "keep broadcasting" ────────────────────────────────
// iOS STOPS AVCaptureSession when an app backgrounds. There is no entitlement that
// changes this; `UIBackgroundModes: audio` keeps AUDIO running, not capture. So the
// honest behaviour for a backgrounded iOS host is: keep the room and the mic, drop the
// video, and republish video on resume. This is what Instagram Live and Zoom do.
//
// Pure and platform-agnostic so the decision is testable without a device, and so web
// (which has its own visibilitychange story) can adopt the same model later.

/** What to do when the app leaves the foreground. */
export type BackgroundAction =
  /** Stay fully connected and keep publishing/subscribing as-is. */
  | 'keep'
  /** Stay connected, keep the mic, but stop sending video; resume it on foreground. */
  | 'suspend-video'
  /** Disconnect the room entirely. */
  | 'disconnect';

export interface BackgroundInput {
  /** The room's role. 'preview' is a silent, uncounted, throwaway tile. */
  mode: 'publish' | 'view' | 'preview' | 'call';
  platform: 'ios' | 'android';
  /**
   * Whether the Android live foreground service is ACTUALLY running (not merely
   * requested). Android kills camera capture for a backgrounded app without a running
   * FGS of the right type, so if it failed to start we must not pretend we are still
   * broadcasting video — publishing a frozen frame while claiming to be live is worse
   * than an honest suspend. Ignored on iOS.
   */
  hasForegroundService: boolean;
}

/**
 * Decide what a backgrounding live session should do.
 *
 * Deliberately total (every mode × platform maps to something) so a new mode can't
 * silently fall through to a default that happens to disconnect a broadcast.
 */
export function backgroundPolicy(i: BackgroundInput): BackgroundAction {
  // Silent preview tiles are throwaway: nothing is playing, nobody is counted, and a
  // backgrounded app has no visible tiles to feed. Drop them and reclaim the decoders.
  if (i.mode === 'preview') return 'disconnect';

  // Publishing roles: the whole point is that the broadcast survives.
  if (i.mode === 'publish' || i.mode === 'call') {
    // iOS: capture is stopped by the OS regardless of what we do.
    if (i.platform === 'ios') return 'suspend-video';
    // Android: video survives ONLY behind a running foreground service.
    return i.hasForegroundService ? 'keep' : 'suspend-video';
  }

  // A viewer keeps playing: background audio is the feature, not a leak. The room is
  // still torn down on unmount (leaving the screen) and on app boot after a reload —
  // that is where "audio must stop" is enforced, and it is enforced unconditionally.
  return 'keep';
}

/**
 * Whether returning to the foreground needs the video track re-established.
 *
 * Split from the background decision because the resume side has a different question:
 * not "what should we stop" but "did we stop something we now have to rebuild". Keeping
 * it explicit avoids the pattern where a resume path infers what happened from
 * scattered flags and gets it wrong after a policy change.
 */
export function needsVideoResume(actionTaken: BackgroundAction): boolean {
  return actionTaken === 'suspend-video';
}
