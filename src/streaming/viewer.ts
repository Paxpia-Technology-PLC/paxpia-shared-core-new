// Live VIEWER state machine — the platform-agnostic core every viewer (web AND
// the future React Native app) drives to go from "tapped a stream" to "fully
// synced live view". Web/mobile are THIN render layers over this: they own only
// the transport binding (LiveKit data channel), the byte-fetch, and the per-kind
// rendering primitives. ALL the decision logic — which phase the viewer is in,
// how a live-sync snapshot folds into the slots, when the preload gate lifts,
// what a guest still needs — lives HERE so the two platforms can never diverge.
//
// ── The phases (a small, explicit state machine) ─────────────────────────────
//   'connecting' — joined the room, waiting for the first snapshot (manifest +
//                  current slots). We don't yet know if there are materials.
//   'preloading' — the room HAS materials; we're downloading them all behind a
//                  gated progress screen (progress fed from the byte-fetch layer).
//   'live'       — preload done (or no materials); the scene + slots render.
//   'ended'      — the streamer ended the stream (both slots wiped).
// The transitions are pure functions of (current state, an event). The render
// layer calls the matching reducer and re-renders from the returned state.
//
// ── Why a guest gets the FULL state ──────────────────────────────────────────
// A link-visitor has NO auth token, so it CANNOT call the auth'd /materials/grant.
// The STREAMER therefore grants the presigned URLs and rides them (with the
// manifest) on the live-sync snapshot. The viewer machine treats the manifest as
// the SOLE source of what to preload — it never calls grant itself — so the guest
// path and the logged-in path are byte-for-byte the same code here.

import type { OverlayInstance } from '../overlays/types';
import { applyWb, emptyBoard, type WbBoardState, type WbMsg } from '../overlays/whiteboard';
import {
  setSlot,
  clearAllSlots,
  emptySlots,
  type DocPresenterState,
  type LiveManifest,
  type LiveScene,
  type LiveSlots,
  type LiveSyncMsg,
  type ManifestEntry,
} from './live';
import {
  applyFullScene,
  emptyRenderedScene,
  type RenderedScene,
  type SceneOverlay,
} from './scene';
import {
  emptyViewStore,
  putView,
  putViewTransform,
  readView,
  docViewPersistKey,
  wbViewPersistKey,
  type ViewStore,
} from './persist';
import type { PersistKey, DocViewState, GiftDeltaMsg, GiftFeedState } from '../overlays/module';
import { emptyGiftFeed } from '../overlays/module';
import { overlayModule } from '../overlays/registry';
import type { DocAnnotationState } from '../overlays/annotation';

/** The viewer's lifecycle phase (see module header). */
export type ViewerPhase = 'connecting' | 'preloading' | 'live' | 'ended';

/** The complete, serializable live-viewer state. The render layer holds exactly
 *  this and derives its UI from it — no extra hidden flags. */
