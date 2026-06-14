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
// Doc-viewer local takeover + resync state machine (scene changes absolute;
// doc-source changes deferrable during takeover). Web + mobile share it.
export type {
  DocTakeoverStatus,
  DocTakeoverState,
  PendingDocTarget,
} from './streaming/docTakeover';
export {
  initialDocTakeover,
  isTakenOver,
  takeOverDoc,
  onStreamerDocUpdate,
  onStreamerSceneChange,
  resyncDoc,
} from './streaming/docTakeover';
// PUBLIC streamer identity for live-room + feed tiles (name/@handle/avatar, no
// UUID) + the mapping off the streaming rooms payload.
export type { PublicStreamerIdentity, RoomStreamerFields } from './streaming/identity';
export {
  streamerIdentityFromRoom,
  streamerDisplayLabel,
  hasPublicIdentity,
} from './streaming/identity';
// UNIFIED room-join handshake: canonical viewer Room/connect options (the
// adaptiveStream-off decoder-churn fix as the single source of truth), the
// connect/reuse/defer-teardown reconciler (focus-blip vs real navigation), the
// viewer-identity invariants (own-stream-as-viewer never collides at the SFU),
// and the muted-on-open resolution from a cached preference. Web + mobile share it.
export type {
  ViewerRoomOptions,
  ViewerConnectOptions,
  JoinTarget,
  JoinCurrent,
  JoinAction,
  SoundPreference,
} from './streaming/join';
export {
  viewerRoomOptions,
  viewerConnectOptions,
  isViewerIdentity,
  isSelfView,
  reconcileJoin,
  TEARDOWN_GRACE_MS,
  CONNECT_DEBOUNCE_MS,
  resolveInitialMuted,
  initialSoundOn,
  soundPreferenceFor,
  SOUND_PREF_CACHE_KEY,
} from './streaming/join';
// Shared CDN-snippet PREVIEW state machine (single stable url, refresh cadence,
// exponential back-off, one-load-in-flight). Web + mobile share this brain.
export type { PreviewConfig, PreviewAction, PreviewSnapshot } from './streaming/preview';
export { PreviewMachine, newPreviewMachine } from './streaming/preview';
export * from './overlays';
// Layout: the canonical resizable/reorderable scene model (LayoutItem, Scene,
// clampRect/moveItem/resizeItem/reorderZ/fitToBox). RN-portable; web + mobile share it.
export * from './layout';
