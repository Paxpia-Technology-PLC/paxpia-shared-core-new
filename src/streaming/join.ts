// UNIFIED ROOM-JOIN HANDSHAKE — the single, platform-agnostic brain every Paxpia
// viewer drives to go from "tapped a stream" to "stable live media", and back out
// again, WITHOUT ever remounting the media connection on a state change.
//
// ── Why this exists (the bug it kills) ───────────────────────────────────────
// There are now TWO room shapes — the original simple live rooms (seed-sim
// streamers, no schedule, no manifest) and the newer scheduled rooms that carry a
// MANIFEST + preload + live-sync state. Each client (web StreamView, mobile
// LivestreamViewer / LiveWatch) had grown its OWN connect/teardown lifecycle, its
// OWN Room options, and its OWN "is this a real navigation-away or just a focus
// blip" heuristic. They diverged: web disabled adaptiveStream (the
// viewport-visibility pause that recreates the H.264 decoder + Surface in a loop),
// mobile did NOT — so the mobile viewer churned `Surface::disconnect` +
// `MediaCodec` recreate ~once a second and black-screened. The decision logic
// lives HERE now so the two platforms can never diverge again, and so EVERY room
// shape (plain live, scheduled+manifest, future heterogeneous types) joins through
// ONE handshake.
//
// ── What's shared vs per-platform ────────────────────────────────────────────
// Shared (this module): the Room CONSTRUCTION OPTIONS, the connect options, the
// viewer-identity invariants, the connect/reuse/defer-teardown/teardown DECISION
// (`reconcileJoin`), and the initial-muted resolution from a cached preference.
// Per-platform: actually calling `new Room(opts)` / `room.connect(...)`, binding
// LiveKit events, and rendering the track. Those are thin; ALL the decisions that
// caused churn are here, as pure functions over an explicit target.
//
// Nothing in this file imports `livekit-client` — it returns PLAIN option objects
// the render layer spreads into the SDK, so it stays usable from web AND
// RN/Hermes with no DOM and no native deps.

// ── Room options (the churn fix, made canonical) ─────────────────────────────

/** The subset of LiveKit `RoomOptions` we pin for a VIEWER. Typed structurally
 *  (not importing livekit-client) so this package has no SDK dependency; the
 *  render layer spreads it into `new Room(...)`. */
export interface ViewerRoomOptions {
  /** MUST be false for a viewer. `adaptiveStream` makes the SDK pause/resume the
   *  subscription off the rendered element's measured size + visibility. On a
   *  9:16 object-cover frame (web) and inside the RN `<VideoTrack>` ViewPortDetector
   *  (mobile) the element is transiently measured as 0×0 during layout passes,
   *  modal present/dismiss transitions, and ordinary re-renders — each false→true
   *  flip tears down + recreates the H.264 MediaCodec + Surface (~1s loop) →
   *  black/pixelated video + a perceived connect/disconnect churn. The published
   *  stream is a single spatial layer, so adaptive selection buys nothing here. */
  adaptiveStream: false;
  /** Publisher-side simulcast-layer pausing. Irrelevant to a pure subscriber and
   *  only adds renegotiation churn for a non-simulcast source → off. */
  dynacast: false;
}

/** The canonical viewer Room options. Web + mobile BOTH construct their viewer
 *  Room with exactly this — the single place adaptiveStream/dynacast are decided,
 *  so the platforms can never drift back into the decoder-churn loop. */
export function viewerRoomOptions(): ViewerRoomOptions {
  return { adaptiveStream: false, dynacast: false };
}

/** The subset of LiveKit `RoomConnectOptions` the join handshake decides. Kept
 *  structural for the same no-SDK-dependency reason. */
export interface ViewerConnectOptions {
  /** Subscribe to remote tracks automatically. A real viewer wants audio + video
   *  from the first frame, so this is true for `view`. A silent preview tile sets
   *  it false and opts into video-only — see `forPreview`. */
  autoSubscribe: boolean;
  /** Force the TURN relay (coturn). Only the iOS simulator needs this (its WebRTC
   *  stack never gathers the Tailscale host candidate, so direct ICE can't pair);
   *  real devices + browsers keep the default. The caller passes whether it's a
   *  simulator; we encode the policy so the relay decision is shared, not re-derived. */
  rtcConfig?: { iceTransportPolicy: 'relay' };
}

