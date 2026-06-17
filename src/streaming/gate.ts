// THE CONSOLIDATED ENTRY GATE — ONE lifecycle controller (§5). The gate is a
// lifecycle MANAGER, not a screen: it owns clean-up → connect → A/V readiness →
// hand-off, with LiveKit wired BEHIND it (never `autoConnect` into a screen).
//
// ── What this composes ───────────────────────────────────────────────────────
// There are already TWO core gate machines (`prep.ts` = pre-connect
// release/settle/preload; `entry.ts` = in-room manifest/first-snapshot wait) plus
// a predicate (`shouldGateSurface`). They're correct but un-unified at the DRIVER
// level. This module introduces ONE headless gate controller that sequences both
// and exposes ONE checklist + ONE `ready` hand-off. The two checklists (VISIBLE
// loading steps vs HIDDEN readiness gates) are one machine: 100% download ≠ go —
// only `canHandOff` (ALL steps, visible AND hidden) hands off.
//
// `expectVideo:false` (derived from `manifestHasVideoSource`/`sceneHasVideoSource`,
// already core) makes video-less / audio-only rooms a FIRST-CLASS shape: the gate
// OMITS the video-subscribe/first-video hidden steps and passes on audio + manifest
// readiness alone — THE fix for the audio-only/jazz docroom boot-loop. Mute is a
// gate STEP (`mute-applied`), applied to the output BEFORE the session, so it never
// affects room lifecycle (§7a).
//
// ── SCOPE: TASK A — TYPES ONLY ───────────────────────────────────────────────
// This file is the SHARED INTERFACE scaffolding. It exports the TYPES the gate
// machine and its platform adapter speak (`GateStepId`/`GateStep`/`GateState`/
// `GateAdapter`/`GateConnectOpts`/`GateReadinessSignals`) so every other build
// agent compiles against them in parallel. The machine IMPLEMENTATION (the
// transitions composing prep.ts + entry.ts + connection.ts, the two-checklist
// sequencing, the `expectVideo` branch, the `mute-applied` step) is **Task D** —
// see the TODO marker below. No function/machine is exported here yet.
//
// PURE: type-only module. References existing core types + the thin transport
// interfaces only. No DOM/RN/SDK, no `livekit-client` (hard rule #2).

import type { ManifestEntry } from './live';
import type { ViewerRoomOptions, ViewerConnectOptions } from './join';
import type { RoomHandle } from './transport';
import { manifestHasVideoSource } from './prep';
import type { RoomManifest } from './prep';
import { sceneHasVideoSource } from './live';
import type { LiveScene } from './live';

/** The minimal cancellation-signal shape the gate's `preloadMaterial` honors,
 *  structurally satisfied by the DOM/Node `AbortSignal`. Declared locally so core
 *  stays on the `ES2020` lib (no DOM types) per the no-DOM hard rule — the platform
 *  passes a real `AbortSignal`, which is assignable to this. */
export interface AbortLike {
  readonly aborted: boolean;
  addEventListener?(type: 'abort', listener: () => void): void;
  removeEventListener?(type: 'abort', listener: () => void): void;
}

/** The ordered set of gate steps. VISIBLE steps render in the loading UI (turn
 *  green + ✓ as they complete); HIDDEN steps gate `canHandOff` but don't clutter
 *  the UI. See `GateStep.visible` for which is which.
 *    • pre-connect (prep.ts): release-media → settle → preload
 *    • join-room: LiveKit signaling/connect (VISIBLE)
 *    • download: manifest material download (VISIBLE, real %)
 *    • reclaim-decoders: HIDDEN platform check (RN-only; web no-ops)
 *    • subscribe-tracks / mute-applied: HIDDEN A/V readiness
 *    • manifest-ready / first-snapshot: HIDDEN sync readiness */
export type GateStepId =
  | 'release-media'
  | 'settle'
  | 'preload'
  | 'join-room'
  | 'download'
  | 'reclaim-decoders'
  | 'subscribe-tracks'
  | 'mute-applied'
  | 'manifest-ready'
  | 'first-snapshot';

/** One step in the gate's checklist. `visible:true` ⇒ rendered in the loading
 *  shell (the green-✓ list); `visible:false` ⇒ a hidden readiness gate. `progress`
 *  (0..1) is set only for `download` (the real, smoothed HEAD-size %). */
