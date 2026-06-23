// OVERLAY VIEW-STATE PERSISTENCE STORE (Contract v2.1 — the stable OWNER) — fixes
// Bug 1a (state LOST on a scene toggle) at the MODEL level.
//
// ── The bug, model-level ─────────────────────────────────────────────────────
// A doc's VIEW (page + zoom/pan) lived in a SINGLE global slot (`docPresenter`) the
// scene switch nulled (`director/session.ts:333`), and the operator's whiteboard
// strokes lived in COMPONENT `useState` the scene-unmount destroyed. Returning to a
// scene dropped the doc's page+zoom and the board's strokes. Root cause: there was no
// stable, scene-INDEPENDENT OWNER for overlay VIEW state keyed by a stable id.
//
// ── The fix ──────────────────────────────────────────────────────────────────
// Invariant P2: the authoritative owner of overlay state is the shared render-brain's
// converged store — NOT any React component — keyed by a `persistKey` derived from
// stable ids (P4). Strokes already live there (`ViewerState.boards[boardId]`, keyed by
// the layout-stable `wb_tile_<itemId>`). This module ADDS the missing half: a per-
// (scene-item / doc) VIEW store `{page, transform}` keyed by `persistKey`, so the doc
// presenter is no longer a single global slot.
//
// Invariant P3 (PRESENT-not-DESTROY): a SCENE/DOC/PAGE transition NEVER clears this
// store — it only changes WHICH key is presented. A board/doc that re-appears in a
// later scene re-presents from its persisted entry. So a scene toggle that drops the
// doc page+zoom is structurally impossible: the state is not cleared, it is addressed
// by a key the transition doesn't touch.
//
// PURE + platform-free: a record of keys → DocViewState + the pure put/read reducers.
// The store is a sibling map ON `ViewerState` (the converged owner), folded by the
// same render-brain seam everything else folds through.

import type { PersistKey, DocViewState, OverlayTransform } from '../overlays/module';
import { emptyDocView, brandPersistKey } from '../overlays/module';

/** Derive the DOC view persist key from a doc/material id (per-doc VIEW key:
 *  `doc:<docId>`). The doc module's `persistKey` delegates here so the converged
 *  store's doc-presenter promotion (`applyLiveSync`) and the module agree on ONE key —
 *  re-serving the same doc resumes its exact page+transform (P4). Pure. */
export function docViewPersistKey(docId: string): PersistKey {
  return brandPersistKey(`doc:${docId}`);
}

/** The persisted VIEW store: `persistKey` → the doc/board VIEW state that MUST
 *  survive scene/doc/page transitions (Invariant P1). A plain record so it's trivially
 *  serializable and reads are O(1). Strokes are NOT here — they live in
 *  `ViewerState.boards` keyed by boardId; this store owns the transform-bearing VIEW
 *  (page + zoom/pan) that the single global `docPresenter` slot used to drop. */
export type ViewStore = Record<string, DocViewState>;

/** A fresh, empty view store. */
export function emptyViewStore(): ViewStore {
  return {};
}

/** Read a key's persisted view, or the empty fit-view when nothing has been stored
 *  yet (so a first present paints a fit view, then converges). Pure. */
export function readView(store: ViewStore, key: PersistKey): DocViewState {
  return store[key] ?? emptyDocView();
}

/** True iff a key has a persisted view (distinguishes "never presented" from "reset
 *  to fit"). */
export function hasView(store: ViewStore, key: PersistKey): boolean {
  return key in store;
}

/** PRESENT-not-DESTROY put: write the full VIEW for a key. Returns the SAME store ref
 *  when the value is referentially unchanged (so a no-op fold coalesces to zero
 *  re-renders). This is the ONLY writer — a scene/doc/page transition NEVER deletes,
 *  it re-keys (P3/P4). Pure. */
export function putView(store: ViewStore, key: PersistKey, view: DocViewState): ViewStore {
  const prev = store[key];
  if (prev && prev.page === view.page && transformEq(prev.transform, view.transform)) return store;
  return { ...store, [key]: view };
}

/** Persist just the PAGE for a key, keeping its transform (a page flip preserves
 *  zoom — Invariant P3 "page switch preserves zoom"). Pure. */
export function putViewPage(store: ViewStore, key: PersistKey, page: number): ViewStore {
  const cur = readView(store, key);
  return putView(store, key, { page, transform: { ...cur.transform, page } });
}

/** Persist just the TRANSFORM for a key, keeping its page. Pure. */
export function putViewTransform(store: ViewStore, key: PersistKey, transform: OverlayTransform): ViewStore {
  const cur = readView(store, key);
  return putView(store, key, { page: cur.page, transform });
}

/** Referential-or-value transform equality (so a re-broadcast of the same transform
 *  doesn't churn the store). */
function transformEq(a: OverlayTransform, b: OverlayTransform): boolean {
  return (
    a.zoom === b.zoom &&
    a.panX === b.panX &&
    a.panY === b.panY &&
    (a.page ?? undefined) === (b.page ?? undefined)
  );
}