export interface ViewerState {
  phase: ViewerPhase;
  /** The two independent live slots (doc + participation overlay). The overlay
   *  slot is fed from the server bot's overlay.changed; the doc slot from the
   *  streamer's live-sync. */
  slots: LiveSlots;
  /** The streamer's selected scene (rides live-sync), or null → local default. */
  scene: LiveScene | null;
  /** The COMPLETE rendered overlay layer for the CURRENT scene — the FULL-REPLACE
   *  unit. Every scene switch ships the whole set (per-scene rects + payloads) and
   *  this is replaced wholesale (monotonic by nonce), so the previous scene's
   *  overlays can never remain and nothing is ever snapped to a centered default.
   *  The bot's participation overlay is folded INTO this set at its matching slot. */
  rendered: RenderedScene;
  /** The presenter's pan/zoom on the active doc (so the initial view mirrors the
   *  streamer). null → fit/no-pan. Viewers may locally diverge after. */
  docPresenter: DocPresenterState | null;
  /** The room's material manifest (ids + sizes + presigned URLs), or null when the
   *  stream has no materials. Drives the preload gate + guest doc rendering. */
  manifest: LiveManifest | null;
  /** Preload progress: bytes fetched so far / total (for the gate's progress bar).
   *  loadedBytes ≥ totalBytes (or totalBytes 0) ⇒ ready to admit. */
  loadedBytes: number;
  totalBytes: number;
  /** Live WHITEBOARD boards, keyed by boardId. The converged stroke set every front
   *  paints from — `overlay.wb.*` deltas fold in here via `applyWb` (gen-aware), the
   *  SAME render-brain seam doc/scene/overlay fold through, so a whiteboard overlay's
   *  `strokes` are DERIVED from this (never a private data plane). A board appears the
   *  first time a stroke/snapshot/wipe for its id arrives; a `whiteboard` OverlayInstance
   *  reads its strokes by `payload.boardId`. */
  boards: Record<string, WbBoardState>;
  /** PERSISTED overlay VIEW state (page + zoom/pan), keyed by `persistKey` (per
   *  scene-item / per doc). The stable OWNER (Contract v2.1 P2) that REPLACES the
   *  single global `docPresenter` slot a scene switch nulled (Bug 1a): a doc/board
   *  that re-appears in a later scene re-presents its EXACT prior page+transform from
   *  here. A SCENE/DOC/PAGE transition NEVER clears this — it only changes which key
   *  is presented (P3). Strokes are NOT here (they live in `boards`); this owns the
   *  transform-bearing VIEW the global presenter slot used to drop. */
  views: ViewStore;
  /** WHITEBOARD-ON-DOC ANNOTATION presence (Message D item 2): the streamer's active
   *  annotation descriptor for the live doc — `on` + the active `wbann:…` `boardId` +
   *  `mode` — folded from `live.sync.docAnn`. Null ⇒ no active annotation. The viewer
   *  renders an annotation layer over the doc ONLY when `docAnn.on`, painting
   *  `boardStrokes(docAnn.boardId)`. A toggle-OFF arrives as `{on:false}` ⇒ the layer
   *  HIDES while the strokes PERSIST in `boards` (P3 present-not-destroy). */
  docAnn: DocAnnotationState | null;
  /** The converged GIFT feed (Contract v2.4 / kinds/gift): an append-only, id-deduped,
   *  capped ordered log of gift toasts. `overlay.gift` deltas fold in here via
   *  `applyGiftMsg` (through the gift module, registry-driven). A fire-and-forget feed —
   *  unlike doc/board state nothing snaps it on resync (the module's `onResync` is null),
   *  it simply grows as toasts arrive and the UI auto-expires the oldest. */
  gifts: GiftFeedState;
}

/** The initial state — entered the moment we begin connecting to the room. */
export function initialViewerState(): ViewerState {
  return {
    phase: 'connecting',
    slots: emptySlots(),
    scene: null,
    rendered: emptyRenderedScene(),
    docPresenter: null,
    manifest: null,
    loadedBytes: 0,
    totalBytes: 0,
    boards: {},
    views: emptyViewStore(),
    docAnn: null,
    gifts: emptyGiftFeed(),
  };
}

/** Read a persisted overlay VIEW by its `persistKey` (the doc/board page+transform
 *  that survives scene/doc/page transitions). Empty fit-view when nothing stored yet.
 *  Pure — the render-brain reads the presented view from here, never the global slot. */
export function viewFor(state: ViewerState, key: PersistKey): DocViewState {
  return readView(state.views, key);
}

/** PRESENT-not-DESTROY fold: persist a key's full VIEW into the converged store. This
 *  is the model-level owner write — a scene/doc/page transition re-keys here, it never
 *  clears (Invariant P3). Returns the SAME state ref on a no-op. Pure. */
export function applyViewPersist(state: ViewerState, key: PersistKey, view: DocViewState): ViewerState {
  const nextViews = putView(state.views, key, view);
  if (nextViews === state.views) return state;
  return { ...state, views: nextViews };
}

/** Fold a decoded whiteboard delta (`overlay.wb.stroke|erase|wipe|snapshot`) into the
 *  per-board state via the pure `applyWb` reducer (gen-aware). Returns the SAME state
 *  ref when the board didn't change (a stale/no-op delta) so the render-brain coalesces
 *  to zero re-renders. The board is created lazily on its first message. Pure. */
export function applyWhiteboardMsg(state: ViewerState, msg: WbMsg): ViewerState {
  const prevBoard = state.boards[msg.boardId] ?? emptyBoard();
  const nextBoard = applyWb(prevBoard, msg);
  if (nextBoard === prevBoard && state.boards[msg.boardId]) return state; // no-op fold
  return { ...state, boards: { ...state.boards, [msg.boardId]: nextBoard } };
}

