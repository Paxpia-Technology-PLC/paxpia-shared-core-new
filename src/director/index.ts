// @paxpia/core/director — the PRODUCER-DIRECTION brain (audit step 2.1).
//
// The producer counterpart to the viewer's `useOverlaySession`: `createDirectorSession`
// is the ONE headless, platform-neutral brain every CREATOR studio drives (web
// `store/live.ts`, the coming mobile creator studio). It REPLACES the web-only
// producer fork: `goLive`/`endLive`/`activate`/`displayMaterial`/`serve*`/
// `broadcastScene`/`broadcastLiveSync`/`publishManifest`/`setDocPage`/
// `setDocPresenter`/vote-aggregation collapse into THIS, so the producer lifecycle
// exists ONCE and can never drift across platforms.
//
// Framework-light like `createStudioSync` (NOT a React hook): no React, no zustand,
// no DOM, no RN, no `livekit-client`. The brain orchestrates over injected seams —
// `DirectorTransport` (signal fan-out), `DirectorMedia` (room + capture + publish),
// the §1.4 `Compositor`, the §1.1 `MaterialsClient`, and the §1.2/§1.3 scenes +
// scheduling `StoreHandle`s — and exposes `getState`/`subscribe` so a platform store
// mirrors its state.

export { createDirectorSession } from './session';

// The PURE direction logic (vote-aggregation reconcile, serve-to-slot target,
// scene snapshot/projection) — exported so it's unit-testable with no seams and a
// platform can reuse a piece directly.
export {
  snapshotScene,
  currentSceneSlots,
  resolveOverlayServeTarget,
  resolveDocServeTarget,
  overlaySlotHostId,
  sceneFillFor,
  deriveSceneItems,
  docForSceneSwitch,
  reconcileOverlayChanged,
  reconcileResultsGen,
  // Whiteboard placement helpers: the canonical board-id derivation + the operator's
  // scene-carried `kind:'whiteboard'` instance, so a platform mints the SAME board id
  // the director's scene.sync carries (web Step B/E reuse these).
  wbBoardIdForItem,
  whiteboardInstanceForItem,
  WB_TILE_CANVAS,
} from './logic';
export type { ServedDocs, OverlayChangedDecision } from './logic';

// The seams + the session contract (a platform binds these).
export type {
  DirectorVisibility,
  DirectorStatus,
  DirectorTransport,
  DirectorLiveSync,
  DirectorResultsMsg,
  DirectorOverlayChange,
  DirectorMedia,
  DirectorRoomHandle,
  DirectorRoomOpen,
  DirectorMaterialsRuntime,
  DirectorMaterial,
  DirectorPreloadCache,
  DirectorScenesStore,
  DirectorSchedulingStore,
  DirectorDeps,
  DirectorState,
  DirectorSession,
  PushableOverlay,
  // Re-surfaced consumed seams (so a platform imports the whole contract from here).
  Compositor,
  CompositorFactory,
  MediaSourceHandle,
  MaterialsClient,
  StoreHandle,
  ScenesState,
  StudioSchedulingState,
  ScheduledStream,
} from './types';
