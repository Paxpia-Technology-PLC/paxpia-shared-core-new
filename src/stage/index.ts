// @paxpia/core/stage — what's on air right now in a live class session, and the
// pure compiler that turns it into a `Scene` (see types.ts / ops.ts headers).

export type { PaneSlotId, PaneSource, Rect, StageSpec } from './types';
export { CAMERA_BUBBLE_H, CAMERA_BUBBLE_W, MAX_SPLIT, MIN_SPLIT, defaultCameraRect } from './types';

export {
  addToStage,
  cameraItemId,
  cameraRect,
  clearAllPanes,
  clearPane,
  compileStage,
  exitFullscreen,
  filledPanes,
  initialStage,
  moveCameraBy,
  nearestCorner,
  paneRects,
  paneSourceForKitItem,
  paneSourceLabel,
  releaseCameraDrag,
  resetSplit,
  setActivePane,
  setCameraRect,
  setCameraVisible,
  setPane,
  setSplit,
  swapPanes,
  toggleCamera,
  toggleFullscreen,
  visiblePanes,
} from './ops';
