// CONNECTION LIFECYCLE — the platform-agnostic core that makes a viewer's LiveKit
// connect CANCELLABLE and makes a teardown that races an in-flight connect a
// NON-EVENT, not a surfaced error. This is the second half of the mobile
// "PC manager closed" fix (the first being join.ts's connect/reuse/defer-teardown
// reconciler + entry.ts's manifest gate): even with the right CONNECT decision,
// the connect spans several awaits (token fetch → WS signal → ICE/PC negotiation)
// and the user can navigate away DURING that window. When they do, the render
// layer disconnects the half-open Room, and livekit-client rejects the still-
// pending connect()/negotiation with a `PeerConnection`/`PC manager is closed`
// error. That error is EXPECTED — we asked for the disconnect — so it must be
// swallowed, NOT shown.
//
// ── Why a shared module (not just RN) ────────────────────────────────────────
// Web's StreamView has the identical hazard (StrictMode double-mount, route
// change mid-connect). Keeping the cancellation token + the "is this error a
// benign cancellation?" classifier HERE means web + RN swallow the EXACT same set
// of strings, so one platform can't start surfacing a teardown race the other
// already learned to ignore. Nothing here imports livekit-client — the render
// layer passes the caught error's message; we classify the string.

/** A monotonic connect-generation token. Each `start()` bumps it; a teardown
 *  that wants to cancel an in-flight connect records the generation it cancelled.
 *  The connect's catch then asks `wasCancelled` whether ITS generation lost — if
 *  so, ANY rejection (incl. "PC manager is closed") is the expected abort, not a
 *  failure. A plain number keeps it serializable and ref-friendly on both
 *  platforms (RN useRef, web a module/closure var). */
export type ConnectGeneration = number;

/** A tiny, pure connect-generation tracker. The render layer holds one instance
 *  per room-holder (one per `useLiveKitRoom`, one per web StreamView). It is the
 *  single source of truth for "which connect attempt is current" and "was attempt
 *  N cancelled" — so a connect that resolves/rejects AFTER its generation was
 *  superseded (a remount, a navigate-away, a room switch) can tell it lost and
 *  stay silent instead of mutating state for a dead attempt (connect-after-unmount
 *  / connect-after-teardown). */
export interface ConnectGuard {
  /** The generation the CURRENT connect attempt owns. */
  current: ConnectGeneration;
  /** The highest generation that has been cancelled (everything ≤ this lost). */
  cancelledThrough: ConnectGeneration;
}

/** A fresh guard (no attempts yet, nothing cancelled). */
export function newConnectGuard(): ConnectGuard {
  return { current: 0, cancelledThrough: 0 };
}

/** Begin a new connect attempt: bump + return the generation it owns. The caller
 *  captures this token and passes it back to `wasCancelled` in its catch/finally
 *  so a late rejection is attributed to the RIGHT attempt (a room switch starts a
 *  new generation; the old attempt's PC-closed rejection then reads as cancelled). */
export function beginConnect(guard: ConnectGuard): ConnectGeneration {
  guard.current += 1;
  return guard.current;
}

/** Cancel every in-flight attempt up to and including the current generation. The
 *  teardown path calls this BEFORE it disconnects the half-open Room, so the
 *  connect's pending rejection is already marked expected by the time it fires. */
export function cancelConnects(guard: ConnectGuard): void {
  guard.cancelledThrough = guard.current;
}

/** Did attempt `gen` lose? True iff it was cancelled (≤ cancelledThrough) — i.e.
 *  a teardown/room-switch/unmount superseded it. The connect's catch swallows its
 *  rejection when this is true; its success path skips mutating state (it would be
 *  writing for a connection that's already being torn down). */
export function wasCancelled(guard: ConnectGuard, gen: ConnectGeneration): boolean {
  return gen <= guard.cancelledThrough;
}

// ── Benign-error classification (the set of swallowable connect/teardown errors) ─

