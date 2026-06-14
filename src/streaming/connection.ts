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