export interface GateStep {
  id: GateStepId;
  label: string;
  visible: boolean;
  status: 'pending' | 'active' | 'done';
  /** 0..1 — present for `download` (real %, HEAD-size denominator). */
  progress?: number;
}

/** The gate's complete state — the machine's output the loading shell renders.
 *  `canHandOff` is true ONLY when EVERY step (visible AND hidden) is `done`;
 *  100% download alone never hands off. */
export interface GateState {
  steps: GateStep[];
  phase: 'prepping' | 'connecting' | 'ready' | 'failed';
  /** Hand-off ONLY when EVERY step (visible AND hidden) is done. */
  canHandOff: boolean;
}

/** The connect parameters the gate hands to `GateAdapter.connectRoom`. The adapter
 *  applies these over the SDK; the gate decides them ONCE so web + mobile connect
 *  identically. `roomOptions`/`connectOptions` come from `viewerRoomOptions()` /
 *  `viewerConnectOptions()` (already core — the adaptiveStream-off churn fix);
 *  `expectVideo` selects the video-less branch (omit video-subscribe/first-video
 *  from the hidden checklist when false). */
export interface GateConnectOpts {
  /** The LiveKit room to join. */
  roomName: string;
  /** Access token for the join (or null for an anon/guest grant the shell mints). */
  token?: string | null;
  /** The SFU/signaling URL. */
  serverUrl: string;
  /** Canonical viewer room options (adaptiveStream/dynacast off). From
   *  `viewerRoomOptions()`. */
  roomOptions: ViewerRoomOptions;
  /** Canonical viewer connect options (autoSubscribe / optional relay). From
   *  `viewerConnectOptions()`. */
  connectOptions: ViewerConnectOptions;
  /** False ⇒ video-less/audio-only room: the gate does NOT wait on a video track
   *  (no subscribe-video/first-video). Derived from `manifestHasVideoSource` /
   *  `sceneHasVideoSource`. THE video-less boot-loop fix. */
  expectVideo: boolean;
  /** Initial muted state (from `resolveInitialMuted`, cached pref). Applied to the
   *  output PRE-SESSION via `applyMuteBeforeSession` (the `mute-applied` step). */
  initialMuted: boolean;
}

/** The live A/V + sync readiness signals the gate subscribes to from a connected
 *  room, to advance its HIDDEN checklist (`subscribe-tracks` / `first-snapshot` /
 *  video-when-`expectVideo`). The adapter derives these from LiveKit events; the
 *  gate reads only these booleans, never the SDK. */
export interface GateReadinessSignals {
  /** A remote AUDIO track is subscribed + attachable to the output. */
  hasAudio: boolean;
  /** A remote VIDEO track is subscribed. Always considered satisfied when
   *  `expectVideo` is false (the gate doesn't gate on it). */
  hasVideo: boolean;
  /** The first overlay/live.sync/scene.sync snapshot has arrived (sync readiness).
   *  Gates `first-snapshot` + `manifest-ready`. */
  firstSnapshot: boolean;
}

/** The ONLY platform code in the gate — a bundle of callbacks the screen passes in.
 *  The gate machine is pure; the platform implements these. Native is used ONLY
 *  where a WebView genuinely can't serve (hard rule #4). Web returns trivially for
 *  the native-only hooks. */