/** Error-message fragments (lowercased substrings) that mean "this rejection is
 *  the EXPECTED result of US tearing down / cancelling an in-flight connect or
 *  negotiation" — never a real connection failure. Sourced from livekit-client's
 *  actual throws:
 *   • 'pc manager is closed'        — NegotiationError/UnexpectedConnectionState
 *                                     thrown when the PeerConnection manager is
 *                                     disposed mid-negotiation (THE reported
 *                                     "PC manager closed"). The root symptom.
 *   • 'peerconnection is closed' / 'pc connection' — sibling PC-teardown rejects.
 *   • 'publisher is closed'         — UnexpectedConnectionState on a closing PC.
 *   • 'client initiated disconnect' — DisconnectReason when we call disconnect().
 *   • 'cancelled' / 'aborted'       — ConnectionError(Cancelled) when connect()'s
 *                                     own abort signal fires (the SDK cancelling
 *                                     its in-flight join), and AbortController.
 *   • 'signal connection' + 'clos'  — the signaling socket closed under us.
 *  Kept as a flat list so web + RN classify identically; extend HERE, never fork. */
export const BENIGN_CONNECTION_ERROR_FRAGMENTS: readonly string[] = [
  'pc manager is closed',
  'pc manager is being closed',
  'peerconnection is closed',
  'pc connection',
  'publisher is closed',
  'client initiated disconnect',
  'client-initiated disconnect',
  'cancelled',
  'canceled',
  'aborted',
];

/** True iff `err`'s message is one of the benign teardown/cancellation rejections
 *  above. The render layer passes the caught error (or its message); we normalize
 *  to a lowercased string and substring-match. A connect that was cancelled (see
 *  `wasCancelled`) should be swallowed REGARDLESS of message; this classifier is
 *  the SECOND line — it catches a benign PC-closed reject even when the caller
 *  didn't (or couldn't) attribute it to a cancelled generation (e.g. a teardown
 *  triggered by the SDK itself, or a stop() on an already-closing room). */
export function isBenignConnectionError(err: unknown): boolean {
  const msg = connectionErrorMessage(err).toLowerCase();
  if (!msg) return false;
  return BENIGN_CONNECTION_ERROR_FRAGMENTS.some((f) => msg.includes(f));
}

/** Extract a comparable message string from any thrown value (Error, string, or
 *  an object with a `.message`). Pure + defensive so the classifier never throws
 *  on a weird reject value. */
export function connectionErrorMessage(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && 'message' in (err as Record<string, unknown>)) {
    const m = (err as { message?: unknown }).message;
    return typeof m === 'string' ? m : String(m ?? '');
  }
  return String(err);
}

/** The single decision a connect's catch makes: should this rejection be SWALLOWED
 *  (logged, never surfaced) rather than shown as a connection error? True when the
 *  attempt's generation was cancelled OR the message is a benign teardown reject.
 *  Both platforms call exactly this so the "we cancelled" vs "real failure" line is
 *  drawn once. */
export function shouldSwallowConnectError(
  guard: ConnectGuard,
  gen: ConnectGeneration,
  err: unknown,
): boolean {
  return wasCancelled(guard, gen) || isBenignConnectionError(err);
}