/** Read a board's converged stroke set by id (the `strokes` a `whiteboard` overlay
 *  renders). Returns an empty board when nothing has arrived yet, so a viewer that
 *  mounts before the first snapshot paints an empty board (then converges). Pure. */
export function boardStrokes(state: ViewerState, boardId: string): WbBoardState {
  return state.boards[boardId] ?? emptyBoard();
}

/** Fold one decoded gift delta (`overlay.gift`) into the converged append-only feed
 *  THROUGH the typed gift module (`overlayModule('gift').applyRemote`) — the registry-
 *  driven dispatch the contract requires (mirrors `foldWhiteboardViaModule`). The module
 *  appends + dedupes by id + caps the log; an empty-sentinel / duplicate toast returns the
 *  SAME feed ref, so a stale/duplicate packet coalesces to zero re-renders. Pure. */
export function applyGiftMsg(state: ViewerState, msg: GiftDeltaMsg): ViewerState {
  const gift = overlayModule('gift');
  const nextGifts = gift.applyRemote(state.gifts, msg);
  if (nextGifts === state.gifts) return state; // no-op fold (dup / empty sentinel)
  return { ...state, gifts: nextGifts };
}

/** Read the converged gift feed (the toasts a `GiftOverlayLayer` renders). The most
 *  recent toast is last; the UI caps/expires its visible window. Pure. */
export function giftFeed(state: ViewerState): GiftFeedState {
  return state.gifts;
}

/** Fold a WHITEBOARD presenter update (the streamer's pan/zoom on a board, off the
 *  dedicated `live.sync.wbPresenter` wire) into the board's keyed VIEW store, keyed by
 *  `wbViewPersistKey(boardId)`. This is the board's analogue of `persistDocView` — it
 *  owns the board's TRANSFORM (view), keeping it on the SAME stable converged owner the
 *  doc presenter promotes into, so a wb resync snaps to it (`whiteboardModule.onResync`)
 *  and it SURVIVES a scene/doc transition (Invariant P1). A null presenter resets the
 *  board view to fit. Returns the SAME state ref on a no-op (the store coalesces). Pure. */
export function applyWbPresenter(
  state: ViewerState,
  boardId: string,
  presenter: DocPresenterState | null,
): ViewerState {
  const key = wbViewPersistKey(boardId);
  const transform = presenter
    ? { zoom: presenter.zoom, panX: presenter.panX, panY: presenter.panY, page: presenter.page }
    : { zoom: 1, panX: 0, panY: 0, page: 0 };
  const nextViews = putViewTransform(state.views, key, transform);
  if (nextViews === state.views) return state;
  return { ...state, views: nextViews };
}

/** True iff a manifest describes materials that must be preloaded before admit.
 *  Empty/absent manifest ⇒ nothing to gate on. */
export function manifestHasMaterials(m: LiveManifest | null | undefined): boolean {
  return !!m && m.entries.length > 0;
}

/** Apply a decoded live-sync snapshot (from the streamer) to the viewer state.
 *  This is the SINGLE fold point for the doc slot + scene + doc presenter +
 *  manifest. It also drives the connecting→preloading/live transition the FIRST
 *  time we learn whether the room has materials:
 *    • connecting + manifest-with-materials ⇒ preloading (gate goes up).
 *    • connecting + no materials            ⇒ live (admit immediately).
 *    • already past connecting              ⇒ slots/scene/presenter update in place
 *      (a mid-stream doc push or scene swap; we never re-gate).
 *  A null doc + null scene + null manifest is the stream-end wipe → 'ended'. */
