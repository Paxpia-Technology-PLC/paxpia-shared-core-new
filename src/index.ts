// @paxpia/shared-core — platform-agnostic domain library shared by Paxpia-web
// and Paxpia-mobile (and mirrored by the Go backend). Types + pure logic only;
// no platform UI (RN View vs web div), so it imports cleanly under both Vite and
// Metro. Rendering lives per-platform; the MODEL lives here, once.
export * from './accounts';
// Streaming: re-export the consumer-composition model. The legacy flat producer
// model (Scene/SceneInput/InputKind) is SUPERSEDED by `layout/` and is omitted
// here to keep `Scene` unambiguous — it stays reachable via `@paxpia/core/streaming`.
export type {
  StreamVisibility,
  StreamKind,
  Monetization,
  StreamMeta,
  SourceAspect,
  CompositionMode,
  ConsumerLayout,
  Box,
} from './streaming/types';
export { defaultComposition, aspectRatio, composeTvLayout } from './streaming/types';
// Two-slot live model + live-sync wire + scene-assignment model (no name clash
// with layout's Scene). Re-exported at the top level so web/mobile import from
// `@paxpia/core` directly.
export type {
  LiveSlot,
  LiveSlots,
  LiveSyncMsg,
  LiveSyncWireMsg,
  LiveScene,
  LiveSceneItem,
  SceneAssignment,
  ManifestEntry,
  LiveManifest,
  DocPresenterState,
} from './streaming/live';
export {
  LIVESYNC_WIRE_VERSION,
  slotForKind,
  emptySlots,
  setSlot,
  clearSlot,
  clearAllSlots,
  slotInstance,
  isLiveSyncMsg,
  encodeLiveSyncMsg,
  decodeLiveSyncMsg,
  assignScene,
  unassignScene,
  initialSceneId,
} from './streaming/live';
// Live VIEWER state machine + in-memory preload cache (the model mobile reuses).
export type { ViewerPhase, ViewerState } from './streaming/viewer';
export {
  initialViewerState,
  manifestHasMaterials,
  applyLiveSync,
  applyOverlayChanged,
  applyPreloadProgress,
  admitToLive,
  setLocalDocPresenter,
  preloadPct,
  buildManifest,
  manifestEntry,
} from './streaming/viewer';
export type { CachedDoc, PreloadCache } from './streaming/preload';
export {
  newPreloadCache,
  isWarm,
  getCachedDoc,
  putCachedDoc,
  materialsToPreload,
  isRenderableMime,
  isPdfEntry,
} from './streaming/preload';
export * from './overlays';
// Layout: the canonical resizable/reorderable scene model (LayoutItem, Scene,
// clampRect/moveItem/resizeItem/reorderZ/fitToBox). RN-portable; web + mobile share it.
export * from './layout';
