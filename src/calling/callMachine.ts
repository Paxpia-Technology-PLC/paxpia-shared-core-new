// @paxpia/core/calling — the PURE, platform-free 1:1 / group call state machine.
//
// Why this exists: mobile (`CallScreen` + `useLiveKitRoom` + RTCView) and web
// (`CallScreen` + inline `livekit-client` + <video>) each used to re-derive call
// STATUS and TEARDOWN independently, which is exactly why they diverged (stuck
// "Ringing…" after the callee joined; kicked-to-list on hangup; "Ringing" shown
// even for an offline callee). This module is the ONE brain both platforms drive:
// a phase reducer + status copy + end-reason mapping + a UUID-free peer-name
// resolver. No LiveKit SDK, no navigation, no `<video>`/RTCView — the platform
// injects the media plane + video render + nav and feeds this machine events.
//
// Phases (the two-stage dial the product asks for):
//   dialing     — caller's POST is in flight / just placed; "Calling…"
//   connecting  — media room joining, OR callee is OFFLINE (never say "Ringing"
//                 to a caller whose callee can't be ringing); "Connecting…"
//   ringing     — callee is ONLINE and the ring is out, not yet answered; "Ringing…"
//   connected   — answered (call_ringing status:'ongoing') OR a remote peer is in
//                 the media room; the call is live.
//   ended       — declined / missed / completed / failed / hung up. Terminal +
//                 idempotent, so a self-delivered `call_ended` (the backend fans to
//                 EVERYONE incl. the caller) can never trigger a second teardown.

import type { CallLog, Participant } from '../messaging/types';

export type CallPhase = 'idle' | 'dialing' | 'connecting' | 'ringing' | 'connected' | 'ended';

/** Why a call ended — drives the `call_log` chat chip + the end-screen copy. */
export type EndReason = 'declined' | 'missed' | 'completed' | 'failed' | 'hangup';

/** The media-plane connection state, normalized across platforms (mobile
 *  `useLiveKitRoom.conn` + web `livekit-client` ConnectionState use the same words). */
export type LiveKitConn =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export interface CallState {
  phase: CallPhase;
  /** True when WE placed the call (caller); false when we answered (callee). */
  outgoing: boolean;
  /** Set once terminal. */
  reason?: EndReason;
  /** Completed-call duration for the chip, once known. */
  durationMs?: number;
  /** Remote participants currently in the media room (0 while only we are in). */
  peerCount: number;
  /** Callee presence (outgoing calls only). `undefined` = not yet known. Drives
   *  the ringing-vs-connecting distinction so we never show "Ringing" to a caller
   *  whose callee is offline. */
  peerOnline?: boolean;
}

export type CallEvent =
  /** Caller: the initiate POST is in flight. */
  | { t: 'INITIATE' }
  /** We have join info (token minted) and are joining the media room. */
  | { t: 'JOIN_INFO' }
  /** Callee presence learned/updated (outgoing only). */
  | { t: 'PRESENCE'; online: boolean }
  /** A `call_ringing` frame arrived. `status:'ongoing'` == the call was ANSWERED. */
  | { t: 'RINGING_FRAME'; status: string }
  /** Media-plane tick: connection state + remote peer count. */
  | { t: 'LK'; conn: LiveKitConn; peers: number }
  /** A `call_ended` frame arrived (peer declined / hung up / server missed-timeout). */
  | { t: 'ENDED_FRAME'; status: string; durationMs?: number }
  /** The local user pressed hang-up. */
  | { t: 'LOCAL_HANGUP' }
  /** The ring timed out with no answer (client-side backstop). */
  | { t: 'TIMEOUT' };

/** Initial state. Outgoing calls open on `dialing` ("Calling…"); an accepted
 *  incoming call opens on `connecting` (we're joining the media room). */
export function initialCallState(outgoing: boolean, peerOnline?: boolean): CallState {
  return {
    phase: outgoing ? 'dialing' : 'connecting',
    outgoing,
    peerCount: 0,
    peerOnline,
  };
}

/** Map a backend call status (+ whether it was ever answered) to an `EndReason`.
 *  The backend already distinguishes declined / missed / completed / failed; a
 *  bare 'completed' on a never-answered call is treated as 'missed'. */
export function endReasonFromStatus(status: string, answered: boolean): EndReason {
  switch (status) {
    case 'declined':
      return 'declined';
    case 'missed':
      return 'missed';
    case 'failed':
      return 'failed';
    case 'completed':
    case 'ongoing':
      return answered ? 'completed' : 'missed';
    default:
      // 'ringing' or anything unknown, ended without an answer → missed.
      return answered ? 'completed' : 'missed';
  }
}

/** The pure reducer. Terminal `ended` is a fixpoint (idempotent) so a duplicate /
 *  self-delivered end frame is a no-op — the single source of the graceful, one-shot
 *  teardown both platforms rely on. */