export function applyLiveSync(state: ViewerState, msg: LiveSyncMsg): ViewerState {
  // A live.sync carrying a WHITEBOARD presenter update (`wbPresenter`) is a board-view
  // broadcast, NOT a doc/scene snapshot — fold it into the board's keyed VIEW store and
  // return. This is the dedicated wb-presenter wire (Contract v2.3 / §8.1.4): it CANNOT be
  // confused with the end-wipe (a board-presenter live.sync rides {doc:null,scene:null}
  // but is explicitly not an end — the guard below also excludes it). The board's strokes
  // are content (folded via `overlay.wb.*`); this owns only the board's transform VIEW.
  if (msg.wbPresenter !== undefined && msg.wbPresenter !== null) {
    return applyWbPresenter(state, msg.wbPresenter.boardId, msg.wbPresenter.presenter);
  }

  // Stream-end sentinel: the streamer broadcasts {doc:null, scene:null} on endLive. A
  // live.sync carrying a `wbPresenter` is NEVER an end-wipe (it's a board-view update) —
  // handled+returned above, so by here `wbPresenter` is absent.
  const isEndWipe =
    msg.doc === null && (msg.scene === null || msg.scene === undefined) && !manifestHasMaterials(msg.manifest);
  if (isEndWipe && state.phase !== 'connecting') {
    return {
      ...state,
      phase: 'ended',
      slots: clearAllSlots(),
      scene: null,
      rendered: emptyRenderedScene(),
      docPresenter: null,
      docAnn: null,
    };
  }

  // Fold the doc slot. A doc instance lands in the doc slot; null clears it.
  const slots: LiveSlots = msg.doc
    ? setSlot(state.slots, msg.doc)
    : { ...state.slots, activeDoc: null };

  const scene = msg.scene ?? state.scene;
  const docPresenter = msg.docPresenter !== undefined ? msg.docPresenter : state.docPresenter;
  // ANNOTATION presence (Message D item 2): carry-forward when absent, replace when
  // present (incl. explicit null = no active annotation). A null `doc` (the doc slot
  // cleared mid-stream, NOT an end-wipe) also drops a stale annotation so a hidden doc
  // can't leave its annotation layer behind.
  const docAnn = msg.docAnn !== undefined ? msg.docAnn : msg.doc === null ? null : state.docAnn;
  // Manifest only meaningfully arrives populated; a snapshot without one keeps the
  // prior manifest (so a mid-stream doc-page broadcast doesn't drop the manifest).
  const manifest = msg.manifest !== undefined && msg.manifest !== null ? msg.manifest : state.manifest;

  // PRESENTER PROMOTION (Contract v2.1 / 1C): persist the streamer's doc page+transform
  // into the KEYED view store (keyed by the doc id) so it SURVIVES a scene/doc switch.
  // This is the model-level fix for Bug 1a — the view is owned by the converged store,
  // not the single global `docPresenter` slot a scene switch nulled. PRESENT-not-DESTROY:
  // a null doc never CLEARS a persisted entry, it just stops presenting it.
  const views = persistDocView(state.views, slots.activeDoc, docPresenter);

  if (state.phase === 'connecting') {
    if (manifestHasMaterials(manifest)) {
      return {
        ...state,
        phase: 'preloading',
        slots,
        scene,
        docPresenter,
        manifest,
        views,
        docAnn,
        totalBytes: manifest!.totalSizeBytes,
        loadedBytes: 0,
      };
    }
    return { ...state, phase: 'live', slots, scene, docPresenter, manifest, views, docAnn };
  }

  return { ...state, slots, scene, docPresenter, manifest, views, docAnn };
}

/** Persist the active doc's page+transform into the keyed view store (presenter
 *  promotion, 1C). Keyed by the doc INSTANCE id so the entry survives a scene/doc
 *  switch and re-presents on return. A null doc or null presenter leaves the store
 *  untouched (PRESENT-not-DESTROY — we never clear a prior doc's persisted view).
 *  Pure — returns the SAME store ref on a no-op. */
function persistDocView(
  views: ViewStore,
  doc: LiveSlots['activeDoc'],
  presenter: DocPresenterState | null,
): ViewStore {
  if (!doc || !presenter) return views;
  const key = docViewPersistKey(doc.id);
  const view: DocViewState = {
    page: presenter.page,
    transform: { zoom: presenter.zoom, panX: presenter.panX, panY: presenter.panY, page: presenter.page },
  };
  return putView(views, key, view);
}

/** Feed the server-bot's active participation overlay into the overlay slot. The
 *  doc slot is untouched (the two slots are independent). Pure.
 *
 *  ALSO folds the participation overlay into the FULL-REPLACE rendered layer: the
 *  scene-sync built every overlay slot with instance:null (the bot owns the live
 *  participation instance), so here we drop the bot's instance into the FIRST
 *  empty/participation overlay slot — keeping the rendered set the single source of
 *  truth the viewer paints, positioned at the per-scene authored rect. */
