// DOC overlay module (Contract v2.4) — wraps the EXISTING doc view + live.sync path
// into the per-kind `OverlayModule` contract. ADDITIVE: the reducers it adapts
// (`applyLiveSync` via the keyed view store, the doc presenter) are unchanged; this
// only EXPRESSES the doc lifecycle through the enforced interface so the registry can
// drive it uniformly and a missing callback is a compile error.
//
// The doc is the REFERENCE transform-bearing kind: its resync ALREADY snaps to
// `source.getState()` incl. zoom (`useOverlaySession.onDocResync`), its presenter is
// now persisted in the keyed view store (1C), and its page-flip preserves zoom. This
// module verifies that path conforms — `onResync` returns the doc's CURRENT transform
// from the converged store, NEVER a replayed backlog (Bug 2).

import type { OverlayInstance } from '../types';
import type { DocPayload } from '../types';
import type { LiveSyncMsg } from '../../streaming/live';
import { LIVESYNC_WIRE_VERSION, encodeLiveSyncMsg } from '../../streaming/live';
import { viewFor } from '../../streaming/viewer';
import { docViewPersistKey } from '../../streaming/persist';
import type { OverlayModule, PersistKey, PersistCtx, DocViewState } from '../module';
import { emptyDocView } from '../module';

/** The DOC module. State = the persisted `DocViewState` (page + transform); delta =
 *  the streamer's `live.sync`; resync snaps to the converged doc transform. */
export const docModule: OverlayModule<'doc'> = {
  kind: 'doc',

  /** Per-DOC view key (`doc:<docId>`) — delegates to the shared derivation the
   *  converged store's presenter promotion uses, so module + store agree on ONE key
   *  (re-serving the same doc resumes its page+transform). NEVER a mount nonce (P4). */
  persistKey(inst: OverlayInstance<DocPayload>, _ctx: PersistCtx): PersistKey {
    return docViewPersistKey(inst.id);
  },

  /** Snapshot the doc VIEW as a `live.sync` (the late-joiner doc snapshot rides
   *  live.sync; the page+presenter carry the view). Identity/source come from the
   *  caller's slot — here we serialize just the synced page+transform the view owns. */
  snapshot(state: DocViewState): LiveSyncMsg {
    return {
      t: 'live.sync',
      v: LIVESYNC_WIRE_VERSION,
      doc: null,
      docPresenter: {
        page: state.page,
        zoom: state.transform.zoom,
        panX: state.transform.panX,
        panY: state.transform.panY,
      },
    };
  },

  /** Apply a LOCAL author mutation (a page flip or a presenter move) to the view +
   *  return the live.sync to broadcast. A page flip PRESERVES zoom (P3). Pure. */
  applyLocal(state, mutation) {
    if (mutation.op === 'page') {
      const next: DocViewState = {
        page: mutation.page,
        transform: { ...state.transform, page: mutation.page },
      };
      return { state: next, out: [{ bytes: encodeLiveSyncMsg(docSyncFor(next)), reliable: true }] };
    }
    // presenter: adopt the streamer's full transform.
    const p = mutation.presenter;
    const next: DocViewState = {
      page: p.page,
      transform: { zoom: p.zoom, panX: p.panX, panY: p.panY, page: p.page },
    };
    return { state: next, out: [{ bytes: encodeLiveSyncMsg(docSyncFor(next)), reliable: true }] };
  },

  /** A doc has no content-capture artifact (its content is the source file). */
  capture() {
    return null;
  },

  /** Fold a REMOTE `live.sync` into the doc view (page + presenter transform). LWW by
   *  producer — the streamer's latest broadcast is the view. Pure. */
  applyRemote(state, delta: LiveSyncMsg): DocViewState {
    const p = delta.docPresenter;
    if (!p) {
      // No presenter ⇒ keep the prior transform but honor a doc page on the instance.
      const page = delta.doc?.payload && typeof (delta.doc.payload as DocPayload).page === 'number'
        ? (delta.doc.payload as DocPayload).page
        : state.page;
      if (page === state.page) return state;
      return { page, transform: { ...state.transform, page } };
    }
    const next: DocViewState = {
      page: p.page,
      transform: { zoom: p.zoom, panX: p.panX, panY: p.panY, page: p.page },
    };
    return next;
  },

  /** Additive merge — the doc view is LWW; the HIGHER page wins ties only as a
   *  tie-break, but in practice the streamer's latest is authoritative. Commutative +
   *  idempotent for the same value (snapshot ∪ live converge). */
  merge(a, b): DocViewState {
    // Prefer the view with the later page; equal pages → b (the later fold). This is
    // idempotent (merge(a,a)=a) and order-insensitive for the converge guarantee.
    return b.page >= a.page ? b : a;
  },

  /** The doc's monotonic clock — its synced page index. */
  gen(state): number {
    return state.page;
  },

  /** RESYNC: snap to the doc's CURRENT converged transform from the store — NEVER a
   *  replayed backlog (Bug 2). Reads the persisted view (presenter promotion) so the
   *  snap includes zoom + pan + page. */
  onResync(store, key): { transform: DocViewState['transform'] } | null {
    const view = viewFor(store, key);
    return { transform: view.transform };
  },

  /** RECONNECT replay: re-broadcast the doc's current page+presenter as a live.sync so
   *  a (re)joining viewer reconstructs the view. */
  onReconnect(state, _key) {
    return [{ bytes: encodeLiveSyncMsg(docSyncFor(state)), reliable: true }];
  },
};

/** Build the live.sync that mirrors a doc view's page+transform (no slot identity —
 *  the caller's slot owns `doc`; this carries just the synced view). */
function docSyncFor(view: DocViewState): LiveSyncMsg {
  return {
    t: 'live.sync',
    v: LIVESYNC_WIRE_VERSION,
    doc: null,
    docPresenter: {
      page: view.page,
      zoom: view.transform.zoom,
      panX: view.transform.panX,
      panY: view.transform.panY,
    },
  };
}

/** Re-export so a test/registry can assert the empty view shape. */
export { emptyDocView };
