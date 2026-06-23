// SVG overlay module (Contract v2.4) — wraps the EXISTING TTL'd id-keyed svg set into
// the per-kind `OverlayModule` contract. Not transform-bearing (ResyncSnap → never →
// onResync null) and no content-capture. The persist key is the svg id (the set is
// already keyed by id; the converged owner is the svg set, not a component).
//
// NOTE the svg set carries wall-clock expiries (`receivedAtMs`/`expiresAtMs`); the
// `applyLocal`/`set` path takes the injected `nowMs` (core never reads a wall clock).

import type { OverlayInstance } from '../types';
import {
  SVG_OVERLAY_WIRE_VERSION,
  encodeSvgOverlayMsg,
  setSvgOverlay,
  deleteSvgOverlay,
  emptySvgOverlays,
  type SvgOverlayState,
  type SvgOverlayMsg,
} from '../svg';
import { brandPersistKey } from '../module';
import type { OverlayModule, PersistKey, PersistCtx } from '../module';

/** The SVG module. State = the TTL'd id-keyed set; delta = an `overlay.svg` /
 *  `overlay.svg.delete`; no transform → no resync snap. */
export const svgModule: OverlayModule<'svg'> = {
  kind: 'svg',

  /** Per-svg key (`svg:<id>`) — the set is already id-keyed; this brands it. NEVER a
   *  mount nonce (P4). */
  persistKey(inst: OverlayInstance, _ctx: PersistCtx): PersistKey {
    return brandPersistKey(`svg:${inst.id}`);
  },

  /** No single-message snapshot for a SET — the late-join path re-emits each entry.
   *  We return a delete sentinel for the (unused) snapshot member; the real replay is
   *  `onReconnect` re-emitting each live svg. (A SET needs the id+svg, not derivable
   *  from a bare state here without iterating — handled in onReconnect.) */
  snapshot(_state: SvgOverlayState): SvgOverlayMsg {
    // A set has no single canonical snapshot message; callers use onReconnect (which
    // re-emits each entry). Return a no-op delete of a sentinel id so the member is
    // satisfied without inventing a fake SET.
    return { t: 'overlay.svg.delete', v: SVG_OVERLAY_WIRE_VERSION, id: '' };
  },

  /** Apply a LOCAL set/delete to the svg set + return the wire. Pure (nowMs injected). */
  applyLocal(state, mutation) {
    if (mutation.op === 'delete') {
      const id = mutation.msg.t === 'overlay.svg.delete' ? mutation.msg.id : '';
      return {
        state: deleteSvgOverlay(state, id),
        out: [{ bytes: encodeSvgOverlayMsg(mutation.msg), reliable: true }],
      };
    }
    // set
    const next =
      mutation.msg.t === 'overlay.svg'
        ? setSvgOverlay(state, mutation.msg, mutation.nowMs)
        : state;
    return { state: next, out: [{ bytes: encodeSvgOverlayMsg(mutation.msg), reliable: true }] };
  },

  /** No content-capture artifact. */
  capture() {
    return null;
  },

  /** Fold a REMOTE svg delta into the set. A SET needs a receive time; we stamp the
   *  current entry's expiry off the delta's own ttl from `setSvgOverlay` — but since
   *  `applyRemote` has no clock here, a SET uses 0 as the base (the TTL pruner runs
   *  with the real clock on the platform). A DELETE removes by id. Pure. */
  applyRemote(state, delta: SvgOverlayMsg): SvgOverlayState {
    if (delta.t === 'overlay.svg.delete') return deleteSvgOverlay(state, delta.id);
    // SET — the platform's ingest folds with the real nowMs; this module-level fold
    // stamps receive at 0 so a clockless path still records it (the pruner corrects).
    return setSvgOverlay(state, delta, 0);
  },

  /** Additive merge — union by id, later entry wins per id (LWW by re-send). */
  merge(a, b): SvgOverlayState {
    return { ...a, ...b };
  },

  /** The svg set has no single monotonic gen — count of live entries as a coarse
   *  clock (each set/delete changes it). */
  gen(state): number {
    return Object.keys(state).length;
  },

  /** No view to snap (ResyncSnap<'svg'> is `never`). */
  onResync() {
    return null;
  },

  /** RECONNECT replay: re-emit each live svg as a SET so a (re)joining viewer
   *  reconstructs the decorations (TTL re-emit). */
  onReconnect(state, _key) {
    return Object.values(state).map((o) => ({
      bytes: encodeSvgOverlayMsg({ t: 'overlay.svg', v: SVG_OVERLAY_WIRE_VERSION, id: o.id, svg: o.svg }),
      reliable: true,
    }));
  },
};

/** Re-export so the registry/tests can assert the empty set shape. */
export { emptySvgOverlays };
