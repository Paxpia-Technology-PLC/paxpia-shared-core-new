// WHITEBOARD overlay module (Contract v2.4) — wraps the EXISTING `applyWb` gen-aware
// stroke reducer into the per-kind `OverlayModule` contract. This is the module
// AGENT C consumes for the whiteboard board-ownership + resync fix: it provides the
// `OverlayModule` face (persistKey + snapshot + applyRemote + merge + gen + onResync +
// onReconnect) over the converged stroke set, so the board's strokes are owned by the
// render-brain store (`ViewerState.boards`), not a React component the scene unmounts
// (fixes Bug 1.2 at the model level), and resync snaps the board's TRANSFORM to the
// converged current value (fixes Bug 2 for the whiteboard).
//
// CONTENT vs VIEW split (Contract v2.2): the STROKES are content (the `WbBoardState`
// this module's `applyRemote` folds); the TRANSFORM (zoom/pan) is view (the persisted
// `DocViewState` `onResync` snaps to). Strokes append during takeover; only the
// transform is deferred + snapped on resync. The transform is persisted in the SAME
// keyed view store the doc uses (1C), keyed by the board's `persistKey`.

import type { OverlayInstance } from '../types';
import type { WhiteboardPayload } from '../types';
import {
  applyWb,
  emptyBoard,
  encodeWbMsg,
  WB_WIRE_VERSION,
  type WbBoardState,
  type WbMsg,
  type WbStroke,
} from '../whiteboard';
import { viewFor } from '../../streaming/viewer';
import { brandPersistKey } from '../module';
import type { OverlayModule, PersistKey, PersistCtx } from '../module';

/** Derive the WHITEBOARD persist key from a board's stable id (the layout-stable
 *  `wb_tile_<itemId>` carried on `payload.boardId`). The board's STROKES live in
 *  `ViewerState.boards[boardId]`; its TRANSFORM view lives in the keyed view store
 *  under THIS key. NEVER a mount nonce (P4). Pure. */
export function wbViewPersistKey(boardId: string): PersistKey {
  return brandPersistKey(`wb:${boardId}`);
}

/** The WHITEBOARD module. State = the converged `WbBoardState` (gen + strokes); delta
 *  = a `WbMsg` (stroke/erase/wipe/snapshot); resync snaps to the board's persisted
 *  transform. */
export const whiteboardModule: OverlayModule<'whiteboard'> = {
  kind: 'whiteboard',

  /** Per-BOARD view key (`wb:<boardId>`) — derived from the layout-stable board id, so
   *  the board's transform survives a scene unmount (the strokes already survive in
   *  `boards[boardId]`). */
  persistKey(inst: OverlayInstance<WhiteboardPayload>, _ctx: PersistCtx): PersistKey {
    return wbViewPersistKey(inst.payload.boardId);
  },

  /** Snapshot the FULL stroke set at the board's gen — the late-joiner `overlay.wb.snapshot`
   *  the producer replies with (folds into the ONE ReconnectPlan, §4). */
  snapshot(state: WbBoardState): WbMsg {
    return wbSnapshotFor('', state); // boardId stamped by the caller's onReconnect/key
  },

  /** Apply a LOCAL author mutation (a drawn stroke / erase / wipe / full snapshot) to
   *  the board + return the `overlay.wb.*` wire to broadcast. Folds through the SAME
   *  `applyWb` reducer a viewer uses, so operator + viewer converge identically. Pure. */
  applyLocal(state, mutation) {
    const next = applyWb(state, mutation.msg);
    return { state: next, out: [{ bytes: encodeWbMsg(mutation.msg), reliable: true }] };
  },

  /** Capture a content-only screenshot of the board (web `<a download>` / mobile
   *  CameraRoll execute it; core only models the intent). */
  capture(_state, key): { key: PersistKey; filename: string } {
    return { key, filename: 'whiteboard.png' };
  },

  /** Fold a REMOTE whiteboard delta into the converged stroke set via the gen-aware
   *  `applyWb` (snapshot REPLACES, wipe bumps gen, newer-gen stroke ⇒ missed-wipe ⇒
   *  fresh, stale gen drops). Pure — referentially stable on a no-op. */
  applyRemote(state, delta: WbMsg): WbBoardState {
    return applyWb(state, delta);
  },

  /** Additive merge of two board states (snapshot ∪ live deltas). The HIGHER gen wins
   *  (a newer wipe supersedes); at the SAME gen the UNION of strokes by id (commutative
   *  + idempotent so snapshot-then-deltas and deltas-then-snapshot converge, §4). */
  merge(a, b): WbBoardState {
    if (a.gen !== b.gen) return a.gen > b.gen ? a : b;
    // Same gen → union strokes by id, preserving first-seen order (a then b's new ids).
    const seen = new Set(a.strokes.map((s) => s.id));
    const merged: WbStroke[] = a.strokes.slice();
    for (const s of b.strokes) if (!seen.has(s.id)) merged.push(s);
    if (merged.length === a.strokes.length) return a; // no new strokes → stable ref
    return { gen: a.gen, strokes: merged };
  },

  /** The board's monotonic clock — its generation (wipe-bumped). */
  gen(state): number {
    return state.gen;
  },

  /** RESYNC: snap to the board's CURRENT converged TRANSFORM from the keyed view store
   *  — NEVER a replayed backlog (Bug 2). The strokes are content (already converged in
   *  `boards`); only the transform is snapped here, exactly as the doc does. */
  onResync(store, key): { transform: ReturnType<typeof viewFor>['transform'] } | null {
    const view = viewFor(store, key);
    return { transform: view.transform };
  },

  /** RECONNECT replay: re-broadcast the board's full stroke snapshot at its gen so a
   *  (re)joining viewer reconstructs it (folds into the ONE ReconnectPlan.replay, §4 —
   *  never an ad-hoc per-join effect). The boardId is recovered from the key. */
  onReconnect(state, key): { bytes: Uint8Array; reliable: boolean }[] {
    const boardId = boardIdFromKey(key);
    return [{ bytes: encodeWbMsg(wbSnapshotFor(boardId, state)), reliable: true }];
  },
};

/** Build the `overlay.wb.snapshot` for a board's converged state. */
function wbSnapshotFor(boardId: string, state: WbBoardState): WbMsg {
  return {
    t: 'overlay.wb.snapshot',
    v: WB_WIRE_VERSION,
    boardId,
    gen: state.gen,
    strokes: state.strokes.slice(),
  };
}

/** Recover the boardId from a `wb:<boardId>` persist key (the inverse of
 *  `wbViewPersistKey`). */
function boardIdFromKey(key: PersistKey): string {
  const s = key as string;
  return s.startsWith('wb:') ? s.slice(3) : s;
}

/** Re-export the empty board so the registry/tests can assert the shape. */
export { emptyBoard };
