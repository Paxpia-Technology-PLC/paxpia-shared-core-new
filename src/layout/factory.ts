// Layout constructors + sensible defaults — shared so a scene authored on web and
// a scene authored on mobile start from the IDENTICAL geometry (a fresh camera
// fills the frame; extra tiles drop in as clamped picture-in-picture rects). No
// platform deps; callers pass their own id generator so each app keeps its id
// scheme (web uses Math.random; RN can use the same or a uuid lib).

import { clampRect } from './ops';
import type { FitMode, LayoutItem, LayoutItemType, Rect, Scene } from './types';

/** Default fit per item type: camera/screen tiles fill edge-to-edge (cover);
 *  docs are letterboxed whole (contain) so no slide content is ever cropped;
 *  overlays are widget panels that lay out their own content (contain). */
export function defaultFit(type: LayoutItemType): FitMode {
  return type === 'camera' || type === 'screen' ? 'cover' : 'contain';
}

/** Placement for the Nth item added to a scene. The FIRST item fills the whole
 *  9:16 frame (the primary source); subsequent items cascade in as 40%×30%
 *  picture-in-picture rects, each nudged so they don't perfectly stack. Always
 *  clamped inside the frame. */
export function defaultRect(index: number): Rect {
  if (index === 0) return { x: 0, y: 0, w: 1, h: 1 };
  const off = (index % 4) * 0.06;
  return clampRect({ x: 0.06 + off, y: 0.06 + off, w: 0.4, h: 0.3 });
}

/** A default rect for an overlay/doc/whiteboard/slide item — a lower band (polls) or
 *  a centered card (docs/whiteboard/slide). Docs + whiteboards + slides get a large
 *  centered box (a slide, like a doc, is a content surface drawn over); overlays a
 *  lower-third band. */
export function defaultOverlayRect(type: LayoutItemType): Rect {
  if (type === 'doc' || type === 'whiteboard' || type === 'slide') return { x: 0.06, y: 0.1, w: 0.88, h: 0.6 };
  return { x: 0.05, y: 0.62, w: 0.9, h: 0.33 }; // poll/quiz lower band
}

/** Build a LayoutItem with defaults filled in. `index` decides default placement;
 *  pass an explicit `rect`/`fit` to override. `z` defaults to `index` so newly
 *  added items land on top. */
export function makeItem(
  id: string,
  type: LayoutItemType,
  index: number,
  opts?: { ref?: string; label?: string; rect?: Rect; fit?: FitMode },
): LayoutItem {
  const rect =
    opts?.rect ??
    (type === 'overlay' || type === 'doc' || type === 'whiteboard' || type === 'slide'
      ? defaultOverlayRect(type)
      : defaultRect(index));
  return {
    id,
    type,
    rect: clampRect(rect),
    z: index,
    fit: opts?.fit ?? defaultFit(type),
    ref: opts?.ref,
    label: opts?.label,
  };
}

/** A blank named scene with no items. */
export function makeScene(id: string, name: string): Scene {
  return { id, name, items: [] };
}