export function applyOverlayChanged(state: ViewerState, overlay: OverlayInstance | null): ViewerState {
  if (!overlay) {
    return {
      ...state,
      slots: { ...state.slots, activeOverlay: null },
      rendered: clearParticipationOverlay(state.rendered),
    };
  }
  // Defensive: only a participation kind ever belongs in the overlay slot; a doc
  // from the bot (shouldn't happen) is ignored so it can't clobber the doc slot.
  if (overlay.kind === 'doc') return state;
  return {
    ...state,
    slots: setSlot(state.slots, overlay),
    rendered: foldParticipationOverlay(state.rendered, overlay),
  };
}

/** Apply a COMPLETE-scene snapshot (the producer's full-replace scene-sync) to the
 *  rendered overlay layer. This is the heart of P0.3: the previous scene's overlays
 *  are dropped wholesale and ONLY the new scene's set (at its per-scene rects) is
 *  rendered — monotonic by nonce so a late/duplicate packet can't regress.
 *
 *  The viewer's overlay layer is a PURE function of the latest applied snapshot: we do
 *  NOT re-inject anything into the rendered layer from the legacy two-slot state. The
 *  producer is the single source of truth — its RenderedScene ALREADY carries the active
 *  participation overlay in the matching slot (see buildRenderedScene fills on the
 *  producer). So an overlay (poll or doc) the new scene doesn't include simply vanishes
 *  on switch, guaranteed, with zero remnant.
 *
 *  ── Stream G3: the scene-sync is ALSO the participation vote-target source ──────────
 *  On the WEB lane there is NO server bot, so a RESET (gen-bump) re-`activate`s the
 *  overlay but the only thing that carries the new-gen instance to viewers is THIS
 *  full-replace scene.sync (the producer embeds the live `activeOverlay` in the rendered
 *  set). The legacy code left `slots.activeOverlay` untouched here, so after a web reset a
 *  viewer kept voting at the OLD gen → the aggregator (now at the NEW gen) bucketed those
 *  votes into a dead round and the dashboard never moved (the G3 "votes only register on
 *  the viewer UI" desync). FIX: mirror the participation instance the scene.sync carries
 *  back into `slots.activeOverlay` (the vote-target the render-brain reads), keyed by the
 *  HIGHER gen — so a reset's new gen reaches the viewer's vote path even with no bot, and
 *  a scene-switch that DROPS the overlay slot clears the vote target too. Never regresses
 *  gen (an older snapshot can't roll the round back). Pure. */
export function applySceneSync(state: ViewerState, next: RenderedScene): ViewerState {
  const replaced = applyFullScene(state.rendered, next);
  if (replaced === state.rendered) return state; // stale snapshot → no change
  const nextActive = participationInstanceOf(replaced);
  const slots = reconcileSceneActiveOverlay(state.slots, nextActive);
  if (slots === state.slots) return { ...state, rendered: replaced };
  return { ...state, rendered: replaced, slots };
}

/** The participation overlay instance the rendered scene carries (the first filled
 *  overlay-type slot), or null when the scene has none. The bot/producer drops the live
 *  participation instance into an overlay slot; this recovers it so the viewer's vote
 *  target tracks what is actually painted. Pure. */
function participationInstanceOf(scene: RenderedScene): OverlayInstance | null {
  for (const o of scene.overlays) {
    if (o.type === 'overlay' && o.instance) return o.instance;
  }
  return null;
}

/** Reconcile the legacy `activeOverlay` slot against the participation instance a
 *  scene.sync carries, NEVER regressing the round (Stream G3):
 *   • scene carries the SAME id at a HIGHER (or equal) gen → adopt it (a reset's new gen
 *     reaches the viewer's vote path even with no bot driving `overlay.changed`).
 *   • scene carries a DIFFERENT id → adopt it (a fresh poll served into the slot).
 *   • scene carries the same id at a STRICTLY OLDER gen → keep the current (a stale/late
 *     snapshot can't roll the round back, mirroring `applyOverlayChanged`'s never-regress).
 *   • scene carries NO participation overlay → clear the vote target (the slot emptied).
 *  Returns the SAME slots ref on a no-op so the fold coalesces to zero re-renders. Pure. */