export function nextCallState(s: CallState, e: CallEvent): CallState {
  // Once ended, stay ended. Absorb any late media/presence noise.
  if (s.phase === 'ended') return s;

  const answered = s.phase === 'connected';

  switch (e.t) {
    case 'INITIATE':
      return { ...s, phase: 'dialing' };

    case 'JOIN_INFO':
      // We have a token; the media room is joining. Don't downgrade a phase that's
      // already further along (a fast answer frame can beat the token locally).
      if (s.phase === 'connected') return s;
      return { ...s, phase: deriveWaitingPhase(s, s.peerOnline) };

    case 'PRESENCE': {
      const peerOnline = e.online;
      if (s.phase === 'connected') return { ...s, peerOnline };
      return { ...s, peerOnline, phase: deriveWaitingPhase(s, peerOnline) };
    }

    case 'RINGING_FRAME':
      // The authoritative "answered" signal — flip to connected regardless of the
      // media plane (kills the stuck-"Ringing…"-after-join bug). Any other status
      // is just the outbound ring; keep waiting.
      if (e.status === 'ongoing') return { ...s, phase: 'connected' };
      return s;

    case 'LK': {
      // A remote peer in the room ⇒ connected. This is the media-plane confirmation
      // and the primary signal for video calls (no server poll can clobber it).
      if (e.peers > 0) return { ...s, peerCount: e.peers, phase: 'connected' };
      // No remote peer yet. If we were already connected (peer briefly dropped),
      // stay connected — don't bounce back to "Ringing". Otherwise reflect the
      // media connection progress as our waiting copy.
      if (s.phase === 'connected') return { ...s, peerCount: 0 };
      const connecting = e.conn === 'connecting' || e.conn === 'reconnecting';
      return {
        ...s,
        peerCount: 0,
        phase: connecting ? 'connecting' : deriveWaitingPhase(s, s.peerOnline),
      };
    }

    case 'ENDED_FRAME':
      return {
        ...s,
        phase: 'ended',
        reason: endReasonFromStatus(e.status, answered),
        durationMs: e.durationMs ?? s.durationMs,
      };

    case 'LOCAL_HANGUP':
      return { ...s, phase: 'ended', reason: answered ? 'completed' : 'hangup' };

    case 'TIMEOUT':
      // Only a still-waiting call times out to "missed".
      if (answered) return s;
      return { ...s, phase: 'ended', reason: 'missed' };

    default:
      return s;
  }
}

/** While waiting (not yet connected), pick "Ringing" only when the callee is known
 *  ONLINE; otherwise "Connecting" — the caller must never be told the callee is
 *  ringing when they're offline. Incoming (answered-side) calls are always
 *  "Connecting" until media flows. */
function deriveWaitingPhase(s: CallState, peerOnline: boolean | undefined): CallPhase {
  if (!s.outgoing) return 'connecting';
  if (peerOnline === true) return 'ringing';
  if (peerOnline === false) return 'connecting';
  // Unknown presence yet: keep the current dialing/connecting-ish phase.
  return s.phase === 'ringing' ? 'ringing' : s.phase === 'dialing' ? 'dialing' : 'connecting';
}

/** The single source of the status line both platforms render. */
export function callStatusText(s: CallState): string {
  switch (s.phase) {
    case 'dialing':
      return 'Calling…';
    case 'connecting':
      return 'Connecting…';
    case 'ringing':
      return 'Ringing…';
    case 'connected':
      return s.peerCount > 1 ? `${s.peerCount} in call` : 'Connected';
    case 'ended':
      return endReasonText(s.reason);
    default:
      return '';
  }
}

/** End-of-call copy for the brief post-call state. */
export function endReasonText(reason: EndReason | undefined): string {
  switch (reason) {
    case 'declined':
      return 'Call declined';
    case 'missed':
      return 'No answer';
    case 'failed':
      return 'Call failed';
    case 'completed':
      return 'Call ended';
    case 'hangup':
      return 'Call ended';
    default:
      return 'Call ended';
  }
}

/** True once the call has reached a terminal state — the platform reads this to run
 *  its single graceful teardown (stop media + dismiss the call surface). */
export function isCallOver(s: CallState): boolean {
  return s.phase === 'ended';
}

/** Resolve a user id to a HUMAN label — `display_name`, else `@username`, else a
 *  short id slice. NEVER returns a raw UUID as a name. Both call surfaces (incoming
 *  modal + in-call pill) route the `initiator_id` through this so a UUID is never
 *  shown. Mirrors `threadTitle`'s fallback ladder. */
export function resolvePeerName(participants: Participant[] | undefined, id: string): string {
  const p = participants?.find((x) => x.user_id === id);
  if (p?.display_name && p.display_name.trim()) return p.display_name.trim();
  if (p?.username && p.username.trim()) return '@' + p.username.trim();
  if (id && id.trim()) return '@' + id.slice(0, 8);
  return 'Unknown';
}

/** The DM peer's avatar url (if any), resolved from participants — feeds the call
 *  surface avatar so it matches the resolved name. */
export function resolvePeerAvatar(participants: Participant[] | undefined, id: string): string | undefined {
  return participants?.find((x) => x.user_id === id)?.avatar_url;
}

/** Format a call duration (ms) as `m:ss` (or `h:mm:ss` past an hour) for the chip. */
export function formatCallDuration(durationMs: number | undefined): string {
  if (!durationMs || durationMs < 0) return '';
  const total = Math.round(durationMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const two = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/** The centered `call_log` chip copy — shared by web `MessageRenderer` and the
 *  mobile bubble so both platforms describe a call identically. e.g.
 *  "📞 Voice · declined", "📹 Video · 2:14". */
export function callLogChipText(call: CallLog | undefined): string {
  if (!call) return '📞 Call';
  const icon = call.kind === 'video' ? '📹' : '📞';
  const kindLabel = call.kind === 'video' ? 'Video' : 'Voice';
  const status = call.status;
  if (status === 'completed' && call.duration_ms) {
    return `${icon} ${kindLabel} · ${formatCallDuration(call.duration_ms)}`;
  }
  const statusLabel =
    status === 'declined'
      ? 'declined'
      : status === 'missed'
        ? 'no answer'
        : status === 'failed'
          ? 'failed'
          : status === 'completed'
            ? 'ended'
            : status;
  return `${icon} ${kindLabel} · ${statusLabel}`;
}