export interface GateAdapter {
  /** Release background media before connecting. Web: pause/unload `<video>`; RN:
   *  PlayerPool release. The `release-media` step. */
  releaseBackgroundMedia(): Promise<void> | void;
  /** RN-ONLY native decoder reclaim (the `reclaim-decoders` step). Web returns true
   *  (no-op). Resolves true when decoders are reclaimed/available. */
  reclaimDecoders?(): Promise<boolean>;
  /** HEAD-request a material URL for an HONEST download % denominator. Returns the
   *  byte size, or null when the server doesn't report it. */
  headSize(url: string): Promise<number | null>;
  /** Preload ONE material, reporting bytes as they stream (for the smoothed %).
   *  `signal` aborts it on a cancelled/aborted join. The `download`/`preload` step. */
  preloadMaterial(
    entry: ManifestEntry,
    onBytes: (n: number) => void,
    signal: AbortLike,
  ): Promise<void>;
  /** Bring up the LiveKit room BEHIND the gate (the gate owns the connect, hard
   *  rule #6). Applies `viewerRoomOptions`/`reconcileJoin`/the connect-generation
   *  guard/the retry policy (all already core). Returns the connected `RoomHandle`.
   *  The `join-room` step. */
  connectRoom(opts: GateConnectOpts): Promise<RoomHandle>;
  /** Apply mute to the OUTPUT device BEFORE the session attaches its audio, so there
   *  is no connect-time audio burst regardless of mute state (§7a). The
   *  `mute-applied` step. Never touches the SFU subscription set. */
  applyMuteBeforeSession(muted: boolean, handle: RoomHandle): void;
  /** Subscribe to the room's A/V + first-snapshot readiness signals (drives the
   *  hidden checklist). The platform bridges LiveKit events into the booleans. */
  subscribeReadiness(handle: RoomHandle): GateReadinessSignals;
}

// ═════════════════════════════════════════════════════════════════════════════
// TASK D — THE GATE MACHINE (pure). Composes prep.ts (release-media/settle/preload)
// + entry.ts (manifest-ready/first-snapshot) + connection.ts (the join, behind the
// connect-generation guard the adapter applies) into ONE `GateState`, sequences the
// two checklists, branches on `expectVideo` (the video-less boot-loop fix), runs
// `mute-applied` as a pre-session step, and hands off ONLY when EVERY step is done.
//
// PURE: no DOM/RN/SDK, no `livekit-client`, no timers. The platform performs the
// effects (via `GateAdapter`) and feeds COMPLETION events back to the reducer; the
// machine only decides ordering + readiness. The `RoomHandle.teardown()` on a
// failed/aborted join is the PLATFORM's call (it holds the handle); the machine
// surfaces `phase:'failed'` so the driver knows to tear down.
// ═════════════════════════════════════════════════════════════════════════════

/** Does this room expect a VIDEO track? Derived from the listing manifest
 *  (`manifestHasVideoSource`) OR the in-room synced scene (`sceneHasVideoSource`) —
 *  either positively placing a camera/screen source means "expect video". When
 *  BOTH are video-less the room is audio-only (the jazz docrooms) and the gate must
 *  NOT add the video readiness wait. THE video-less boot-loop fix lives here +
 *  `buildGateSteps`. PURE. */
export function deriveExpectVideo(
  manifest: RoomManifest | null | undefined,
  scene: LiveScene | null | undefined,
): boolean {
  return manifestHasVideoSource(manifest) || sceneHasVideoSource(scene);
}

/** The ordered VISIBLE step ids (render in the loading shell, green-✓). */
const VISIBLE_STEP_IDS: readonly GateStepId[] = ['join-room', 'download'];

/** The ordered HIDDEN step ids that gate `canHandOff` but don't clutter the UI.
 *  `subscribe-tracks` waits on audio (and, when `expectVideo`, also video — see
 *  `GateReadinessSignals`); the video-less branch never adds a SEPARATE video step,
 *  so an audio-only room passes on audio + manifest + first-snapshot alone. */
const HIDDEN_STEP_IDS: readonly GateStepId[] = [
  'reclaim-decoders',
  'subscribe-tracks',
  'mute-applied',
  'manifest-ready',
  'first-snapshot',
];

/** User-facing labels for each step (shared so web + RN render the same copy). */
const STEP_LABELS: Record<GateStepId, string> = {
  'release-media': 'Freeing resources',
  settle: 'Preparing',
  preload: 'Loading materials',
  'join-room': 'Joining room',
  download: 'Downloading materials',
  'reclaim-decoders': 'Reclaiming decoders',
  'subscribe-tracks': 'Subscribing to media',
  'mute-applied': 'Applying audio settings',
  'manifest-ready': 'Reading manifest',
  'first-snapshot': 'Syncing stream',
};

/** Build the gate's step list for a room. The set is FIXED (visible: join-room,
 *  download; hidden: reclaim-decoders, subscribe-tracks, mute-applied,
 *  manifest-ready, first-snapshot) — `expectVideo` does NOT add/remove a step here;
 *  it changes ONLY what `subscribe-tracks` waits on (audio vs audio+video), so an
 *  audio-only room can never block on a video track that will never arrive. All
 *  steps start `pending`. PURE. */