// ── Disconnect-reason classification (the "room unavailable / offline" decision) ─
//
// When the SERVER sends a LEAVE (or the SDK gives up after exhausting its reconnect
// budget), livekit-client fires `RoomEvent.Disconnected(reason?: DisconnectReason)`.
// The reason is the ONLY signal that distinguishes "this room is gone / you were
// removed / it's blocked → show OFFLINE and stop" from "a transient drop the SDK is
// already retrying". The render layer was throwing the reason away, so every
// disconnect looked identical and 2 of the 3 viewer screens just sat on a black
// frame forever. This classifier draws that line ONCE, shared web + RN.
//
// We MIRROR the numeric DisconnectReason values from livekit's protobuf here rather
// than importing livekit-client — this module is intentionally SDK-free so it stays
// usable from web AND RN/Hermes. Keep in lockstep with livekit_models.proto.
// Source: github.com/livekit/protocol/blob/main/protobufs/livekit_models.proto
export const DISCONNECT_REASON = {
  UNKNOWN_REASON: 0,
  CLIENT_INITIATED: 1, // room.disconnect() — WE left
  DUPLICATE_IDENTITY: 2, // another session took our identity
  SERVER_SHUTDOWN: 3, // server instance going down (SDK reconnects to another)
  PARTICIPANT_REMOVED: 4, // RoomService.RemoveParticipant — kicked
  ROOM_DELETED: 5, // RoomService.DeleteRoom — room gone
  STATE_MISMATCH: 6, // tried to resume a session the server forgot
  JOIN_FAILURE: 7, // never fully connected
  MIGRATION: 8, // cloud migrate (handled transparently)
  SIGNAL_CLOSE: 9, // signal socket closed unexpectedly
  ROOM_CLOSED: 10, // all standard participants left → room closed
  USER_UNAVAILABLE: 11, // SIP callee no answer
  USER_REJECTED: 12, // SIP callee rejected
  SIP_TRUNK_FAILURE: 13, // SIP failure
  CONNECTION_TIMEOUT: 14, // server timed out the session
  MEDIA_FAILURE: 15, // media stream / media timeout
  AGENT_ERROR: 16, // agent errored
} as const;

/** What a disconnect MEANS for the UI:
 *   • 'user'        — WE initiated it (stop/teardown/navigate-away). No error UI;
 *                     the screen is normally leaving anyway.
 *   • 'unavailable' — TERMINAL server-side: the room is gone / deleted / closed, we
 *                     were removed, the identity was taken, or a SIP/join failure.
 *                     Show "stream offline / room unavailable" and OFFER a manual
 *                     rejoin — but do NOT auto-loop a reconnect that will just fail.
 *                     Also the bucket for "SDK gave up after its reconnect budget"
 *                     (reason === undefined) and UNKNOWN.
 *   • 'transient'   — server-driven but recoverable (shutdown/migration/signal-close/
 *                     timeout/media). The SDK normally reconnects itself; if it ever
 *                     surfaces as a final Disconnected, a fresh-token rejoin is sane. */
export type DisconnectKind = 'user' | 'unavailable' | 'transient';

/** Classify a `DisconnectReason` (numeric, or undefined when the SDK exhausted its
 *  retry budget) into a UI-meaningful bucket. PURE — same input → same bucket on web
 *  and mobile, so "is this room unavailable?" can never be answered differently on
 *  the two platforms. The render layer maps the bucket to copy + whether to offer a
 *  rejoin; this only draws the terminal/transient/user line. */
export function classifyDisconnect(reason: number | undefined | null): DisconnectKind {
  if (reason === undefined || reason === null) return 'unavailable'; // gave up after retries
  switch (reason) {
    case DISCONNECT_REASON.CLIENT_INITIATED:
      return 'user';
    case DISCONNECT_REASON.SERVER_SHUTDOWN:
    case DISCONNECT_REASON.MIGRATION:
    case DISCONNECT_REASON.SIGNAL_CLOSE:
    case DISCONNECT_REASON.CONNECTION_TIMEOUT:
    case DISCONNECT_REASON.MEDIA_FAILURE:
    case DISCONNECT_REASON.AGENT_ERROR:
      return 'transient';
    default:
      // DUPLICATE_IDENTITY, PARTICIPANT_REMOVED, ROOM_DELETED, STATE_MISMATCH,
      // JOIN_FAILURE, ROOM_CLOSED, USER_UNAVAILABLE, USER_REJECTED,
      // SIP_TRUNK_FAILURE, UNKNOWN_REASON → terminal, show offline/unavailable.
      return 'unavailable';
  }
}

// ── The unified VIEWER/PUBLISHER room status (one state model, web + RN) ──────────
//
// The render layer used to derive its own ad-hoc booleans (`connecting`, `offline`)
// off a flattened connection string, differently in every screen. This collapses the
// SDK's connection-state + the last disconnect bucket into ONE status enum the UI
// renders from, so "connecting / live / reconnecting / unavailable / offline / error"
// means the same thing everywhere.

