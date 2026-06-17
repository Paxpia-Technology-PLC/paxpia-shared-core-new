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

// ── TODO(Task D): the gate MACHINE impl lives here ───────────────────────────
// Task D adds the pure `GateState` machine to THIS file: `initialGateState` +
// the transitions that compose prep.ts (release-media/settle/preload) + entry.ts
// (manifest-ready/first-snapshot) + connection.ts (the connect-generation guard /
// retry), sequence the two checklists (visible vs hidden), branch on
// `GateConnectOpts.expectVideo` (omit video steps when false), run the
// `mute-applied` step before hand-off, and compute `canHandOff` only when every
// step is `done`. It also calls `RoomHandle.teardown()` on a failed/aborted join.
// Until then this file exports the TYPES ONLY (Task A) — every gate consumer
// (the `<EntryGate>` shell, Task F; the platform `GateAdapter`s, Task I) compiles
// against the interfaces above now and wires to the machine when it lands.
