// Doc-viewer LOCAL TAKEOVER state machine — the platform-agnostic brain for "a
// viewer leans in on the synced document". By default a viewer FOLLOWS the
// streamer's doc (its source/page + the presenter's pan/zoom ride the live-sync
// wire). The moment the viewer drags/pans/zooms the doc themselves they TAKE OVER
// local control: their focus is theirs to keep, and the streamer's doc SOURCE/PAGE
// changes are DEFERRED (they don't yank the viewer's view) until the viewer hits
// "resync" — which snaps them back to the streamer's CURRENT doc + page + presenter
// transform.
//
// ── The one hard rule (asymmetry) ────────────────────────────────────────────
// SCENE changes are ABSOLUTE: a viewer must NEVER be in a scene the streamer didn't
// set. So a scene switch ENDS takeover immediately and the viewer follows. Only a
// doc SOURCE/PAGE change is deferrable during takeover. This asymmetry is the whole
// point of the machine and is enforced HERE (once), so web + mobile can never drift.
//
// ── Why this lives in @paxpia/core ───────────────────────────────────────────
// The decision "does this streamer update apply now, or is it pending behind a
// resync?" is pure logic with no DOM/RN deps. Web (DocOverlay/StreamView) and
// mobile (DocOverlayView/LivestreamViewerScreen) are thin render layers: they emit
// events (the viewer touched the doc / a live-sync arrived / resync tapped) and
// render the banner + resync button off `isTakenOver(state)`. No takeover logic is
// re-implemented per platform.

import type { DocPresenterState } from './live';

/** Local takeover status for the doc viewer.
 *   'follow'   — default: the viewer mirrors the streamer's doc 1:1.
 *   'takeover' — the viewer panned/zoomed/changed page locally; they are now OUT
 *                OF SYNC with the streamer and a banner + resync button show. */
export type DocTakeoverStatus = 'follow' | 'takeover';

/** The doc-takeover state. Tiny + serializable so the render layer holds exactly
 *  this. `pending` is the streamer's LATEST doc source/page + presenter transform
 *  that arrived WHILE taken over — buffered so a resync can snap straight to it
 *  without waiting for the next broadcast. */
export interface DocTakeoverState {
  status: DocTakeoverStatus;
  /** The streamer's latest deferred doc target captured during takeover (the
   *  doc/material id + page + presenter transform to jump to on resync). Null when
   *  following (nothing deferred) or when no doc update has arrived since takeover. */
  pending: PendingDocTarget | null;
}

/** A buffered streamer doc target (what a resync will jump the viewer to). */
export interface PendingDocTarget {
  /** The streamer's current doc/material id (so a SOURCE change is reflected). */
  docId: string | null;
  /** The streamer's current synced page. */
  page: number;
  /** The streamer's presenter pan/zoom transform (snap the view to this). */
  presenter: DocPresenterState | null;
}

/** Fresh state — a viewer starts FOLLOWING the streamer (no takeover, nothing
 *  pending). */
export function initialDocTakeover(): DocTakeoverState {
  return { status: 'follow', pending: null };
}

/** True iff the viewer has locally taken over (drives the "Out of sync" banner +
 *  the resync button). */
export function isTakenOver(s: DocTakeoverState): boolean {
  return s.status === 'takeover';
}

/** The viewer locally panned / zoomed / changed page on the doc → TAKE OVER. From
 *  here the streamer's doc source/page updates are deferred (buffered into
 *  `pending`) until resync. Idempotent: a second local gesture while already taken
 *  over just stays in takeover (keeping any buffered pending target). */
export function takeOverDoc(s: DocTakeoverState): DocTakeoverState {
  if (s.status === 'takeover') return s;
  return { status: 'takeover', pending: null };
}

/** A streamer DOC update (new source / page flip / presenter move) arrived.
 *   • Following → APPLY now (return `apply: true`); state unchanged.
 *   • Taken over → DEFER: buffer the latest target into `pending` and DON'T apply
 *     (`apply: false`) so the viewer keeps their focus until they resync.
 *  The render layer reads `apply` to decide whether to move the viewer's doc view. */
export function onStreamerDocUpdate(
  s: DocTakeoverState,
  target: PendingDocTarget,
): { state: DocTakeoverState; apply: boolean } {
  if (s.status === 'follow') {
    return { state: s, apply: true };
  }
  // Taken over: keep the LATEST streamer target buffered for the eventual resync.
  return { state: { ...s, pending: target }, apply: false };
}

/** A streamer SCENE change arrived. This is ABSOLUTE — it ENDS takeover and the
 *  viewer follows immediately (a viewer must never be in a scene the streamer
 *  didn't set). Returns the follow state + the pending target (if any) so the
 *  render layer can snap the doc to the streamer's current view as it follows.
 *  When already following this is a no-op (apply the scene normally). */
export function onStreamerSceneChange(s: DocTakeoverState): {
  state: DocTakeoverState;
  /** The doc target the viewer should snap to as takeover ends (the buffered
   *  streamer target, or null when nothing was deferred / already following). */
  snapTo: PendingDocTarget | null;
} {
  if (s.status === 'follow') return { state: s, snapTo: null };
  return { state: initialDocTakeover(), snapTo: s.pending };
}

/** The viewer tapped RESYNC → end takeover, follow the streamer again, and snap to
 *  the streamer's CURRENT doc + page + presenter transform. Returns the follow
 *  state + the target to jump to (the buffered pending target if a doc update
 *  arrived during takeover; else null → the caller snaps to the streamer's live
 *  doc/presenter it already holds). */
export function resyncDoc(s: DocTakeoverState): {
  state: DocTakeoverState;
  snapTo: PendingDocTarget | null;
} {
  return { state: initialDocTakeover(), snapTo: s.pending };
}
