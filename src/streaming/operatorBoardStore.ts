// operatorBoardStore — the ONE shared, module-level OPERATOR whiteboard store (WI-10).
//
// ── THE PARITY BUG IT FIXES ───────────────────────────────────────────────────
// The operator's authored board (strokes + generation) must SURVIVE a scene switch.
// A placed whiteboard tile only mounts for the ACTIVE scene's items, so switching
// scenes unmounts it; if the strokes live in component state they die on unmount and
// are GONE when the scene is re-entered. On the WEB viewer they persisted because the
// operator board lived in a module-level store keyed by a STABLE board id
// (`Paxpia-web/src/streaming/whiteboard.ts operatorBoardStore`) that outlives the
// tile. Mobile kept them in component state → lost. This module LIFTS that web store
// into `@paxpia/core` so BOTH platforms persist identically — one store, one id key,
// one converged owner (the operator-side analogue of a viewer's
// `ViewerState.boards[boardId]`).
//
// ── KEYING ────────────────────────────────────────────────────────────────────
// Keyed by the STABLE board id `wb_tile_<itemId>` (`director.wbBoardIdForItem`) so a
// board that re-appears in a later scene re-presents its EXACT strokes. Never keyed by
// scene or component identity (those are ephemeral).
//
// ── WHAT IT HOLDS ─────────────────────────────────────────────────────────────
// Per board id: the converged `WbBoardState` ({gen, strokes}) folded by the SAME pure
// `applyWb` reducer the wire + the viewer use (so the operator paints from the same
// owner a viewer's render-brain holds), PLUS a per-board operator REDO stack (also
// module-level so undo/redo survives a scene toggle, like the board). A new draw/clear
// invalidates the redo stack.
//
// PURE + platform-free: no DOM, no RN, no React. A platform hook subscribes to a board
// id and re-renders on change; the apply/undo/redo helpers mutate the store + notify.

import { applyWb, emptyBoard, type WbBoardState, type WbMsg, type WbStroke } from '../overlays/whiteboard';

type BoardListener = (board: WbBoardState) => void;

// The converged operator board per stable board id. Survives tile unmount on a scene
// switch (module-level) → strokes persist across scenes, matching the web viewer.
const boards = new Map<string, WbBoardState>();
const subs = new Map<string, Set<BoardListener>>();
// Per-board operator REDO stack (module-level so it survives the tile's unmount, like
// the board). A fresh draw / clear invalidates it (you can't redo past a new action).
const redo = new Map<string, WbStroke[]>();

/** Read the current converged board for a stable board id (empty board if untouched). */
export function getOperatorBoard(boardId: string): WbBoardState {
  return boards.get(boardId) ?? emptyBoard();
}

/** Subscribe to a board id's changes — the listener fires whenever the board state for
 *  that id changes (a draw/clear/undo/redo/remote-echo). Returns an unsubscribe fn. The
 *  redo stack changes always coincide with a board change (undo removes a stroke + pushes
 *  redo; redo re-adds + pops), so a single board subscription covers both for re-render. */
export function subscribeOperatorBoard(boardId: string, cb: BoardListener): () => void {
  let set = subs.get(boardId);
  if (!set) {
    set = new Set();
    subs.set(boardId, set);
  }
  set.add(cb);
  return () => {
    const s = subs.get(boardId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) subs.delete(boardId);
  };
}

/** Set a board's state and notify subscribers (no-op if the ref is unchanged so React
 *  doesn't churn — `applyWb` returns the same ref for a no-op fold). Internal. */
function writeBoard(boardId: string, next: WbBoardState): WbBoardState {
  const prev = boards.get(boardId);
  if (prev === next) return next;
  boards.set(boardId, next);
  subs.get(boardId)?.forEach((cb) => cb(next));
  return next;
}

/** Fold one decoded whiteboard message into a board (gen-aware, via the shared `applyWb`)
 *  and notify. The single mutate entry — a local author stroke, a wipe, an undo erase, a
 *  redo re-stroke, or a remote echo all funnel through here so the store is the converged
 *  owner. Returns the resulting board. Does NOT touch the redo stack (the helpers below
 *  own redo bookkeeping). */
export function applyOperatorBoard(boardId: string, msg: WbMsg): WbBoardState {
  const next = applyWb(getOperatorBoard(boardId), msg);
  return writeBoard(boardId, next);
}

// ── Authoring helpers (used by both platforms' studio hooks) ──────────────────
// Each returns the wire message the caller should BROADCAST (so the transport stays in
// the platform hook), having already folded it into the shared store. The hook subscribes
// to the board id, so the local fold re-renders the operator surface; the returned message
// is published so viewers + other devices converge to the same store-owned state.

/** Append a finished author stroke at the board's current gen. Folds locally + returns the
 *  `overlay.wb.stroke` wire msg to publish. A NEW draw invalidates the redo stack. */
export function operatorAddStroke(boardId: string, stroke: WbStroke): WbMsg {
  const gen = getOperatorBoard(boardId).gen;
  const msg: WbMsg = { t: 'overlay.wb.stroke', v: 1, boardId, gen, stroke };
  applyOperatorBoard(boardId, msg);
  redo.delete(boardId); // a fresh action invalidates redo
  return msg;
}

/** Clear the board for everyone: bump the gen + clear. Folds locally + returns the
 *  `overlay.wb.wipe` wire msg to publish. Invalidates the redo stack. */
export function operatorClear(boardId: string): WbMsg {
  const nextGen = getOperatorBoard(boardId).gen + 1;
  const msg: WbMsg = { t: 'overlay.wb.wipe', v: 1, boardId, gen: nextGen };
  applyOperatorBoard(boardId, msg);
  redo.delete(boardId);
  return msg;
}

/** Undo the LAST stroke on the board: erase-by-id (folded locally) + push it to the redo
 *  stack. Returns the `overlay.wb.erase` wire msg to publish, or null when there's nothing
 *  to undo (the caller skips publishing). */
export function operatorUndo(boardId: string): WbMsg | null {
  const prev = getOperatorBoard(boardId);
  const last = prev.strokes[prev.strokes.length - 1];
  if (!last) return null;
  const msg: WbMsg = { t: 'overlay.wb.erase', v: 1, boardId, gen: prev.gen, id: last.id };
  applyOperatorBoard(boardId, msg);
  redo.set(boardId, [...(redo.get(boardId) ?? []), last]);
  return msg;
}

/** Redo the most-recently-undone stroke: pop the redo stack + re-append. Returns the
 *  `overlay.wb.stroke` wire msg to publish, or null when the redo stack is empty. */
export function operatorRedo(boardId: string): WbMsg | null {
  const stack = redo.get(boardId);
  if (!stack || stack.length === 0) return null;
  const stroke = stack[stack.length - 1];
  redo.set(boardId, stack.slice(0, -1));
  const gen = getOperatorBoard(boardId).gen;
  const msg: WbMsg = { t: 'overlay.wb.stroke', v: 1, boardId, gen, stroke };
  applyOperatorBoard(boardId, msg);
  return msg;
}

/** Whether a redo is currently possible for a board (drives the chrome Redo button). */
export function operatorCanRedo(boardId: string): boolean {
  return (redo.get(boardId)?.length ?? 0) > 0;
}

/** TEST/RESET only: drop a board's state + redo (or all boards). Not used in app flow —
 *  the whole point is persistence — but lets tests start from a clean store. */
export function resetOperatorBoard(boardId?: string): void {
  if (boardId == null) {
    boards.clear();
    subs.clear();
    redo.clear();
    return;
  }
  boards.delete(boardId);
  redo.delete(boardId);
}