/** Build the viewer connect options. `forPreview` ⇒ a silent, uncounted peek
 *  (autoSubscribe off; the render layer subscribes video-only). `isSimulator` ⇒
 *  force the TURN relay. Both web and mobile route through this so the connect
 *  shape is identical. */
export function viewerConnectOptions(opts?: {
  forPreview?: boolean;
  isSimulator?: boolean;
}): ViewerConnectOptions {
  const out: ViewerConnectOptions = { autoSubscribe: !opts?.forPreview };
  if (opts?.isSimulator) out.rtcConfig = { iceTransportPolicy: 'relay' };
  return out;
}

// ── Viewer identity invariants (own-stream-as-viewer must not collide) ────────

/** A viewer always joins under a DISTINCT identity from the publisher, even when
 *  the same human is the streamer watching from a second device. The streaming
 *  service mints `…::view::<room>::<nonce>` (publishers have no `::view::`
 *  segment), so the SFU never treats a self-view as a duplicate-identity
 *  replacement that would kick the publisher. This predicate lets either client
 *  assert that invariant on the token it received (defence in depth). */
export function isViewerIdentity(identity: string | null | undefined): boolean {
  return !!identity && identity.includes('::view::');
}

/** True when a `view` identity belongs to the SAME human as the publisher of the
 *  room (a streamer watching their own stream from another device). Both segments
 *  are derived from the room name + the user id; this only checks the SHAPE is a
 *  valid self-view (distinct identities), which is always allowed. */
export function isSelfView(viewerIdentity: string, publisherIdentity: string): boolean {
  // A self-view is valid iff the identities are DIFFERENT (so no SFU collision)
  // even if they map to the same user. A collision (identical identity) is the
  // only illegal case — the streaming service prevents it by the `::view::` mint.
  return viewerIdentity !== publisherIdentity;
}

// ── The connect/teardown reconciler (focus-blip vs real navigation) ──────────
//
// The single source of truth for WHAT a viewer connection should do, given the
// currently-live connection and the newly-desired target. This replaces the
// ad-hoc deferred-teardown timer + same-room-reuse heuristic that each screen had
// re-implemented (and that mobile + web implemented differently). A render layer
// feeds it the current + desired state on every relevant change and gets back a
// single ACTION; it never decides connect-vs-reuse itself.

/** What the viewer WANTS to be connected to right now. `null` roomName or
 *  `active:false` means "not watching" (navigated away / lost focus / live off). */
export interface JoinTarget {
  /** The room to be on, or null when nothing should be connected. */
  roomName: string | null;
  /** Whether the viewer surface is currently active (focused + enabled). A brief
   *  false during a modal present/dismiss transition is the "focus blip" we must
   *  NOT tear the media down for. */
  active: boolean;
  /** 'view' (counted) | 'preview' (silent, uncounted). Drives the leave-on-exit. */
  mode: 'view' | 'preview';
}

/** The connection the client currently holds (what it's actually on). */
export interface JoinCurrent {
  /** The room the live connection is on, or null if nothing is connected. */
  roomName: string | null;
  /** True iff that connection is connected OR mid-connect (so reuse is valid). */
  alive: boolean;
}

/** The single action the render layer must take. Exactly one per reconcile. */
export type JoinAction =
  /** Open a fresh connection to `roomName` (after tearing down any prior). */
  | { kind: 'connect'; roomName: string; mode: 'view' | 'preview' }
  /** Keep the live connection exactly as-is — the target matches what we're on
   *  (the focus-blip case: a transient blur for the SAME room → do NOT bounce it). */
  | { kind: 'reuse' }
  /** Schedule a teardown after the grace window; cancel it if the SAME room
   *  re-activates within the window (modal transition jitter). On a counted
   *  `view`, the deferred teardown also leaves the viewer set. */
  | { kind: 'deferTeardown'; roomName: string; mode: 'view' | 'preview' }
  /** Nothing to do (already idle and target is idle). */
  | { kind: 'idle' };