/** The flattened livekit `ConnectionState` the render layer tracks (mapState in the
 *  RN hook / web StreamView). Kept as a plain union so this stays SDK-free. */
export type SdkConnState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

/** The single status the live UI renders from. */
export type RoomStatus =
  | 'idle' // nothing started
  | 'connecting' // opening signal / PC
  | 'live' // connected, media flowing
  | 'reconnecting' // transient interruption, SDK recovering (keep UI mounted)
  | 'unavailable' // terminal: room gone/removed/blocked → "stream offline", offer rejoin
  | 'offline' // disconnected (clean / transient-final) → offer rejoin
  | 'error'; // a real connect failure surfaced (bad token, ICE, etc.)

/** Derive the unified {@link RoomStatus} from the flattened connection state + the
 *  last disconnect bucket. PURE. The connection state wins while we're actively
 *  connecting/live/reconnecting (the disconnect bucket only matters once we're
 *  actually `disconnected`), so a stale 'unavailable' from a prior attempt can never
 *  bleed into a fresh connect. */
export function deriveRoomStatus(args: {
  conn: SdkConnState;
  disconnectKind?: DisconnectKind | null;
}): RoomStatus {
  switch (args.conn) {
    case 'connected':
      return 'live';
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
      return 'reconnecting';
    case 'error':
      return 'error';
    case 'idle':
      return 'idle';
    case 'disconnected':
      return args.disconnectKind === 'unavailable' ? 'unavailable' : 'offline';
    default:
      return 'idle';
  }
}

/** True when the room is in a state the viewer should see a blocking status overlay
 *  for (no live media is or will be flowing without action). The render layer shows
 *  {@link LiveStatusOverlay}-style chrome for these. 'reconnecting' is included so a
 *  full reconnect shows the overlay, but the underlying video/decoder stays mounted. */
export function isBlockingStatus(status: RoomStatus): boolean {
  return (
    status === 'connecting' ||
    status === 'reconnecting' ||
    status === 'unavailable' ||
    status === 'offline' ||
    status === 'error'
  );
}

/** Should the UI offer a manual "rejoin"? True for the terminal/failed states where
 *  the SDK will NOT recover on its own (so the user needs a button), false while the
 *  SDK is still working it (connecting/reconnecting) or already live/idle. */
export function canRejoin(status: RoomStatus): boolean {
  return status === 'unavailable' || status === 'offline' || status === 'error';
}

// ── TRACK RECOVERY — the "session is alive but the VIDEO TRACK vanished" machine ──
//
// The disconnect machine above only fires once the SESSION drops (ConnectionState →
// Reconnecting/Disconnected). But a publisher's video track can disappear while the
// signal + PeerConnection stay perfectly `Connected`: the SFU drops the subscription
// under load, the publisher's encoder stalls and the track ends, or a renegotiation
// fails to re-attach. The viewer is then STUCK past every gate — `status === 'live'`,
// the "LIVE" badge shows, but `remoteVideos` is empty and nothing ever retries. The
// session is fine; only the TRACK needs to come back.
//
// This is the SECOND recovery axis, orthogonal to the disconnect axis:
//   • disconnect axis  → reconnect the SESSION (handled by the SDK + classifyDisconnect)
//   • track axis (here) → re-subscribe the TRACK without touching the session
//
// Pure + SDK-free (mirrors classifyDisconnect): the render layer feeds it observable
// facts (are we connected? do we have a video track? how long since it vanished? how
// many re-subscribe nudges have we spent?) and gets back the next ACTION, so web + RN
// recover identically and the policy is unit-testable in isolation.

/** The phase of the video TRACK while the SESSION is alive.
 *   • 'ok'        — connected AND at least one remote video track present. Nothing to do.
 *   • 'recovering'— connected but NO video track: waiting for it to return / re-subscribing.
 *                   Surface a SUBTLE "reconnecting…" hint; do NOT tear down the session.
 *   • 'idle'      — not connected (the disconnect axis owns this); track recovery is dormant. */
