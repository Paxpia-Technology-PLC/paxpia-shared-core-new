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
  WbPresenterUpdate,
  DocViewMode,
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
  sceneHasVideoSource,
  assignScene,
  unassignScene,
  initialSceneId,
  // Manifest dedupe by query-stripped asset key — recognizes a re-granted presigned
  // URL as the SAME asset (kills the doc/audio re-grant reload loop on mobile).
  manifestAssetKey,
  dedupeManifestEntries,
  dedupeManifest,
  // Doc view-mode back-compat readers (an old presenter struct → 'single' / 0).
  docViewModeOf,
  docScrollPosOf,
} from './streaming/live';
// DOC SCROLL — whole-doc "scroll" view-mode math (page culling, derived page,
// position clamp). Sibling of docViewport (single-page pan/zoom).
export {
  cullWindow,
  pageAtScroll,
  clampScrollPos,
  DOC_OVERSCAN_DESKTOP,
  DOC_OVERSCAN_MOBILE,
} from './streaming/docScroll';
// FULL-REPLACE scene-overlay model + scene-sync wire — a scene switch ships the
// COMPLETE overlay set (per-scene rects + payloads) and the viewer replaces its
// whole overlay layer (idempotent, monotonic by nonce → no remnants, no centered
// fallback). Shared so web + mobile converge to the exact current scene.
export type { SceneOverlay, RenderedScene, SceneSyncMsg, SceneSlotType } from './streaming/scene';
export {
  emptyRenderedScene,
  applyFullScene,
  visibleOverlays,
  sceneOverlayFor,
  buildRenderedScene,
  slotItemForInstance,
  isSceneSyncMsg,
  encodeSceneSyncMsg,
  decodeSceneSyncMsg,
  SCENE_WIRE_VERSION,
} from './streaming/scene';
// Live VIEWER state machine + in-memory preload cache (the model mobile reuses).
export type { ViewerPhase, ViewerState } from './streaming/viewer';
export {
  initialViewerState,
  manifestHasMaterials,
  applyLiveSync,
  applyOverlayChanged,
  applySceneSync,
  applyWhiteboardMsg,
  applyWbPresenter,
  boardStrokes,
  applyPreloadProgress,
  admitToLive,
  setLocalDocPresenter,
  preloadPct,
  buildManifest,
  manifestEntry,
  // OVERLAY VIEW PERSISTENCE (Contract v2.1 / 1C): the keyed view store reads + the
  // present-not-destroy persist fold (the stable OWNER that survives scene/doc/page
  // transitions — fixes Bug 1a at the model level).
  viewFor,
  applyViewPersist,
} from './streaming/viewer';
// OVERLAY VIEW-STATE PERSISTENCE STORE (Contract v2.1 — the stable OWNER): a
// `persistKey`-keyed `{page, transform}` store that REPLACES the single global
// `docPresenter` slot a scene switch nulled. PRESENT-not-DESTROY pure reducers + the
// shared doc-view key derivation the converged store + the doc module agree on.
export type { ViewStore } from './streaming/persist';
export {
  emptyViewStore,
  readView,
  hasView,
  putView,
  putViewPage,
  putViewTransform,
  docViewPersistKey,
  // NOTE: `wbViewPersistKey` ALSO lives here (next to docViewPersistKey, no import
  // cycle) but is surfaced at the barrel via `overlays/kinds/whiteboard`'s re-export
  // (the documented public path) — re-exporting it here too would be a duplicate.
} from './streaming/persist';
export type { CachedDoc, PreloadCache } from './streaming/preload';
export {
  newPreloadCache,
  isWarm,
  getCachedDoc,
  putCachedDoc,
  materialsToPreload,
  isRenderableMime,
  isPdfEntry,
  isEpubEntry,
  // WEBP/IMAGE classification: any image/* mime or image extension (incl. .webp) →
  // the image leaf, so a webp can NEVER fall through to the failing pdf.js leaf.
  isImageEntry,
} from './streaming/preload';
// VIEWER-ENTRY GATE — the ordered fetch-manifest → preload → THEN-connect machine
// the room connection hangs on (kills the manifest-vs-room race that black-screened
// + closed the PC on mobile). The screen connects ONLY when isEntryReady(state).
export type { EntryPhase, EntryState } from './streaming/entry';
export {
  initialEntryState,
  beginEntry,
  onManifestFetched,
  onManifestFailed,
  onEntryPreloadProgress,
  markEntryReady,
  resetEntry,
  isEntryReady,
  isEntryGating,
  entryPreloadPct,
  entryStatusLabel,
  shouldGateSurface,
  ENTRY_FIRST_SNAPSHOT_TIMEOUT_MS,
} from './streaming/entry';
// PRE-JOIN PREP — the room-LISTING manifest (v1) + its parser, the producer-side
// deriveManifest, and the CLOCKLESS createEntryPrep machine (release background
// media → settle/yield beat → preload docs → min-floor → ready). The viewer's
// connect hangs on isPrepReady; an empty manifest skips straight to ready. Web +
// RN share the whole machine (no DOM in core).
export type {
  RoomManifest,
  RoomManifestDoc,
  RoomManifestOverlay,
  DeriveScene,
  DeriveSceneItem,
  DeriveTrackConfig,
  PrepPhase,
  PrepState,
  PrepWork,
  CreateEntryPrepOptions,
  // DEVICE TIERING: classify a device from its (often-missing) hardware signals,
  // then scale the prep min-floor / forced-waiting-room / connect retry policy.
  DeviceTier,
  DeviceSignals,
  PrepTierParams,
  RetryPolicy,
} from './streaming/prep';
export {
  emptyRoomManifest,
  parseRoomManifest,
  // Format-aware doc-kind resolver: a literal image/epub/pdf kind wins, anything
  // ambiguous (missing, or a raw mime like 'image/webp') is sniffed from mime+url so
  // an image (incl. webp) is classified 'image' and never defaulted to 'pdf'.
  normalizeDocKind,
  manifestNeedsPrep,
  manifestHasVideoSource,
  deriveManifest,
  roomManifestToWire,
  createEntryPrep,
  beginPrep,
  prepWork,
  onMediaReleased,
  onSettleFloorElapsed,
  onDocsPreloaded,
  isPrepReady,
  isPrepping,
  prepStatusLabel,
  PREP_MIN_FLOOR_MS,
  classifyTier,
  prepParamsForTier,
  DEFAULT_RETRY_POLICY,
} from './streaming/prep';
// DOC-RENDER MODEL — image/pdf/placeholder render plan + shared zoom clamp, so the
// web + RN doc renderers pick the SAME path for the same doc (only the leaf
// primitive differs). Gives the RN renderer a real PDF branch.
export type { DocRenderKind, DocRenderPlan } from './streaming/docRender';
export {
  resolveDocRender,
  isDisplayableUrl,
  clampDocZoom,
  DOC_MIN_ZOOM,
  DOC_MAX_ZOOM,
} from './streaming/docRender';
// DOC VIEWPORT MATH — pure zoom-at-cursor / clamp-scale / clamp-pan + reset-to-fit,
// so the web DocOverlay (wheel + arrow-keys + drag) and the mobile DocPdfRenderer
// (pinch + pan) share the EXACT same transform brain; only the event source differs.
export type { DocViewport, ViewportSize, ViewportPoint } from './streaming/docViewport';
export {
  fitViewport,
  clampPan,
  panBy,
  zoomAtPoint,
  zoomByFactor,
  DOC_ARROW_PAN_FRACTION,
} from './streaming/docViewport';
// THE ONE SHARED DOC RENDERER (HTML) — a single self-contained pdf.js/epub.js document
// hosted identically in an <iframe> (web) and a react-native-webview (mobile), driven by
// a transform/control postMessage protocol so the docViewport math syncs PDF/EPUB the
// same way it syncs images. libs parameterised (CDN now → local bundle later).
export type {
  DocLibSources,
  DocFrameTransform,
  DocFrameReport,
  BuildDocHtmlOptions,
} from './streaming/docHtml';
export {
  buildDocHtml,
  looksLikeEpub,
  parseDocFrameMsg,
  encodeSetTransform,
  encodeSetPage,
  // WHITEBOARD host→frame encoders (sit beside the doc encoders; same report bridge).
  encodeWbAdd,
  encodeWbDel,
  encodeWbWipe,
  encodeWbSet,
  encodeRequestCapture,
  // The shared frame head + transform/gesture/report preamble — exported so
  // whiteboardHtml reuses them VERBATIM (not for general consumption).
  frameHead,
  runtimePreamble,
  DOC_CDN_LIBS,
  DOC_FRAME_MSG_PREFIX,
  DOC_PDFJS_VERSION,
  DOC_EPUBJS_VERSION,
  DOC_JSZIP_VERSION,
} from './streaming/docHtml';
// THE ONE SHARED WHITEBOARD RENDERER (HTML) — a self-contained <svg> board hosted in
// the SAME WebView frame as the doc engine; reuses docHtml's transform/gesture/report
// engine VERBATIM (personal-streamer pan/zoom/takeover for free) + a content-only
// screenshot. Strokes ride the shared `overlay` topic, not a private data plane.
export type { BuildWhiteboardHtmlOptions } from './streaming/whiteboardHtml';
export { buildWhiteboardHtml } from './streaming/whiteboardHtml';
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
// CONNECTION LIFECYCLE: a cancellable connect-generation guard + the benign-error
// classifier (incl. "PC manager is closed") so a teardown/room-switch/unmount that
// races an in-flight connect is SWALLOWED, never surfaced. Pairs with the join
// reconciler (connect decision) + the entry gate (manifest ordering). Web + RN
// classify the SAME set of strings, so a teardown race can't surface on one
// platform after the other learned to ignore it.
export type {
  ConnectGeneration,
  ConnectGuard,
  DisconnectKind,
  SdkConnState,
  RoomStatus,
  // TRACK RECOVERY: the "session alive but video track vanished" axis, orthogonal
  // to the disconnect axis. Re-subscribe the TRACK without bouncing the SESSION.
  TrackRecoveryPhase,
  TrackRecoveryAction,
  TrackRecoveryPolicy,
  TrackRecoveryInput,
} from './streaming/connection';
export {
  newConnectGuard,
  beginConnect,
  cancelConnects,
  wasCancelled,
  isBenignConnectionError,
  connectionErrorMessage,
  shouldSwallowConnectError,
  BENIGN_CONNECTION_ERROR_FRAGMENTS,
  // Disconnect-reason classification + unified room-status model (the "room
  // unavailable / offline" decision), shared web + RN.
  DISCONNECT_REASON,
  classifyDisconnect,
  deriveRoomStatus,
  isBlockingStatus,
  canRejoin,
  // Track-recovery machine (video-track-lost-while-connected).
  DEFAULT_TRACK_RECOVERY_POLICY,
  trackRecoveryPhase,
  nextTrackRecoveryAction,
} from './streaming/connection';
// Shared CDN-snippet PREVIEW state machine (single stable url, refresh cadence,
// exponential back-off, one-load-in-flight). Web + mobile share this brain.
export type { PreviewConfig, PreviewAction, PreviewSnapshot } from './streaming/preview';
export { PreviewMachine, newPreviewMachine } from './streaming/preview';
// PREVIEW HOT-SWAP GATE — the shared "preload the next preview, hold the current
// frame, swap ONLY on a decoded frame" ready-gate. Kills the avatar (web) / black
// (mobile) flash when a tile's preview_url changes. Web + mobile drive it identically.
export type { PreviewSlot, SwapAction, SwapSnapshot } from './streaming/preview';
export { PreviewSwapGate, newPreviewSwapGate } from './streaming/preview';
// EPHEMERAL LIVE CHAT: flat LiveComment + ring-buffer reducer + reliable-track wire
// (CHAT_TOPIC). A viewer publishes; the streamer dashboard + every viewer fold it
// through appendComment. No backend — pure fan-out. Web + RN share the whole model.
export type { LiveComment, LiveCommentKind, ChatLog, ChatMsg, ChatAuthor } from './streaming/chat';
export {
  CHAT_CAP,
  CHAT_TOPIC,
  CHAT_WIRE_VERSION,
  emptyChatLog,
  appendComment,
  commentAuthorLabel,
  isChatMsg,
  encodeChatMsg,
  decodeChatMsg,
  makeComment,
  makeGift,
} from './streaming/chat';
// LIVE VIEWERS: LiveViewer derived from a room participant (identity → stable user
// id; neutral guest until enriched from chat), the gifter-pinned/newest-first
// ordering helper, the deposit-bump, and the P1.6 stage-interactivity SCAFFOLD
// (raise-hand/invite/opt-in/promote types + STAGE_TOPIC + no-op handler).
export type { LiveViewer, ViewerMap, ParticipantLike, StageAction, StageRequest } from './streaming/viewers';
export {
  viewerLabel,
  viewerIdFromIdentity,
  participantToViewer,
  isWatcher,
  addViewer,
  removeViewer,
  enrichFromComment,
  applyGift,
  orderViewers,
  STAGE_TOPIC,
  STAGE_WIRE_VERSION,
  isStageRequest,
  applyStageRequest,
} from './streaming/viewers';
export * from './overlays';
// THIN PLATFORM-BINDING TRANSPORT interfaces — `OverlayTransport`
// (respond/requestState/publish/onEvent) + `RoomHandle` (teardown + opaque
// track/audio tokens + bound transport). The seam between the pure render-brain /
// gate and the LiveKit SDK that only lives in a platform shell. Type-only — no
// `livekit-client` in core.
export type { WireOutbound, OverlayTransport, RoomHandle } from './streaming/transport';
// THE OVERLAY SYNC SOURCE SEAM (§3c): `OverlaySyncSource` — the single interface
// the render-brain consumes for a converged `ViewerState`, with `LwwSyncSource`
// (ship) and `CrdtSyncSource` (later) swappable behind it. Plus its supporting
// types: `LocalOverlayMutation` (produce-side intents) + `ReconnectPlan` (the
// formalized recovery plan). The seam's other vocabulary — `OverlayChannelEvent`
// (the decoded channel event) and `WireOutbound` — are exported from their owning
// modules (overlays/consume + streaming/transport, both barreled above). Designed
// now so a CRDT layer slots under the render-brain untouched.
export type {
  OverlaySyncSource,
  LocalOverlayMutation,
  ReconnectPlan,
} from './streaming/syncSource';
// Task B — `LwwSyncSource`: the ship-first sync source wrapping the existing pure
// reducers (behaviour-identical to today). `foldEvent` is the exported ingest
// routing table (decoded channel event → reducer) the render-brain + tests share.
export { LwwSyncSource, createLwwSyncSource, foldEvent } from './streaming/syncSource';
// Task C — `useOverlaySession`: the ONE headless render-brain hook (web + mobile +
// studio + creator dashboard) over { source, transport }. Returns today's
// LivestreamSync shape ONCE. The vote/takeover folds are exported as pure reducers
// (`applyVoteChanged`/`applyVoteResults`/`applyOptimisticVote`/`deriveVoteView`/
// `reconcileDocTakeover`) so they're testable with no React renderer.
export type {
  OverlaySession,
  UseOverlaySessionArgs,
  VoteState,
  PresentedDoc,
} from './streaming/useOverlaySession';
export {
  useOverlaySession,
  initialVoteState,
  applyVoteChanged,
  applyVoteResults,
  applyOptimisticVote,
  deriveVoteView,
  reconcileDocTakeover,
} from './streaming/useOverlaySession';
// THE CONSOLIDATED ENTRY GATE TYPES (§5a/§5b) — `GateStepId`/`GateStep`/`GateState`
// (the two-checklist machine output), `GateConnectOpts`/`GateReadinessSignals`, and
// the `GateAdapter` callback contract (the only platform code in the gate). TYPES
// ONLY for now; the machine impl is Task D. The gate owns the connect (LiveKit
// behind it), branches on `expectVideo` (video-less first-class), and applies mute
// pre-session.
export type {
  GateStepId,
  GateStep,
  GateState,
  GateConnectOpts,
  GateReadinessSignals,
  GateAdapter,
  AbortLike,
} from './streaming/gate';
// Task D — the pure GATE MACHINE: `initialGateState`/`createGate` + the
// `gateTransition` reducer composing prep + entry + connection into ONE checklist,
// with the `expectVideo:false` branch (audio-only rooms pass on audio+manifest
// alone — the video-less boot-loop fix) and `mute-applied` as a pre-session step.
export type { GateMachine, GateEvent } from './streaming/gate';
export {
  deriveExpectVideo,
  deriveRoomExpectVideo,
  manifestIsAudioOnly,
  roomHasMaterials,
  buildGateSteps,
  initialGateState,
  gateTransition,
  createGate,
  canGateHandOff,
} from './streaming/gate';
// Layout: the canonical resizable/reorderable scene model (LayoutItem, Scene,
// clampRect/moveItem/resizeItem/reorderZ/fitToBox). RN-portable; web + mobile share it.
export * from './layout';
// MATERIALS: the private class-materials domain (`doc` overlay pipeline v2) — the
// RN-portable MaterialMeta/MaterialGrant model + the ONE grant/freshness path
// (mapGrant/grantOne/buildManifestEntries/…) behind an injected platform `fetch`
// seam (MaterialsClient), so web + mobile derive fresh presigned URLs from one
// source. The platform binds its fetch + auth token + render (pdf.js / RN).
export * from './materials';
// COMPOSITOR SEAM (§1.4): the platform-agnostic `Compositor` interface (+ its
// factory/config + opaque media-handle aliases) the producer brain (§2.1) binds a
// per-platform compositor through — like `OverlayTransport`/`LeafAdapter`. Named
// (not `*`) so it never re-collides with the `fitToBox`/`Scene` geometry the
// compositor barrel re-exports from `layout/` (already top-level above). The full
// subpath `@paxpia/core/compositor` bundles the seam + that shared geometry.
export type {
  Compositor,
  CompositorFactory,
  CompositorConfig,
  MediaSourceHandle,
  OutputVideoTrack,
} from './compositor';
// SCHEDULING (§1.3): the SCHEDULE-as-TIMELINE class model (ordered timeline of
// materials + inline overlays, per-class scene assignment, live-run done-flags)
// graduated out of the web `store/studio.ts` so web + mobile share ONE scheduling
// model (the mobile `TeachingSession` fork retires onto it). The pure REDUCERS
// (`addScheduled`/`moveItem`/`setDone`/…) are reachable via the
// `@paxpia/core/scheduling` subpath — NOT re-exported here because `moveItem` would
// clash with layout's `moveItem`. Only the TYPES are surfaced at top level (the model
// is unambiguous); a store delegates to the subpath reducers. `previewInstance`
// (authored-overlay → static OverlayInstance) rides along.
export type {
  AuthoredKind,
  AuthoredPayload,
  DoneFlag,
  TimelineMaterialItem,
  TimelineOverlayItem,
  TimelineItem,
  TimelineOverlay,
  ScheduledVisibility,
  ScheduledStream,
  PreviewOverlayInstance,
} from './scheduling';
export { previewInstance } from './scheduling';
// STUDIO (§1.2): the educator/streamer studio STATE MODEL + account-config SYNC,
// lifted out of Paxpia-web so the SAME tutor config web authors can later be loaded
// + authored by the mobile creator studio. Pure scene/assignment store reducers
// (over the already-shared layout/target reducers) + the account-blob GET/PUT
// coordinator (`createStudioSync`) behind two injected seams: a `StorageAdapter`
// (localStorage ↔ MMKV cache) and a `StudioConfigClient` (a `fetch`-like + auth
// header, mirroring `MaterialsClient`). No zustand/DOM/RN — the platform keeps a
// thin store wrapper that delegates every transition here. The config-fetch
// `FetchLike`/`FetchResponse`/`FetchRequestInit` are surfaced ALIASED
// (`StudioConfig*`) so they don't clash with the materials seam's same-named slice.
export * from './studio';
// DIRECTOR (§2.1): the headless PRODUCER-DIRECTION brain `createDirectorSession` —
// the producer counterpart to the viewer `useOverlaySession`, lifted out of
// `Paxpia-web/src/store/live.ts` so the go-live / serve-to-slot / scene-broadcast /
// vote-aggregation / doc-page+presenter sync lifecycle exists ONCE (web + the coming
// mobile creator studio bind the same brain). Framework-light like `createStudioSync`
// (no React/zustand/DOM/RN/livekit-client); orchestrates over the injected
// `DirectorTransport`/`DirectorMedia`/`Compositor`/`MaterialsClient` seams + the
// scenes/scheduling `StoreHandle`s. The PURE direction logic (vote-aggregate
// reconcile, serve-to-slot target, scene snapshot/projection) is exported for tests.
// The seam interfaces + the full session contract are reachable via the
// `@paxpia/core/director` subpath (NOT re-exported here so the many `Director*` seam
// names don't crowd the top-level surface; a platform binding imports the subpath).
export {
  createDirectorSession,
  // Pure direction logic (unit-testable with no seams).
  reconcileOverlayChanged,
  reconcileResultsGen,
  resolveOverlayServeTarget,
  resolveDocServeTarget,
  docForSceneSwitch,
  // Whiteboard placement: the canonical board-id derivation + the operator's
  // scene-carried `kind:'whiteboard'` instance (web reuses these so the live tile and
  // the director's scene.sync agree on one board id — Step B/E).
  wbBoardIdForItem,
  whiteboardInstanceForItem,
  WB_TILE_CANVAS,
} from './director';
export type { DirectorSession, DirectorState, DirectorDeps } from './director';