/** Decide the single action for a viewer connection. PURE — the same inputs always
 *  yield the same action on web and mobile, so the connect/teardown lifecycle can
 *  never diverge between platforms (the root cause of the churn was two different
 *  ad-hoc lifecycles).
 *
 *  The rules, in order:
 *   1. Target wants a room AND we're already alive on THAT SAME room ⇒ `reuse`
 *      (the focus-blip: a transient active:false→true round-trip for one room
 *      must not bounce the PeerConnection / recreate the decoder).
 *   2. Target wants a room (and we're not already on it, or not alive) ⇒ `connect`.
 *   3. Target wants NOTHING but we're alive on a room ⇒ `deferTeardown` (a real
 *      navigation-away keeps active:false past the grace, so the deferred teardown
 *      then fires; a blip re-activates and the next reconcile returns `reuse`).
 *   4. Otherwise ⇒ `idle`. */
export function reconcileJoin(current: JoinCurrent, target: JoinTarget): JoinAction {
  const want = target.active && !!target.roomName ? target.roomName : null;

  if (want) {
    const sameRoom = current.roomName === want;
    if (sameRoom && current.alive) return { kind: 'reuse' };
    return { kind: 'connect', roomName: want, mode: target.mode };
  }

  // Target wants nothing.
  if (current.alive && current.roomName) {
    return { kind: 'deferTeardown', roomName: current.roomName, mode: target.mode };
  }
  return { kind: 'idle' };
}

/** The grace window (ms) before a deferred teardown actually runs. A modal
 *  viewer's present/dismiss transition flips focus true→false→true inside this
 *  window; a real navigation-away never re-activates, so the teardown still fires
 *  promptly. Shared so web + mobile use the SAME window. */
export const TEARDOWN_GRACE_MS = 600;

/** The debounce (ms) before a connect actually opens a socket. A quick remount
 *  cycle (Fast Refresh / Bridgeless reconnect re-mounts every screen; web
 *  StrictMode double-mounts) would otherwise open back-to-back Rooms on the SAME
 *  identity — the SFU replaces a duplicate identity by disconnecting the older
 *  session, so the first PC dies before ICE completes and the storm repeats. A
 *  remount inside the window never even opens a Room. Sized for the SLOWER of the
 *  two (RN Fast Refresh re-evaluates the whole bundle, which can run past a web
 *  StrictMode double-mount), so it covers both platforms. Shared web + mobile. */
export const CONNECT_DEBOUNCE_MS = 400;

// ── Mute-cache resolution (honor a cached MUTED preference on first open) ─────

/** The viewer's persisted sound preference. `muted` ⇒ start with no audio (the
 *  speaker icon shows a slash); `on` ⇒ start with sound. Absent ⇒ the platform
 *  default (we start MUTED, mirroring an autoplay-muted video — the user taps to
 *  unmute). Kept as a string union so it serializes to any KV/localStorage. */
export type SoundPreference = 'muted' | 'on';

/** Resolve whether the live audio should START muted, given the cached preference.
 *  The BUG this fixes: when the cached preference is MUTED, the stream still played
 *  audio on first open because the screen initialized its `soundOn` from a literal
 *  `false`/`true` default and only applied the cached value on a later effect — so
 *  the first audio frames leaked through. The render layer must seed its initial
 *  muted state from THIS (synchronously, before connect), so a cached MUTED never
 *  produces sound on open.
 *
 *  Returns `true` (start muted) when the preference is 'muted' OR unset; `false`
 *  only when the user previously chose 'on'. */
export function resolveInitialMuted(pref: SoundPreference | null | undefined): boolean {
  return pref !== 'on';
}

/** The inverse, for the speaker-toggle's `soundOn` initial state. Convenience so a
 *  screen can write `useState(initialSoundOn(cached))` directly. */
export function initialSoundOn(pref: SoundPreference | null | undefined): boolean {
  return !resolveInitialMuted(pref);
}

/** Map a boolean "sound is on" back to the persisted preference, for writing the
 *  cache when the user toggles. Shared so both platforms store the SAME values
 *  (`'on'` / `'muted'`) and read each other's cache identically. */
export function soundPreferenceFor(soundOn: boolean): SoundPreference {
  return soundOn ? 'on' : 'muted';
}

/** The canonical cache KEY for the viewer sound preference. Shared so web
 *  (localStorage) and mobile (MMKV) use the SAME key and a single source of truth. */
export const SOUND_PREF_CACHE_KEY = 'live/sound-preference';