function reconcileSceneActiveOverlay(
  slots: ViewerState['slots'],
  next: OverlayInstance | null,
): ViewerState['slots'] {
  const cur = slots.activeOverlay;
  if (!next) {
    return cur ? { ...slots, activeOverlay: null } : slots;
  }
  if (cur && cur.id === next.id && next.gen < cur.gen) return slots; // never regress gen
  if (cur && cur.id === next.id && cur.gen === next.gen && cur === next) return slots;
  return setSlot(slots, next);
}

/** Place a participation overlay instance into the rendered layer's FIRST overlay
 *  slot (draw order), replacing whatever instance it held. Returns `scene` unchanged
 *  when there's no overlay slot in the current scene — so a poll with nowhere
 *  authored to go is simply NOT shown (never centered). Pure. */
function foldParticipationOverlay(scene: RenderedScene, overlay: OverlayInstance): RenderedScene {
  const idx = scene.overlays.findIndex((o) => o.type === 'overlay');
  if (idx < 0) return scene; // no overlay slot in this scene → don't render it
  const overlays = scene.overlays.map((o, i): SceneOverlay => (i === idx ? { ...o, instance: overlay } : o));
  return { ...scene, overlays };
}

/** Empty every participation (overlay-type) slot in the rendered layer — used when
 *  the bot clears the active overlay (`next` with nothing staged). Doc slots are
 *  untouched. Pure. */
function clearParticipationOverlay(scene: RenderedScene): RenderedScene {
  if (!scene.overlays.some((o) => o.type === 'overlay' && o.instance)) return scene;
  const overlays = scene.overlays.map((o): SceneOverlay =>
    o.type === 'overlay' ? { ...o, instance: null } : o,
  );
  return { ...scene, overlays };
}

/** Advance the preload progress (called by the byte-fetch layer as it streams the
 *  materials). Pure — the render layer re-renders the bar from loaded/total. */
export function applyPreloadProgress(state: ViewerState, loadedBytes: number, totalBytes?: number): ViewerState {
  return {
    ...state,
    loadedBytes: Math.max(state.loadedBytes, loadedBytes),
    totalBytes: totalBytes ?? state.totalBytes,
  };
}

/** Lift the preload gate (preload finished OR the viewer skipped) → admit to the
 *  live view. Idempotent and safe from any phase except 'ended'. */
export function admitToLive(state: ViewerState): ViewerState {
  if (state.phase === 'ended') return state;
  return { ...state, phase: 'live', loadedBytes: Math.max(state.loadedBytes, state.totalBytes) };
}

/** Locally adjust the doc presenter view (a viewer pinch/pan AFTER the synced
 *  initial state). Kept here so the model owns the shape, but it does NOT rebroadcast
 *  — only the streamer's presenter state rides the wire. */
export function setLocalDocPresenter(state: ViewerState, presenter: DocPresenterState | null): ViewerState {
  return { ...state, docPresenter: presenter };
}

/** Preload progress as a 0..100 integer (the gate's bar). Snaps to 100 once admitted. */
export function preloadPct(state: ViewerState): number {
  if (state.phase === 'live') return 100;
  if (state.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((state.loadedBytes / state.totalBytes) * 100));
}

// ── Manifest helpers (assembly + lookup) ─────────────────────────────────────

/** Build a LiveManifest from a set of per-material grant entries. The STREAMER
 *  calls this after granting presigned URLs (it owns the auth'd grant call), then
 *  broadcasts it. Pure + platform-agnostic — both web and the RN producer assemble
 *  the manifest identically. */
export function buildManifest(entries: ManifestEntry[]): LiveManifest {
  const total = entries.reduce((a, e) => a + (e.sizeBytes || 0), 0);
  return { entries, totalSizeBytes: total, count: entries.length };
}

/** Look up a manifest entry (its presigned URL + mime) by material id. The doc
 *  render path uses this so a guest renders straight from the broadcast URL with
 *  no grant call. */
export function manifestEntry(m: LiveManifest | null, id: string): ManifestEntry | undefined {
  return m?.entries.find((e) => e.id === id);
}
