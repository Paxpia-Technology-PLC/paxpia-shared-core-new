// WHITEBOARD-ON-DOC ANNOTATION MODEL (Message D item 2 / Contract v2.1 P4) — a
// doc-scoped annotation board that REUSES the whiteboard stroke model wholesale.
//
// ── The idea ─────────────────────────────────────────────────────────────────
// An annotation layer is a streamer-only whiteboard drawn OVER a doc overlay. Its
// strokes must persist PER-DOCUMENT (and PER-PAGE in single mode) and SWAP as the
// doc/page swaps — returning to a page restores its strokes; a blank page starts
// empty; the previous doc's/page's strokes are never discarded (present-not-destroy).
//
// ── Why it needs no new wire / no new store / no new module ───────────────────
// The annotation board is just a WHITEBOARD board whose `boardId` is DERIVED from the
// doc + page (the `wbann:…` scheme below) instead of a layout item. So:
//   • its strokes ride the SAME `overlay.wb.*` envelopes (overlays/whiteboard.ts),
//   • they fold into the SAME converged `ViewerState.boards[boardId]` via `applyWb`,
//   • a viewer reads them with the SAME `session.boardStrokes(annBoardId)`,
//   • snapshot-replay + snap-to-current resync + onReconnect come from the SAME
//     `whiteboardModule` (overlays/kinds/whiteboard.ts) — keyed by this board id.
// The ONLY new thing is the BOARD-ID DERIVATION (a doc switch / page flip computes a
// different id, so the converged store SWAPS which board is active without ever
// clearing the prior one). That is the whole contract: state is not cleared, it is
// addressed by a different key (Invariant P4).
//
// ── The key scheme (Contract v2.1 P4 / §v2.5 Step 4A) ─────────────────────────
//   • SINGLE mode → `wbann:<docId>:<page>`  — one board PER PAGE (per-page strokes).
//   • SCROLL mode → `wbann:<docId>`         — ONE continuous board for the whole doc.
// `mode` is the doc's current view mode (`DocViewMode`), so the same doc annotated in
// single vs scroll keeps its strokes in distinct keyspaces — exactly Noel's
// "single vs scroll page awareness".
//
// PURE + platform-free: just id derivation + a couple of guards. No DOM, no RN, no
// React. The render/chrome lives in `@paxpia/ui` DocOverlay; the wire lives in
// `overlays/whiteboard.ts`; this only computes WHICH board is active.

import { manifestAssetKey, type DocViewMode } from '../streaming/live';

/** The STABLE document identity an annotation board keys off — so the strokes are tied to
 *  the DOCUMENT, not the live slot/instance (Message 2026-06-23 item 7: swapping docs into
 *  the same slot must NOT keep the strokes; each doc starts blank).
 *
 *  The doc INSTANCE id is slot-keyed for a served doc (`srv_<slotId>`), so serving a
 *  DIFFERENT material into the same slot reuses the id → the same annotation board → strokes
 *  bleed across documents. Instead key off the document's CONTENT: the path-stripped source
 *  URL (`manifestAssetKey` removes the per-grant `?token=…` query, so the SAME file is the
 *  SAME id across re-grants AND across producer↔viewer). Falls back to the instance id when
 *  there's no source URL (an image-pages / placeholder doc). PURE. */
export function docAnnotationDocId(instanceId: string, sourceUrl?: string | null): string {
  const key = manifestAssetKey(sourceUrl ?? '');
  return key || instanceId;
}

/** The fixed prefix every annotation board id carries, so a doc-scoped board can be
 *  told apart from a placed-whiteboard board (`wb_tile_<itemId>`) at a glance + in a
 *  guard. A board id that starts with this is an annotation board. */
export const WB_ANN_PREFIX = 'wbann:';

/** Derive the doc-scoped ANNOTATION board id for a `(docId, page, mode)` triple.
 *    • SINGLE → `wbann:<docId>:<page>` (per-page strokes — flipping the page SWAPS the
 *      board, so each page carries its OWN annotations).
 *    • SCROLL → `wbann:<docId>` (one continuous annotation layer for the whole doc —
 *      page is irrelevant when the doc is one scrolled column).
 *  This id is used DIRECTLY as the whiteboard `boardId` (in `boards[boardId]`, on the
 *  `overlay.wb.*` wire, and in the whiteboard module's `persistKey`), so the annotation
 *  board inherits the ENTIRE whiteboard lifecycle for free. Pure + deterministic — the
 *  SAME triple always yields the SAME id, so producer + every viewer agree on the
 *  active board with no negotiation. */
