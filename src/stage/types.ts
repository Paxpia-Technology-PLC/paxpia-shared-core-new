// STAGE — what is on air RIGHT NOW in a live class session. The session owns
// this; it compiles down to a `Scene` (see ops.ts `compileStage`), which is the
// SAME wire format the director/compositor/every viewer already speak. That is
// the whole trick behind removing the scene editor without touching the scene
// wire format — see docs/GO-LIVE-REBUILD-PLAN.md §1/§3.
//
// PLATFORM NEUTRALITY: pure serializable model + plain reducers, no RN/DOM. Every
// reducer here returns the SAME object when nothing actually changed (an
// unchanged split, hiding an already-hidden camera) — a caller that recompiles +
// rebroadcasts on every store write depends on that identity check to make a
// no-op drag frame free.

import type { MaterialMeta } from '../materials';

/** A pane's stable role id. NOT freshly minted per layout change — served-doc
 *  state is keyed `sceneId → itemId` and whiteboard strokes are keyed by item id,
 *  so a stable slot id is what lets changing the split, swapping panes, or going
 *  fullscreen preserve the served content instead of orphaning it. */
export type PaneSlotId = 'pane_a' | 'pane_b';

/** What's playing in one pane. */
export type PaneSource =
  | { kind: 'empty' }
  | { kind: 'material'; material: MaterialMeta }
  | { kind: 'book'; courseId: string; moduleId: string; blockId: string }
  | { kind: 'whiteboard' }
  /** No mobile capture path yet (needs a broadcast extension on iOS /
   *  MediaProjection on Android) — the kind exists for web parity; mobile's
   *  `SessionPane` shows a "not available" notice for it. */
  | { kind: 'screen' };

export interface StageSpec {
  /** Both slots always present (never sparse) — an unequipped slot is `{kind:'empty'}`,
   *  which keeps every reducer a total function over `PaneSlotId`. */
  panes: Record<PaneSlotId, PaneSource>;
  /** Pane 'a's height share when both panes are visible. Clamped to [MIN_SPLIT,MAX_SPLIT]. */
  split: number;
  /** The movable camera bubble (D6). Always present — `visible:false` is how a
   *  host hides it without losing its last (dragged) position. */
  camera: { visible: boolean; rect: Rect };
  /** The pane currently filling the frame (tap-to-fullscreen, D4), or null. */
  fullscreen: PaneSlotId | null;
}

/** A normalized rectangle in 0..1 frame space (top-left origin) — re-exported so
 *  callers don't need a second import for the one field they touch. Identical
 *  shape to `@paxpia/core/layout`'s `Rect`; kept as a distinct alias here so the
 *  stage module has no hard dependency on `layout` at the type level (only
 *  `compileStage`, in ops.ts, needs the real `Scene`/`LayoutItem` shapes). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_SPLIT = 0.25;
export const MAX_SPLIT = 0.75;

/** The bubble's default size — visually ~square in rendered pixels against the
 *  9:16 frame (width and height are normalized to DIFFERENT frame dimensions, so
 *  a visual square needs `h = w * (FRAME_W/FRAME_H)`; see `@paxpia/core/layout`). */
export const CAMERA_BUBBLE_W = 0.32;
export const CAMERA_BUBBLE_H = CAMERA_BUBBLE_W * (9 / 16);
const CAMERA_MARGIN = 0.03;

/** The bubble's default (bottom-right corner) position. */
export function defaultCameraRect(): Rect {
  return {
    x: 1 - CAMERA_BUBBLE_W - CAMERA_MARGIN,
    y: 1 - CAMERA_BUBBLE_H - CAMERA_MARGIN,
    w: CAMERA_BUBBLE_W,
    h: CAMERA_BUBBLE_H,
  };
}