export function buildGateSteps(): GateStep[] {
  const mk = (id: GateStepId, visible: boolean): GateStep => ({
    id,
    label: STEP_LABELS[id],
    visible,
    status: 'pending',
    ...(id === 'download' ? { progress: 0 } : {}),
  });
  return [
    ...VISIBLE_STEP_IDS.map((id) => mk(id, true)),
    ...HIDDEN_STEP_IDS.map((id) => mk(id, false)),
  ];
}

/** The gate's full machine state. Carries `expectVideo` (the video-less branch
 *  selector) alongside the rendered `GateState` so transitions read it without a
 *  re-derive. */
export interface GateMachine extends GateState {
  /** False ⇒ audio-only room: `subscribe-tracks` completes on audio alone. */
  expectVideo: boolean;
}

/** Construct the initial gate machine. `expectVideo` selects the audio-only branch
 *  (derive it via `deriveExpectVideo`). Phase starts `prepping` (the pre-connect
 *  release/settle/preload beat runs before the visible `join-room` step opens). */
export function initialGateState(expectVideo: boolean): GateMachine {
  return {
    steps: buildGateSteps(),
    phase: 'prepping',
    canHandOff: false,
    expectVideo,
  };
}

/** The events the platform driver feeds the pure machine as the adapter's effects
 *  complete. Each maps to exactly one step (or the phase). PURE reducer below. */
export type GateEvent =
  /** The pre-connect prep beat (prep.ts release-media → settle → preload) finished;
   *  the gate may open the connect. Moves `prepping → connecting`. */
  | { type: 'prep-done' }
  /** The LiveKit connect resolved (`GateAdapter.connectRoom`) — the `join-room` step. */
  | { type: 'joined' }
  /** Mute applied to the OUTPUT pre-session (`applyMuteBeforeSession`) — the
   *  `mute-applied` step. Runs BEFORE hand-off so there's no connect-time blip. */
  | { type: 'mute-applied' }
  /** Native decoder reclaim resolved (RN-only; web feeds this immediately as a
   *  no-op true) — the `reclaim-decoders` step. */
  | { type: 'decoders-reclaimed' }
  /** Real download progress for the visible `download` step (0..1, HEAD-size %). */
  | { type: 'download-progress'; progress: number }
  /** The manifest material download completed — the `download` step → done. */
  | { type: 'download-done' }
  /** The room manifest is in hand (in-room live.sync or listing) — `manifest-ready`. */
  | { type: 'manifest-ready' }
  /** Live A/V + first-snapshot readiness from `subscribeReadiness`. The machine
   *  decides `subscribe-tracks` (audio, +video when `expectVideo`) + `first-snapshot`
   *  from these — so the audio-only room never waits on video. */
  | { type: 'readiness'; signals: GateReadinessSignals }
  /** The join failed or was aborted → `phase:'failed'` (the driver tears the handle
   *  down). `manifest-vs-room` hygiene: a failed join clears nothing here; the
   *  platform calls `RoomHandle.teardown()`. */
  | { type: 'failed' };

/** Set a step's status (and optional progress), returning a NEW steps array only
 *  when something changed (stable identity otherwise). */
function setStep(
  steps: GateStep[],
  id: GateStepId,
  status: GateStep['status'],
  progress?: number,
): GateStep[] {
  let changed = false;
  const next = steps.map((s) => {
    if (s.id !== id) return s;
    const p = progress !== undefined ? progress : s.progress;
    if (s.status === status && s.progress === p) return s;
    changed = true;
    return { ...s, status, ...(p !== undefined ? { progress: p } : {}) };
  });
  return changed ? next : steps;
}

/** True when EVERY step (visible AND hidden) is `done` — the SOLE hand-off gate.
 *  100% download alone never hands off (the hidden readiness steps must all be done
 *  too). */
function allStepsDone(steps: GateStep[]): boolean {
  return steps.every((s) => s.status === 'done');
}

