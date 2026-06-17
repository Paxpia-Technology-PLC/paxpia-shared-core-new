// THE RENDER-BRAIN'S PURE CORE (no React) — the vote + doc-takeover reducers the
// headless `useOverlaySession` hook (useOverlaySession.ts) composes. Split out of
// the hook so this logic is unit-testable with NO React renderer (the test runner
// strips types + runs plain Node; importing `react` there would fail). The hook is
// a thin `useState`/effect shell over exactly these functions.
//
// Lifted verbatim (semantics) from `Paxpia-mobile/src/hooks/useLivestreamSync.ts`'s
// applyChanged / applyResults / onVote (the participation vote) + its takeover
// routing of live.sync (the doc local-takeover). PURE: only `@paxpia/core` siblings,
// no DOM/RN/SDK/`livekit-client`.

import {
  foldOptimisticTally,
  resultsMatchOverlay,
  type OverlayResultsMsg,
} from '../overlays/wire';
import type { OverlayInstance, OverlayViewProps } from '../overlays/types';
import {
  onStreamerDocUpdate,
  onStreamerSceneChange,
  type DocTakeoverState,
} from './docTakeover';
import type { DocPresenterState } from './live';
import type { ViewerState } from './viewer';

// ── PURE participation-vote reducer ──────────────────────────────────────────

/** The viewer-local participation state for the active overlay round.
 *   • `myChoice`         — the server-CONFIRMED committed choice (targeted replay /
 *                          re-vote ack). Authoritative.
 *   • `optimisticChoice` — the not-yet-acked local tap (instant feedback).
 *   • `results`          — the latest server tallies for THIS overlay/gen.
 *  Both choices reset when the (id, gen) round changes. */
export interface VoteState {
  myChoice?: string;
  optimisticChoice?: string;
  results: { overlayId: string; gen: number; tallies: Record<string, number>; total: number } | null;
}

/** Fresh vote state (no vote, no results). */
export function initialVoteState(): VoteState {
  return { myChoice: undefined, optimisticChoice: undefined, results: null };
}

/** Fold a server `overlay.changed` for the active overlay into the vote state,
 *  reproducing web `overlayState.setActive` + the mobile hook's `applyChanged`:
 *   • New round (next null, or id/gen changed vs `cur`) → reset optimistic/results;
 *     adopt the server `mine` if the targeted replay carried one.
 *   • Same round + a targeted `mine` (e.g. a re-vote ack) → adopt `mine`; clear the
 *     optimistic layer iff it matched (the optimistic fold then stops). PURE. */
export function applyVoteChanged(
  v: VoteState,
  cur: OverlayInstance | null,
  next: OverlayInstance | null,
  mine: string | undefined,
): VoteState {
  const roundChanged = !next || !cur || cur.id !== next.id || cur.gen !== next.gen;
  if (roundChanged) {
    return { myChoice: mine, optimisticChoice: undefined, results: null };
  }
  if (mine !== undefined) {
    return {
      ...v,
      myChoice: mine,
      optimisticChoice: v.optimisticChoice === mine ? undefined : v.optimisticChoice,
    };
  }
  return v;
}

/** Fold a server `overlay.results` tick into the vote state IFF it belongs to the
 *  active overlay at the bot's authoritative gen (`resultsMatchOverlay`). PURE. */
export function applyVoteResults(
  v: VoteState,
  active: OverlayInstance | null,
  r: OverlayResultsMsg,
): VoteState {
  if (!resultsMatchOverlay(active, r)) return v;
  return { ...v, results: { overlayId: r.overlayId, gen: r.gen, tallies: r.tallies, total: r.total } };
}

/** Register an optimistic local vote (first vote OR change-answer). Re-sending the
 *  SAME current choice is a no-op (returns `v` unchanged). PURE — the wire publish
 *  is the caller's concern (it holds the transport). */
export function applyOptimisticVote(v: VoteState, choice: string): VoteState {
  if ((v.optimisticChoice ?? v.myChoice) === choice) return v; // dup of current choice
  return { ...v, optimisticChoice: choice };
}

