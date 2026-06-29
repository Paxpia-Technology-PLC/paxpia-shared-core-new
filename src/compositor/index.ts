// @paxpia/core/compositor — THE COMPOSITOR SEAM. The platform-agnostic interface
// the producer brain (`DirectorSession`/`useLiveSession`, §2.1) uses to bind a
// per-platform compositor (web canvas2d+rAF+captureStream / RN native|GL, §3.5)
// WITHOUT a platform dependency — analogous to `OverlayTransport` (data channel) +
// `LeafAdapter` (pixel-decoding leaves). Interface-only; no impl here.
export type {
  Compositor,
  CompositorFactory,
  CompositorConfig,
  MediaSourceHandle,
  OutputVideoTrack,
} from './types';

// THE SHARED FRAME GEOMETRY a compositor PAINTS with stays in `@paxpia/core/layout`
// (one home, no duplication). Re-exported HERE so a platform compositor impl can
// pull everything it needs from the single `@paxpia/core/compositor` subpath: the
// `fitToBox` fit-vs-crop math, `rectToPixels` normalized→px projection, the
// `itemsInDrawOrder` paint order, and the `PixelBox` it computes against — the
// exact set the web `studio/compositor.ts` imports today.
export {
  fitToBox,
  rectToPixels,
  itemsInDrawOrder,
  type PixelBox,
} from '../layout/ops';
export {
  FRAME_ASPECT,
  frameAspectRatio,
  type Scene,
  type LayoutItem,
  type LayoutItemType,
  type FitMode,
  type Rect,
} from '../layout/types';

// THE CANONICAL scene→output placement math (WI-17) — the ONE pure function a
// platform compositor consumes to place each media tile at its authored rect on the
// 9:16 output (so a MOBILE-published scene matches the web composite, not stretched
// full-frame). Web `studio/compositor.ts` should adopt `composeScene`/`tileDraw` as
// a follow-up (its `drawItem` already makes the identical `rectToPixels`+`fitToBox`
// call this consolidates).
export {
  composeScene,
  sceneNeedsComposite,
  isFullFrameRect,
  mediaItemsInDrawOrder,
  tileDraw,
  defaultCompositeOutput,
  DEFAULT_COMPOSITE_HEIGHT,
  type CompositePlan,
  type TilePlacement,
} from './layout';