/** Recompute the machine from a (possibly new) steps array + an optional phase
 *  override. Returns the SAME machine instance when nothing actually changed
 *  (`steps` identical AND phase/canHandOff unchanged) — so a redundant completion
 *  event is a React-dep-friendly no-op. `failed` is sticky. */
function recompute(m: GateMachine, steps: GateStep[], phaseOverride?: GateState['phase']): GateMachine {
  if (m.phase === 'failed') return m;
  const canHandOff = allStepsDone(steps);
  const phase: GateState['phase'] = canHandOff ? 'ready' : (phaseOverride ?? m.phase);
  if (steps === m.steps && canHandOff === m.canHandOff && phase === m.phase) return m;
  return { ...m, steps, phase, canHandOff };
}

/** Fold an `expectVideo` flag + the live readiness signals into the
 *  `subscribe-tracks` + `first-snapshot` step statuses.
 *   • `subscribe-tracks` → done when audio is subscribed AND (video is subscribed OR
 *     this is an audio-only room). THE video-less branch: `expectVideo:false` ⇒
 *     video is NEVER required, so the step completes on audio alone and the gate
 *     can't hang on a track that will never arrive.
 *   • `first-snapshot` → done on the first overlay/live.sync/scene.sync snapshot. */
function applyReadiness(steps: GateStep[], expectVideo: boolean, sig: GateReadinessSignals): GateStep[] {
  const videoOk = !expectVideo || sig.hasVideo;
  const tracksDone = sig.hasAudio && videoOk;
  let next = setStep(steps, 'subscribe-tracks', tracksDone ? 'done' : 'active');
  next = setStep(next, 'first-snapshot', sig.firstSnapshot ? 'done' : 'active');
  return next;
}

/** THE PURE TRANSITION. Folds one `GateEvent` into the machine. Same input → same
 *  output on web + RN, so the gate lifecycle can never diverge. Returns the SAME
 *  machine on a no-op (stable identity for React deps). */
export function gateTransition(m: GateMachine, ev: GateEvent): GateMachine {
  if (m.phase === 'failed') return m; // terminal
  switch (ev.type) {
    case 'prep-done': {
      // Pre-connect beat done → open the connect. Mark the visible join-room active.
      const phase: GateState['phase'] = m.phase === 'prepping' ? 'connecting' : m.phase;
      const steps = setStep(m.steps, 'join-room', 'active');
      return recompute(m, steps, phase);
    }
    case 'joined': {
      return recompute(m, setStep(m.steps, 'join-room', 'done'));
    }
    case 'mute-applied': {
      return recompute(m, setStep(m.steps, 'mute-applied', 'done'));
    }
    case 'decoders-reclaimed': {
      return recompute(m, setStep(m.steps, 'reclaim-decoders', 'done'));
    }
    case 'download-progress': {
      const clamped = Math.max(0, Math.min(1, ev.progress));
      // Progress keeps the step `active` even at 100% — `download-done` is the
      // authoritative completion (a 100% byte count still waits on the writer), so
      // 100% download alone never advances the gate (the §5a "100% ≠ go" rule).
      return recompute(m, setStep(m.steps, 'download', 'active', clamped));
    }
    case 'download-done': {
      return recompute(m, setStep(m.steps, 'download', 'done', 1));
    }
    case 'manifest-ready': {
      return recompute(m, setStep(m.steps, 'manifest-ready', 'done'));
    }
    case 'readiness': {
      return recompute(m, applyReadiness(m.steps, m.expectVideo, ev.signals));
    }
    case 'failed': {
      return { ...m, phase: 'failed', canHandOff: false };
    }
    default: {
      const _never: never = ev;
      return _never;
    }
  }
}

/** Convenience: derive `expectVideo` from a room's signals + build the initial
 *  machine in one call. */
export function createGate(args: {
  manifest?: RoomManifest | null;
  scene?: LiveScene | null;
}): GateMachine {
  return initialGateState(deriveExpectVideo(args.manifest, args.scene));
}

/** The single hand-off predicate the driver reads — true ONLY when every step
 *  (visible AND hidden) is done. (Mirrors `GateState.canHandOff`; exported as a
 *  function so a caller with just the `GateState` can ask without the machine.) */
export function canGateHandOff(state: GateState): boolean {
  return state.canHandOff && allStepsDone(state.steps);
}
