// GIFT overlay module (Contract v2.4) — greenfield, append-only toast feed. Planned in
// v1 §8.4 Step F; follows the SAME contract as any kind (registry-enforced) so it
// can't ship missing a callback. Not transform-bearing (no resync snap), no content
// capture, no merge beyond append (the feed is an ordered append-only log).
//
// The gift wire is a tiny additive envelope `overlay.gift` carrying one toast; the
// converged state is a sequence + an ordered toast list. NEVER a flag-day — it extends
// the consume ladder additively like every other kind.

import type { OverlayInstance } from '../types';
import {
  brandPersistKey,
  emptyGiftFeed,
  type GiftFeedState,
  type GiftDeltaMsg,
  type GiftToast,
} from '../module';
import type { OverlayModule, PersistKey, PersistCtx } from '../module';

/** Wire version for the gift envelope (independent so it can evolve additively). */
export const GIFT_WIRE_VERSION = 1;

/** Cap the in-memory toast feed so an append-only log can't grow unbounded. */
export const GIFT_FEED_CAP = 100;

/** Encode a gift delta to UTF-8 JSON bytes (TextEncoder feature-detected off
 *  globalThis — no lib.dom in this platform-free pkg). */
function encodeGiftMsg(msg: GiftDeltaMsg): Uint8Array {
  const withV = { ...msg, v: msg.v ?? GIFT_WIRE_VERSION };
  const json = JSON.stringify(withV);
  const g = globalThis as unknown as { TextEncoder?: new () => { encode(s: string): Uint8Array } };
  if (g.TextEncoder) return new g.TextEncoder().encode(json);
  const out = new Uint8Array(json.length);
  for (let i = 0; i < json.length; i++) out[i] = json.charCodeAt(i) & 0xff;
  return out;
}

/** Append one toast to the feed (dedup by id; cap the log). Pure — SAME ref on a
 *  duplicate so an idempotent re-send doesn't churn. */
function appendToast(state: GiftFeedState, toast: GiftToast): GiftFeedState {
  if (state.toasts.some((t) => t.id === toast.id)) return state; // idempotent dedup
  const toasts = [...state.toasts, toast].slice(-GIFT_FEED_CAP);
  return { seq: state.seq + 1, toasts };
}

/** The GIFT module. State = the append-only feed; delta = one `overlay.gift` toast;
 *  no transform → no resync snap; no capture. */
export const giftModule: OverlayModule<'gift'> = {
  kind: 'gift',

  /** PLANE: VIEWER-plane (Stream G3). A viewer SENDS a gift; the `overlay.gift` toast
   *  propagates to every viewer + the producer's feed (fire-and-forget, idempotent by
   *  id). Like the vote it must leave the device — the local append is feedback, the
   *  broadcast toast is what every front converges on. */
  actionPlane: {
    plane: 'viewer',
    viewerOriginates: true,
    viewerActionPropagates: true,
  },

  /** Per-feed key (`gift:<instanceId>`) — the feed is per gift overlay instance. */
  persistKey(inst: OverlayInstance, _ctx: PersistCtx): PersistKey {
    return brandPersistKey(`gift:${inst.id}`);
  },

  /** Snapshot the LATEST toast (the feed is append-only; a late joiner gets the most
   *  recent — the full backlog is not replayed for a fire-and-forget toast). */
  snapshot(state: GiftFeedState): GiftDeltaMsg {
    const last = state.toasts[state.toasts.length - 1];
    return {
      t: 'overlay.gift',
      v: GIFT_WIRE_VERSION,
      toast: last ?? { id: '', from: '', giftId: '', atUnix: 0 },
    };
  },

  /** Apply a LOCAL gift (append + broadcast the toast). Pure. */
  applyLocal(state, mutation) {
    const next = appendToast(state, mutation.toast);
    const msg: GiftDeltaMsg = { t: 'overlay.gift', v: GIFT_WIRE_VERSION, toast: mutation.toast };
    return { state: next, out: [{ bytes: encodeGiftMsg(msg), reliable: false }] };
  },

  /** No content-capture artifact. */
  capture() {
    return null;
  },

  /** Fold a REMOTE gift toast into the feed (append-only, idempotent by id). Pure. */
  applyRemote(state, delta: GiftDeltaMsg): GiftFeedState {
    if (!delta.toast.id) return state; // empty sentinel (no toast yet)
    return appendToast(state, delta.toast);
  },

  /** Additive merge — union toasts by id, preserving order (append-only). */
  merge(a, b): GiftFeedState {
    let out = a;
    for (const t of b.toasts) out = appendToast(out, t);
    return out;
  },

  /** The feed clock — the append sequence. */
  gen(state): number {
    return state.seq;
  },

  /** No view to snap (ResyncSnap<'gift'> is `never`). */
  onResync() {
    return null;
  },

  /** RECONNECT replay: a fire-and-forget toast feed re-broadcasts nothing on reconnect
   *  (toasts are transient; a late joiner doesn't get the backlog). Empty replay. */
  onReconnect(_state, _key) {
    return [];
  },
};

/** Re-export so the registry/tests can assert the empty feed shape. */
export { emptyGiftFeed };
