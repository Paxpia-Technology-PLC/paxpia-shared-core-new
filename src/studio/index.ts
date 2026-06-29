// @paxpia/core/studio — the educator/streamer STUDIO state model + account-config
// sync (audit step 1.2), lifted out of Paxpia-web so the SAME tutor config the web
// studio authors can later be loaded + authored by the mobile creator studio.
//
// Three layers, all platform-neutral (no zustand, no DOM, no RN — pure functions +
// types; the platform keeps a thin store wrapper that delegates here):
//   • scenes       — pure producer-scenes reducers over `ScenesState` (the scene
//                    list + active selection; geometry flows through `layout/*`).
//   • assignments  — pure per-scene overlay-assignment FLOWS over the generic
//                    `AssignmentsState<P>` (auto-resolve + manual drag-drop + clear),
//                    threading the `overlays/target` resolution reducers.
//   • sync         — the account-blob GET/PUT coordinator (`createStudioSync`) over
//                    injected store handles + an `AuthHandle` + a `StudioConfigClient`
//                    (a `fetch`-like + auth header) + a `StorageAdapter` cache seam.

// ── Shared types + seams ─────────────────────────────────────────────────────
export type {
  IdGen,
  ScenesState,
  AssignmentsState,
  ActiveSceneItems,
  StorageAdapter,
  StudioConfigBlob,
  RawStudioConfigBlob,
} from './types';
// NB: `SlotAssignment` is intentionally NOT re-exported here — it's already public
// via `@paxpia/core` (from `overlays/target`); re-exporting the same symbol through
// the top-level `export * from './studio'` would clash. Consumers import it from
// `@paxpia/core` directly.
export { defaultIdGen } from './types';

// ── Scenes model ─────────────────────────────────────────────────────────────
export type { AddItemOpts } from './scenes';
export {
  initialScenesState,
  activeScene,
  addScene,
  removeScene,
  setActive,
  renameScene,
  moveScene,
  addItem,
  removeItem,
  moveItemBy,
  resizeItemBy,
  setItemFitById,
  bumpItemZ,
  moveItemZById,
  // Scene-name rules (1..12 chars), shared by web + mobile UI + the API.
  SCENE_NAME_MAX_LEN,
  clampSceneName,
  isValidSceneName,
} from './scenes';

// ── Assignments model ────────────────────────────────────────────────────────
export type { BodyAdapter } from './assignments';
export {
  initialAssignmentsState,
  getAssignment,
  activate,
  assignToTarget,
  clearAssignment,
} from './assignments';

// ── Config API seam ──────────────────────────────────────────────────────────
export type {
  FetchLike as StudioConfigFetchLike,
  FetchRequestInit as StudioConfigFetchRequestInit,
  FetchResponse as StudioConfigFetchResponse,
  StudioConfigClient,
  StudioConfigResponse,
} from './config';
export { getStudioConfig, putStudioConfig } from './config';

// ── Sync coordinator ─────────────────────────────────────────────────────────
export type {
  StoreHandle,
  StudioSchedulingState,
  AuthHandle,
  StudioSyncDeps,
  StudioSync,
} from './sync';
export { createStudioSync, STUDIO_BLOB_VERSION, SAVE_DEBOUNCE_MS } from './sync';
