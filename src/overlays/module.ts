// OVERLAY MODULE — the COMPILER-ENFORCED per-kind lifecycle contract (Contract v2.4).
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The defect class behind the v2 bugs is the same: a per-kind responsibility (a
// presence channel, a snapshot, a resync snap, a persist key, a transform wire) was
// OPTIONAL, scattered, or component-owned — so a kind could silently omit it (the
// §0.4 forked-presence bug; the Bug-2 "whiteboard resync snaps to nothing"). The fix
// is a TYPED registry of `OverlayModule`s where EVERY kind MUST supply EVERY callback
// (no `?` member), illegal lifecycle states are unrepresentable, and the exhaustive
// `Record<OverlayKind, …>` (registry.ts) makes forgetting a kind a COMPILE error.
//
// ── What lives here ──────────────────────────────────────────────────────────
// Pure types + the per-kind type maps ONLY — no React, no platform, no reducer
// bodies. The concrete per-kind modules (kinds/*.ts) wrap the EXISTING pure reducers
// (`applyWb`, vote folds, svg set, the doc view fold) so behaviour is identical; the
// registry binds them into the exhaustive map. The render-brain / director / viewer
// drive overlays through `overlayModule(inst.kind)` — never an ad-hoc
// `if (kind === 'whiteboard')`.
//
// ── Invariants v2.1–v2.3 this encodes ────────────────────────────────────────
//   P4 (key scheme is the contract): `persistKey` is a BRANDED string derived ONLY
//      from stable ids — a raw literal can't be passed where a key is required, so
//      "addressed a board by an ad-hoc string" can't compile.
//   v2.2 (resync snaps to current, never replays): `onResync → ResyncSnap<K> | null`
//      is a MANDATORY member; a transform kind that "snaps to nothing" cannot satisfy
//      the interface (`ResyncSnap<'doc'|'whiteboard'>` is `{transform}`, not `null`).
//   v2.3 (zoom/pan are first-class synced state): the `OverlayTransform` the snap
//      carries IS the persisted/synced/resync-snappable transform.

import type { OverlayKind, OverlayInstance } from './types';
import type {
  PollPayload,
  QuizPayload,
  VoteButtonPayload,
  DocPayload,
  WhiteboardPayload,
} from './types';
import type { WbBoardState, WbMsg } from './whiteboard';
import type { SvgOverlayState, SvgOverlayMsg } from './svg';
import type { OverlayResultsMsg } from './wire';
import type { LiveSyncMsg, DocPresenterState } from '../streaming/live';
import type { ViewerState } from '../streaming/viewer';
import type { WireOutbound } from '../streaming/transport';

// ── The synced transform (v2.3 — zoom/pan are first-class state) ───────────────

/** The transform a transform-bearing kind syncs / persists / resyncs to. Doc +
 *  whiteboard carry it; participation/svg/gift have no view to snap and so map their
 *  `ResyncSnap` to `never` via the per-kind discriminant below.
 *
 *  Mirrors the wire `DocPresenterState` `{page, zoom, panX, panY}` (the doc presenter
 *  the live.sync carries) so the same `{zoom,panX,panY,page}` value drives sync,
 *  persistence, resync, AND lossless re-rasterization (Bug-5 note). */
export interface OverlayTransform {
  zoom: number;
  panX: number;
  panY: number;
  page?: number;
}

// ── Persisted view state for a transform-bearing kind (P1/P3 — present-not-destroy) ─

/** The DOC's persisted VIEW state — the page + the presenter transform — keyed by
 *  `persistKey` (per scene-item / per doc) so it SURVIVES a scene/doc/page transition
 *  (Invariant P1). This is the model-level owner that replaces the single global
 *  `state.docPresenter` slot the scene switch nulled (Bug 1.1). A doc switch presents
 *  a different key; the prior doc's `{page,transform}` stays addressed by its own key
 *  so re-serving it resumes where it was. */
export interface DocViewState {
  page: number;
  transform: OverlayTransform;
}

/** A fresh doc view (page 0, fit transform). */
export function emptyDocView(): DocViewState {
  return { page: 0, transform: { zoom: 1, panX: 0, panY: 0, page: 0 } };
}

// ── Participation aggregate (the converged vote state a module folds) ──────────

/** The bot-authoritative aggregate for ONE participation overlay round, keyed
 *  `(overlayId, gen)` (content-stable id `srv_<kind>:<title>` so votes persist across
 *  a swap). `tallies` is choiceId → count; `gen` is the monotonic round clock the
 *  module's `applyRemote`/`merge` order by (never-regress-gen). */
export interface VoteAggregate {
  overlayId: string;
  gen: number;
  tallies: Record<string, number>;
  total: number;
}

/** A fresh, empty vote aggregate for an overlay id at gen 0. */
export function emptyVoteAggregate(overlayId: string): VoteAggregate {
  return { overlayId, gen: 0, tallies: {}, total: 0 };
}

// ── Gift feed (planned; append-only, no merge) ─────────────────────────────────

/** One gift toast in the append-only feed. */
export interface GiftToast {
  id: string;
  from: string;
  giftId: string;
  atUnix: number;
}

/** A gift delta — one toast to append (greenfield, follows the same contract). */
export interface GiftDeltaMsg {
  t: 'overlay.gift';
  v: number;
  toast: GiftToast;
}

/** The converged gift feed — an append-only ordered list (no merge). */
export interface GiftFeedState {
  /** Highest seen sequence — the monotonic clock (a gift's atUnix / arrival order). */
  seq: number;
  toasts: GiftToast[];
}

/** A fresh, empty gift feed. */
export function emptyGiftFeed(): GiftFeedState {
  return { seq: 0, toasts: [] };
}

// ── Per-kind type maps (adding a kind WITHOUT extending these → compile error) ─
// Each map keys EVERY OverlayKind, so the registry's `Record<OverlayKind, OverlayModule<K>>`
// is only satisfiable when a kind has a payload, a converged state, a remote delta,
// and a local mutation. Forgetting to extend a map surfaces as an unsatisfiable
// `OverlayModule<K>` at the registry (the single enforcement point).

/** kind → its authored body payload (the `OverlayInstance.payload`). */
export interface OverlayPayloadByKind {
  svg: never;
  poll: PollPayload;
  'vote-button': VoteButtonPayload;
  quiz: QuizPayload;
  doc: DocPayload;
  gift: never;
  whiteboard: WhiteboardPayload;
}

/** kind → its CONVERGED state (the authoritative shape the module folds into). */
export interface OverlayStateByKind {
  svg: SvgOverlayState;
  poll: VoteAggregate;
  'vote-button': VoteAggregate;
  quiz: VoteAggregate;
  doc: DocViewState;
  gift: GiftFeedState;
  whiteboard: WbBoardState;
}

/** kind → the decoded REMOTE delta it folds (the wire message off `decodeOverlayChannelMsg`). */
export interface OverlayDeltaByKind {
  svg: SvgOverlayMsg;
  poll: OverlayResultsMsg;
  'vote-button': OverlayResultsMsg;
  quiz: OverlayResultsMsg;
  doc: LiveSyncMsg;
  gift: GiftDeltaMsg;
  whiteboard: WbMsg;
}

/** kind → a LOCAL author mutation (a drawn stroke, a page flip, a vote, a served
 *  doc). The HOSTING side's `applyLocal` consumes this; the per-kind union keeps the
 *  produce-side verbs exhaustive. */
export interface LocalMutationByKind {
  svg: SvgLocalMutation;
  poll: VoteLocalMutation;
  'vote-button': VoteLocalMutation;
  quiz: VoteLocalMutation;
  doc: DocLocalMutation;
  gift: GiftLocalMutation;
  whiteboard: WbLocalMutation;
}

/** A drawn / erased / wiped stroke, or a full snapshot to (re)broadcast. */
export type WbLocalMutation = { op: 'stroke' | 'erase' | 'wipe' | 'snapshot'; msg: WbMsg };
/** A page flip / presenter (transform) update on the doc. */
export type DocLocalMutation =
  | { op: 'page'; page: number }
  | { op: 'presenter'; presenter: DocPresenterState };
/** A committed vote for a participation overlay round. */
export type VoteLocalMutation = { op: 'vote'; choice: string };
/** Set/replace or delete a positioned svg decoration. */
export type SvgLocalMutation = { op: 'set' | 'delete'; msg: SvgOverlayMsg; nowMs: number };
/** Append one gift toast to the feed. */
export type GiftLocalMutation = { op: 'gift'; toast: GiftToast };

// ── PersistKey (P4 — branded so a raw string can't be a key) ───────────────────

/** A persist key — a BRANDED string so a raw string can't be passed where a key is
 *  required (the key MUST come from `module.persistKey(...)`, never an ad-hoc literal
 *  like `"wb_1"`). This is what makes "lose state on unmount" structurally
 *  impossible: state is addressed by a key derived from stable ids, never a mount
 *  nonce. */
export type PersistKey = string & { readonly __brand: 'OverlayPersistKey' };

/** Mint a `PersistKey` from a deterministic string. The ONLY way to produce one — a
 *  module's `persistKey(...)` is the single legitimate caller, so a key always derives
 *  from stable ids. NOT exported at the package barrel for general use; modules import
 *  it directly. */
export function brandPersistKey(raw: string): PersistKey {
  return raw as PersistKey;
}

/** Context a module's `persistKey` reads stable ids from. Carries the scene-item id a
 *  placed overlay occupies (so a doc/whiteboard keys per-(scene-item)) and the
 *  doc page (so the whiteboard-on-doc annotation case can key `wbann:<docId>:<page>`).
 *  Everything optional — a participation overlay keys off the instance id+gen alone. */
export interface PersistCtx {
  /** The scene layout-item id the overlay occupies (placement-stable). */
  sceneItemId?: string;
  /** The doc's current page (for the doc-annotation per-page key). */
  page?: number;
}

// ── Capture (a content-only artifact, e.g. a whiteboard screenshot) ────────────

/** A content-capture request — a kind that supports a screenshot returns this from
 *  `capture`; a kind with none returns `null` (but the MEMBER is mandatory — you must
 *  DECIDE). The platform leaf executes it (web `<a download>` / mobile CameraRoll);
 *  core only models the intent. */
export interface CaptureRequest {
  /** Which board/doc to capture (the persisted owner key). */
  key: PersistKey;
  /** A suggested filename for the saved artifact. */
  filename: string;
}

/** The snap a Resync applies — a transform for transform kinds, `never` for others.
 *  The per-kind discriminant makes an illegal snap UNREPRESENTABLE: a participation/
 *  svg/gift module physically cannot return a `{transform}` snap, and a doc/whiteboard
 *  module cannot return `null` where the interface requires `ResyncSnap<K> | null`
 *  but its `K` resolves the snap to a concrete `{transform}` (Bug-2 made a compile
 *  concern). */
export type ResyncSnap<K extends OverlayKind> = K extends 'doc' | 'whiteboard'
  ? { transform: OverlayTransform }
  : never;

// ── PLANE AWARENESS (Stream G3 — who OWNS a local action + does it propagate) ──
//
// THE DEFECT G3 PINS DOWN: a viewer's vote moved the *local* optimistic bar but its
// `overlay.response` never reached the producer (the scene-rebuild nulled the viewer's
// `activeOverlay`, so `onVote` early-returned and published nothing), so the dashboard
// + other viewers never saw it — a "UI-only optimistic set that never propagates."
//
// The cure is to make EVERY kind DECLARE which side OWNS its local action, whether a
// VIEWER may originate that action, and whether a viewer-originated action must
// PROPAGATE off-device (to the producer/aggregator + back to all viewers) — as a
// COMPILER-ENFORCED member of the module contract, exactly like `onResync`. A kind that
// forgets to decide does not type-check at the registry.
//
//   • 'streamer' — only the producer originates this kind's authoritative edits (svg
//      decorations, doc page/presenter, whiteboard strokes, scene placement). A viewer's
//      LOCAL interaction with it (pan/zoom takeover) is a *view-plane* divergence that
//      stays local until resync — it is NOT a state edit that propagates.
//   • 'viewer'   — a VIEWER originates the action and it MUST propagate: the vote
//      (`overlay.response` → aggregator → `overlay.results` to everyone), the gift
//      (`overlay.gift` toast broadcast). `viewerOriginates` is true and
//      `viewerActionPropagates` is true: a viewer action that does NOT leave the device
//      is the bug. The producer's authoritative echo (`overlay.results`) is what COMMITS
//      it everywhere — never a device-local set.
export type OverlayPlane = 'streamer' | 'viewer';

/** kind → which plane OWNS the authoritative local action for that kind. Participation
 *  + gift are VIEWER-plane (a viewer originates + it propagates); everything else is
 *  STREAMER-plane (the producer authors; a viewer's local pan/zoom is view-only). */
export interface OverlayActionPlaneByKind {
  svg: 'streamer';
  poll: 'viewer';
  'vote-button': 'viewer';
  quiz: 'viewer';
  doc: 'streamer';
  gift: 'viewer';
  whiteboard: 'streamer';
}

/** The plane contract a module declares (Stream G3). Makes "is this a streamer-plane or
 *  viewer-plane action, and must a viewer's action propagate off-device?" a structural,
 *  registry-enforced fact — so a kind can't silently ship a viewer action that only
 *  updates the local UI (the G3 vote-desync defect class). */
export interface OverlayActionPlane<K extends OverlayKind> {
  /** Which side OWNS this kind's authoritative local action. */
  readonly plane: OverlayActionPlaneByKind[K];
  /** May a VIEWER originate this kind's action? True only for viewer-plane kinds. */
  readonly viewerOriginates: boolean;
  /** When a viewer originates the action, MUST it propagate off-device (producer/
   *  aggregator → broadcast back to all viewers + the producer's own dashboard)? True
   *  for viewer-plane kinds — a viewer action that stays device-local is the G3 bug. A
   *  streamer-plane kind's viewer interaction (pan/zoom takeover) is view-only, so this
   *  is false (it converges back on RESYNC, not by propagation). */
  readonly viewerActionPropagates: boolean;
}

/** THE per-kind contract. EVERY member is REQUIRED (no `?`), so a kind that forgets
 *  one does not type-check at the registry. Two faces: HOSTING (author/produce side —
 *  studio + mobile creator) + SYNCING (consume/converge side — every viewer). */
export interface OverlayModule<K extends OverlayKind> {
  readonly kind: K;

  /** PLANE AWARENESS (Stream G3): which side OWNS this kind's local action + whether a
   *  viewer action must propagate off-device. A MANDATORY member (no `?`) so every kind
   *  DECIDES — the registry's exhaustive map makes "forgot to declare a kind's plane" a
   *  compile error, exactly like a missing `onResync`. The render-brain reads this to
   *  ASSERT a viewer-plane action is actually published, never a local-only set. */
  readonly actionPlane: OverlayActionPlane<K>;

  // ── identity + persistence ───────────────────────────────────────────────────
  /** The stable owner key for this instance's persisted state. Derived ONLY from
   *  stable ids (boardId / docId+page / overlayId+gen) — NEVER a component/mount
   *  nonce. This is what makes "lose state on unmount" structurally impossible (P4). */
  persistKey(inst: OverlayInstance<OverlayPayloadByKind[K]>, ctx: PersistCtx): PersistKey;

  // ── HOSTING (author / produce side) ──────────────────────────────────────────
  /** Serialize the FULL current state for a late-joiner snapshot / a persist write. */
  snapshot(state: OverlayStateByKind[K]): OverlayDeltaByKind[K];
  /** Apply a LOCAL author mutation (a drawn stroke, a page flip, a vote) to local
   *  state, returning the next state + the wire to broadcast. Pure. */
  applyLocal(
    state: OverlayStateByKind[K],
    mutation: LocalMutationByKind[K],
  ): { state: OverlayStateByKind[K]; out: WireOutbound[] };
  /** Capture a content-only artifact (screenshot) where meaningful. Kinds with no
   *  capture return `null` — but the MEMBER is still mandatory (you must DECIDE). */
  capture(state: OverlayStateByKind[K], key: PersistKey): CaptureRequest | null;

  // ── SYNCING (consume / converge side) ────────────────────────────────────────
  /** Fold a decoded REMOTE delta into converged state (gen/nonce-keyed, idempotent,
   *  additive — never a flag-day). The merge + gen rules live HERE, once. */
  applyRemote(state: OverlayStateByKind[K], delta: OverlayDeltaByKind[K]): OverlayStateByKind[K];
  /** Additive-merge two states (snapshot ∪ live deltas) — MUST be commutative +
   *  idempotent so snapshot-then-deltas and deltas-then-snapshot converge (§4). */
  merge(a: OverlayStateByKind[K], b: OverlayStateByKind[K]): OverlayStateByKind[K];
  /** The current generation/clock (board gen / nonce / vote gen) — the monotonic key
   *  `applyRemote`/`merge` order by. */
  gen(state: OverlayStateByKind[K]): number;
  /** RECONNECT / RESYNC: given the converged store, produce the value the viewer must
   *  SNAP to — the current transform for a transform kind, or `null` for a kind with
   *  no view to snap (participation/svg/gift). This is what makes Bug 2 a compile-time
   *  concern: a transform kind that omits the snap cannot satisfy the interface. */
  onResync(store: ViewerState, key: PersistKey): ResyncSnap<K> | null;
  /** RECONNECT replay: the wire messages to re-broadcast for this kind so a (re)joining
   *  participant reconstructs it (the whiteboard snapshot folds into the ONE
   *  `ReconnectPlan.replay`, §4 — never an ad-hoc per-join effect). */
  onReconnect(state: OverlayStateByKind[K], key: PersistKey): WireOutbound[];
}