/** Derive the canonical `OverlayViewProps` (voted/mine/tallies/total) from the vote
 *  state via the SHARED `foldOptimisticTally` — the SAME fold web + the streamer
 *  preview use, so a re-vote MOVES the count (old−1/new+1) and a first vote is +1.
 *  `onVote` is supplied by the caller (it owns the transport). PURE otherwise. */
export function deriveVoteView(v: VoteState, onVote: (choice: string) => void): OverlayViewProps {
  const voted = v.myChoice != null || v.optimisticChoice != null;
  const mine = v.myChoice ?? v.optimisticChoice;
  const { tallies, total } = foldOptimisticTally(
    v.results?.tallies ?? {},
    v.myChoice,
    v.optimisticChoice,
    v.results?.total,
  );
  return { voted, mine, tallies, total, onVote };
}

// ── PURE doc-takeover overlay ─────────────────────────────────────────────────

/** What the viewer should PRESENT for the doc slot, given the converged streamer
 *  truth + the viewer's takeover overlay. While following, the viewer mirrors the
 *  streamer 1:1; while taken over, the viewer keeps the doc/presenter they had at
 *  takeover (the streamer's later doc/page is deferred until resync). A scene change
 *  is absolute (ends takeover). */
export interface PresentedDoc {
  doc: OverlayInstance | null;
  presenter: DocPresenterState | null;
}

/** Reconcile a freshly-converged `ViewerState` against the viewer's takeover overlay,
 *  given the PREVIOUS scene id key (to tell a scene switch from a doc-only update;
 *  `undefined` ⇒ the FIRST snapshot, never a "change"). Returns the next takeover
 *  state + the doc/presenter the viewer should PRESENT.
 *   • Scene changed → `onStreamerSceneChange`: ABSOLUTE, ends takeover, viewer follows.
 *   • Doc-only update while following → apply (present the streamer's doc).
 *   • Doc-only update while taken over → DEFER (present the held doc; the streamer's
 *     is buffered into `pending` for the eventual resync).
 *  PURE — same inputs → same output on web + RN. */
export function reconcileDocTakeover(
  takeover: DocTakeoverState,
  prevSceneId: string | null | undefined,
  next: ViewerState,
  held: PresentedDoc,
): { takeover: DocTakeoverState; presented: PresentedDoc } {
  const streamerDoc = next.slots.activeDoc;
  const streamerPresenter = next.docPresenter;
  // Scene id key: the synced LiveScene id wins; else the rendered layer's sceneId;
  // null when neither ("no scene"). A `undefined` prevSceneId is the first snapshot.
  const nextSceneId: string | null = next.scene ? next.scene.id : next.rendered.sceneId;
  const sceneChanged = prevSceneId !== undefined && nextSceneId !== prevSceneId;

  if (sceneChanged) {
    // Absolute: a scene switch ends takeover and the viewer follows the streamer.
    const { state } = onStreamerSceneChange(takeover);
    return { takeover: state, presented: { doc: streamerDoc, presenter: streamerPresenter } };
  }

  const target = {
    docId: streamerDoc ? streamerDoc.id : null,
    page: streamerDoc ? ((streamerDoc.payload as { page?: number }).page ?? 0) : 0,
    presenter: streamerPresenter,
  };
  const { state, apply } = onStreamerDocUpdate(takeover, target);
  if (apply) {
    return { takeover: state, presented: { doc: streamerDoc, presenter: streamerPresenter } };
  }
  // Deferred — keep the viewer's currently-held doc + transform.
  return { takeover: state, presented: held };
}

/** The scene id key for a converged `ViewerState` (the comparison `reconcileDocTakeover`
 *  uses): the synced LiveScene id, else the rendered layer's sceneId, else null. */
export function sceneIdKey(s: ViewerState): string | null {
  return s.scene ? s.scene.id : s.rendered.sceneId;
}
