// Pure helpers for the overlay lifecycle + the per-stream cycling controller.
// No platform deps — web + mobile call the same functions so participation
// gating + reset semantics are identical.
import { OverlayInstance, OverlayKind, UserOverlayState } from './types';

/** Has this user already participated in the CURRENT generation of the overlay?
 *  (A re-login within the same round returns true; a reset bumps gen -> false.) */
export function hasActed(
  overlay: Pick<OverlayInstance, 'id' | 'gen'>,
  userStates: UserOverlayState[],
): boolean {
  return userStates.some(
    (s) => s.overlayId === overlay.id && s.gen === overlay.gen && s.choice != null,
  );
}

/** The user's committed choice for the current generation, if any. */
export function userChoice(
  overlay: Pick<OverlayInstance, 'id' | 'gen'>,
  userStates: UserOverlayState[],
): string | undefined {
  return userStates.find((s) => s.overlayId === overlay.id && s.gen === overlay.gen)?.choice;
}

/** Record a user's choice for the current round (idempotent — re-acting in the
 *  same round is ignored; the first commit stands). Returns the new state list. */
export function commitChoice(
  overlay: Pick<OverlayInstance, 'id' | 'gen'>,
  userStates: UserOverlayState[],
  choice: string,
  nowUnix: number,
): UserOverlayState[] {
  if (hasActed(overlay, userStates)) return userStates;
  return [
    ...userStates.filter((s) => !(s.overlayId === overlay.id && s.gen === overlay.gen)),
    { overlayId: overlay.id, gen: overlay.gen, choice, actedAtUnix: nowUnix },
  ];
}

/** Reset an overlay to a fresh round: bump gen, clear results, re-open. Stale
 *  per-user states (lower gen) no longer match, so everyone can act again. */
export function resetOverlay<P>(o: OverlayInstance<P>): OverlayInstance<P> {
  return {
    ...o,
    gen: o.gen + 1,
    phase: 'active',
    results: {},
    startedAtUnix: undefined,
    endsAtUnix: undefined,
  };
}

// ── Cycling: rotate overlay KIND (and, by parity, the video/overlay vertical
//    arrangement) on an interval, so each test stream demos a different overlay
//    and flips its layout over time. Deterministic from the tick + a per-stream
//    offset, so every client agrees with no extra signalling; the publisher
//    still owns the live payload + results. ─────────────────────────────────
export const DEFAULT_CYCLE_MS = 60_000;
const CYCLE_ORDER: OverlayKind[] = ['svg', 'poll', 'vote-button', 'quiz'];

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Which overlay kind a stream shows at cycle `tick` (offset distinguishes
 *  streams so they don't all show the same thing at once). */
export function cycleKindAt(tick: number, offset = 0): OverlayKind {
  return CYCLE_ORDER[mod(tick + offset, CYCLE_ORDER.length)];
}

/** Vertical arrangement for a cycle tick: alternate tv-top / video-bottom so the
 *  video and overlay zones swap places over time. */
export function cycleCompositionAt(tick: number, offset = 0): 'tv-top' | 'video-bottom' {
  return mod(tick + offset, 2) === 0 ? 'tv-top' : 'video-bottom';
}

/** Cycle tick for a wall-clock time + interval. */
export function cycleTick(nowMs: number, intervalMs: number = DEFAULT_CYCLE_MS): number {
  return Math.floor(nowMs / intervalMs);
}