export type TrackRecoveryPhase = 'ok' | 'recovering' | 'idle';

/** What the render layer should DO next for the track axis, decided purely from the
 *  current facts. The hook maps each to a concrete LiveKit call (or no-op).
 *   • 'none'        — nothing to do (we have video, or we're not connected).
 *   • 'wait'        — video is gone but we're inside the grace window; let LiveKit
 *                     auto-resubscribe first (it usually does). Just reflect the hint.
 *   • 'resubscribe' — grace elapsed and still no video: explicitly re-subscribe to the
 *                     publisher's video publication(s). Bounded by maxResubscribes.
 *   • 'exhausted'   — spent the re-subscribe budget with no video back: stop nudging and
 *                     let the screen surface an honest "no video" hint (session still up,
 *                     so a SESSION reconnect / manual retry is the next lever). */
export type TrackRecoveryAction = 'none' | 'wait' | 'resubscribe' | 'exhausted';

/** Tunables for the track-recovery policy. Defaults are conservative: a short grace so
 *  the SDK's own resubscribe wins the common case, then a few bounded nudges on a linear
 *  cadence (the SFU/publisher recovery we're nudging is seconds-scale, not exponential). */
export interface TrackRecoveryPolicy {
  /** ms to WAIT for LiveKit's own auto-resubscribe before we nudge. */
  graceMs: number;
  /** ms between explicit re-subscribe nudges once the grace has elapsed. */
  resubscribeIntervalMs: number;
  /** hard cap on explicit re-subscribe nudges before we declare 'exhausted'. */
  maxResubscribes: number;
}

export const DEFAULT_TRACK_RECOVERY_POLICY: TrackRecoveryPolicy = {
  graceMs: 2500,
  resubscribeIntervalMs: 3000,
  maxResubscribes: 4,
};

/** The observable facts the track-recovery decision is made from. All come straight
 *  from the hook's existing state (no new SDK plumbing): are we session-connected, do
 *  we have a remote video track, how long since the track vanished, how many nudges
 *  have we already spent. */
export interface TrackRecoveryInput {
  /** Is the SESSION connected (ConnectionState.Connected)? When false the disconnect
   *  axis owns recovery and this machine is dormant ('idle'). */
  connected: boolean;
  /** Does the viewer currently have at least one remote VIDEO track? */
  hasVideo: boolean;
  /** ms since the video track was last seen vanish while connected (0 if we have video
   *  or just lost it this tick). */
  msSinceVideoLost: number;
  /** How many explicit re-subscribe nudges we've ALREADY spent this outage. */
  resubscribesSpent: number;
  policy?: TrackRecoveryPolicy;
}

/** The phase the track axis is in, for the UI hint. PURE. */
export function trackRecoveryPhase(input: Pick<TrackRecoveryInput, 'connected' | 'hasVideo'>): TrackRecoveryPhase {
  if (!input.connected) return 'idle';
  return input.hasVideo ? 'ok' : 'recovering';
}

/** Decide the next track-recovery ACTION from the current facts. PURE — same inputs →
 *  same action on web + RN. The hook calls this on a tick while connected-without-video
 *  and performs the returned action (re-subscribe nudge / wait / give up). */
export function nextTrackRecoveryAction(input: TrackRecoveryInput): TrackRecoveryAction {
  // Connected + has video, or not connected at all → the track axis has nothing to do.
  if (!input.connected || input.hasVideo) return 'none';
  const policy = input.policy ?? DEFAULT_TRACK_RECOVERY_POLICY;
  // Still inside the grace window: let LiveKit's own auto-resubscribe win first.
  if (input.msSinceVideoLost < policy.graceMs) return 'wait';
  // Grace elapsed: nudge, up to the budget, then declare exhausted (session still up,
  // so the screen can offer a SESSION reconnect / manual retry instead of spinning).
  if (input.resubscribesSpent >= policy.maxResubscribes) return 'exhausted';
  return 'resubscribe';
}
