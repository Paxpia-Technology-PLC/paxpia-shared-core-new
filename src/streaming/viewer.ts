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
  };
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
  // Stream-end sentinel: the streamer broadcasts {doc:null, scene:null} on endLive.
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
    };
  }

  // Fold the doc slot. A doc instance lands in the doc slot; null clears it.
  const slots: LiveSlots = msg.doc
    ? setSlot(state.slots, msg.doc)
    : { ...state.slots, activeDoc: null };

  const scene = msg.scene ?? state.scene;
  const docPresenter = msg.docPresenter !== undefined ? msg.docPresenter : state.docPresenter;
  // Manifest only meaningfully arrives populated; a snapshot without one keeps the
  // prior manifest (so a mid-stream doc-page broadcast doesn't drop the manifest).
  const manifest = msg.manifest !== undefined && msg.manifest !== null ? msg.manifest : state.manifest;

  if (state.phase === 'connecting') {
    if (manifestHasMaterials(manifest)) {
      return {
        ...state,
        phase: 'preloading',
        slots,
        scene,
        docPresenter,
        manifest,
        totalBytes: manifest!.totalSizeBytes,
        loadedBytes: 0,
      };
    }
    return { ...state, phase: 'live', slots, scene, docPresenter, manifest };
  }

  return { ...state, slots, scene, docPresenter, manifest };
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
 *  The viewer's overlay layer is now a PURE function of the latest applied snapshot:
 *  we do NOT re-inject anything from the legacy two-slot state (slots.activeOverlay /
 *  slots.activeDoc). The producer is the single source of truth — its RenderedScene
 *  ALREADY carries the active participation overlay in the matching slot (see
 *  buildRenderedScene fills on the producer). So an overlay (poll or doc) that the
 *  new scene doesn't include simply vanishes on switch, guaranteed, with zero
 *  remnant — no message-timing/loss can leave a stale fold behind. Pure. */
export function applySceneSync(state: ViewerState, next: RenderedScene): ViewerState {
  const replaced = applyFullScene(state.rendered, next);
  if (replaced === state.rendered) return state; // stale snapshot → no change
  return { ...state, rendered: replaced };
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