export function annBoardId(docId: string, page: number, mode: DocViewMode): string {
  // In scroll mode the page is collapsed out of the key (one board per doc); in single
  // mode each page is its own board. `docId` is the stable doc/material id (NOT a mount
  // nonce, NOT a scene-item id), so re-serving the same doc resumes its annotations.
  return mode === 'scroll' ? `${WB_ANN_PREFIX}${docId}` : `${WB_ANN_PREFIX}${docId}:${page}`;
}

/** True iff a board id is a doc-scoped annotation board (vs a placed-whiteboard tile).
 *  Lets a consumer (the wire router / a viewer) tell an annotation stroke apart from a
 *  tile stroke without parsing the whole id. */
export function isAnnBoardId(boardId: string): boolean {
  return boardId.startsWith(WB_ANN_PREFIX);
}

/** The `(docId, page?)` an annotation board id encodes, or null when it isn't an
 *  annotation board id. The inverse of `annBoardId` — `page` is present only for a
 *  SINGLE-mode (`wbann:<docId>:<page>`) id, absent for a SCROLL-mode (`wbann:<docId>`)
 *  id. Used to recover the owning doc/page from a bare board id (e.g. a viewer
 *  correlating a stroke to the doc it should paint under). Pure. */
export function parseAnnBoardId(boardId: string): { docId: string; page?: number } | null {
  if (!isAnnBoardId(boardId)) return null;
  const rest = boardId.slice(WB_ANN_PREFIX.length);
  // SINGLE: `<docId>:<page>` — split on the LAST colon so a docId containing a colon
  // (unlikely, but a presigned-ish id) still parses; SCROLL: `<docId>` (no colon tail).
  const lastColon = rest.lastIndexOf(':');
  if (lastColon >= 0) {
    const maybePage = rest.slice(lastColon + 1);
    const page = Number(maybePage);
    // A trailing numeric segment ⇒ single-mode page; otherwise the whole rest is the doc
    // id (a docId that itself ended in `:something-non-numeric` → scroll-shaped).
    if (maybePage !== '' && Number.isInteger(page) && page >= 0) {
      return { docId: rest.slice(0, lastColon), page };
    }
  }
  return { docId: rest };
}

/** The doc-annotation descriptor a producer broadcasts + a viewer reads off the doc
 *  overlay so both know (a) whether annotation is ON and (b) WHICH board id is active.
 *  Rides ALONGSIDE the doc placement (the streamer toggles it; a page flip / doc switch
 *  recomputes `boardId` via `annBoardId`). When `on` is false the viewer renders no
 *  annotation layer; when true it renders `session.boardStrokes(boardId)` over the doc.
 *
 *  This is the ONLY annotation-specific thing on the wire — the strokes themselves are
 *  plain `overlay.wb.*` keyed by `boardId`. A null/absent descriptor ⇒ annotation off. */
export interface DocAnnotationState {
  /** Whether the streamer has the annotation layer toggled ON (streamer-only control).
   *  Viewers render annotations only when true. */
  on: boolean;
  /** The ACTIVE annotation board id for the doc's CURRENT (docId, page, mode) — the
   *  `wbann:…` id whose strokes the viewer paints. Recomputed on every page flip / doc
   *  switch / mode change via `annBoardId`, so it always points at the right board. */
  boardId: string;
  /** The doc's current view mode the active board id was derived under (single ⇒
   *  per-page, scroll ⇒ per-doc), carried so a viewer can re-derive / display it. */
  mode: DocViewMode;
}

/** Build the active `DocAnnotationState` for a doc's current `(docId, page, mode)` +
 *  toggle. The single place a producer computes the descriptor it broadcasts and a
 *  viewer re-derives locally — so the board id is ALWAYS `annBoardId(docId, page, mode)`
 *  and can never drift between the two sides. Pure. */
export function docAnnotationStateFor(
  docId: string,
  page: number,
  mode: DocViewMode,
  on: boolean,
): DocAnnotationState {
  return { on, boardId: annBoardId(docId, page, mode), mode };
}
