// Pure layout operations — the ENTIRE geometry + ordering logic for scenes lives
// here, once, so the web canvas and the React Native canvas mutate layouts the
// same way (drag, resize, reorder, fit). Every function is pure: it takes a value
// and returns a NEW value (no mutation), so it drops straight into a zustand
// reducer (web) or a useReducer/Redux reducer (RN) with no platform shims.
//
// RN note: the web canvas turns a pointer drag into normalized deltas (px delta ÷
// container size) and calls moveItem/resizeItem; on RN a
// react-native-gesture-handler Pan gesture does the exact same division against
// the measured container, then calls these identical functions. Keeping the math
// here means the gesture handlers on both platforms are thin.

import type { FitMode, LayoutItem, Rect, Scene } from './types';

/** Minimum item size in normalized units, so a tile can't be resized to nothing
 *  (and stays grabbable). 0.08 ≈ 8% of the frame on each axis. */
export const MIN_ITEM = 0.08;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Clamp a rect so it stays FULLY inside the 0..1 frame (never free-form outside).
 *  Order matters: first clamp the SIZE to the frame, then clamp the POSITION so
 *  the (possibly shrunk) box still fits. Guarantees x+w ≤ 1 and y+h ≤ 1, and that
 *  w,h ≥ MIN_ITEM. This is the invariant every move/resize re-establishes. */
export function clampRect(rect: Rect): Rect {
  const w = clamp(rect.w, MIN_ITEM, 1);
  const h = clamp(rect.h, MIN_ITEM, 1);
  const x = clamp(rect.x, 0, 1 - w);
  const y = clamp(rect.y, 0, 1 - h);
  return { x, y, w, h };
}

/** Translate an item by a normalized delta and re-clamp inside the frame. Used by
 *  drag-move: the size is preserved, only the corner moves, and the result can't
 *  leave [0,1]. */
export function moveItem(item: LayoutItem, dx: number, dy: number): LayoutItem {
  return { ...item, rect: clampRect({ ...item.rect, x: item.rect.x + dx, y: item.rect.y + dy }) };
}

/** Which corner a resize handle is anchored to. Resizing from a corner keeps the
 *  OPPOSITE corner pinned, so the box grows/shrinks naturally toward the handle. */
export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

/** Resize an item by dragging `corner` by a normalized delta, keeping the
 *  opposite corner fixed, enforcing MIN_ITEM, and clamping inside the frame.
 *  Pure — returns a new item. The corner handles map directly to the four resize
 *  grips a canvas draws (web) or the gesture anchors RN attaches. */
export function resizeItem(item: LayoutItem, corner: ResizeCorner, dx: number, dy: number): LayoutItem {
  let { x, y, w, h } = item.rect;

  // East/west edges adjust width + (for west) x; north/south adjust height + (north) y.
  const movesWest = corner === 'nw' || corner === 'sw';
  const movesNorth = corner === 'nw' || corner === 'ne';

  if (movesWest) {
    // Left edge moves: x grows by dx, width shrinks by dx (right edge pinned).
    const right = x + w;
    x = clamp(x + dx, 0, right - MIN_ITEM);
    w = right - x;
  } else {
    // Right edge moves: width grows by dx (left edge pinned).
    w = clamp(w + dx, MIN_ITEM, 1 - x);
  }

  if (movesNorth) {
    const bottom = y + h;
    y = clamp(y + dy, 0, bottom - MIN_ITEM);
    h = bottom - y;
  } else {
    h = clamp(h + dy, MIN_ITEM, 1 - y);
  }

  return { ...item, rect: clampRect({ x, y, w, h }) };
}

/** Set an item to an ABSOLUTE normalized rect, clamped inside the frame. Used by
 *  pinch-to-resize and any gesture that computes its FINAL rect directly (rather than
 *  an incremental delta) and commits once — the live drag/pinch runs on the device's
 *  UI thread, then commits the resulting rect here. Pure — returns a new item. */
export function setItemRect(item: LayoutItem, rect: Rect): LayoutItem {
  return { ...item, rect: clampRect(rect) };
}

/** Set an item's fit mode (contain↔cover). Pure helper for the per-item toggle. */
export function setItemFit(item: LayoutItem, fit: FitMode): LayoutItem {
  return { ...item, fit };
}

/** The ONE human label for a fit mode, shared by every fit control + badge on web
 *  and mobile so the vocabulary never drifts: cover → "Crop" (fills, crops the
 *  overflow), contain → "Fit" (letterboxes whole, no crop). Use this everywhere a
 *  fit toggle/badge shows text — for cameras, screen-captures, any media. */
export function fitLabel(fit: FitMode): 'Crop' | 'Fit' {
  return fit === 'cover' ? 'Crop' : 'Fit';
}

/** Normalize z-orders to a contiguous 0..n-1 sequence following the items' draw
 *  order (sorted by z ascending). Call after any reorder so z stays gap-free and
 *  predictable across save/reload + both platforms. Returns a new array. */
export function reorderZ(items: LayoutItem[]): LayoutItem[] {
  return [...items]
    .sort((a, b) => a.z - b.z)
    .map((it, i) => (it.z === i ? it : { ...it, z: i }));
}

/** Move the item with `id` one step up (toward the top, higher z) or down in the
 *  stack — the "bring forward / send backward" buttons in the inputs panel. We
 *  swap the item with its neighbour in DRAW ORDER, then re-stamp z from the new
 *  array index (NOT via reorderZ, which would re-sort by the old z and undo the
 *  swap). Returns items in draw order with contiguous z. Pure. */
export function bumpZ(items: LayoutItem[], id: string, dir: 'up' | 'down'): LayoutItem[] {
  const ordered = [...items].sort((a, b) => a.z - b.z);
  const i = ordered.findIndex((it) => it.id === id);
  if (i === -1) return items;
  const j = dir === 'up' ? i + 1 : i - 1;
  if (j < 0 || j >= ordered.length) return items; // already at an edge
  [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  // Re-stamp z by the post-swap array position so the new order sticks.
  return ordered.map((it, idx) => (it.z === idx ? it : { ...it, z: idx }));
}

/** Move the item with `id` to `toIndex` in the TOP-OF-STACK-FIRST ordering (z
 *  descending), then re-stamp z so the new order sticks. This backs the drag-to-
 *  reorder Sources list, whose rows are shown highest-z first: toIndex 0 = bring
 *  fully to the front. We work in the descending array the UI shows, splice the
 *  item to its new slot, then re-stamp z so index 0 gets the HIGHEST z. Returns
 *  items in draw order (z ascending) with contiguous z. Pure — same contract as
 *  bumpZ, so web (dnd-kit) and RN (draggable list) drive it identically. */
export function moveItemZ(items: LayoutItem[], id: string, toIndex: number): LayoutItem[] {
  const desc = [...items].sort((a, b) => b.z - a.z); // top of stack first (UI order)
  const from = desc.findIndex((it) => it.id === id);
  if (from === -1) return items;
  const clamped = toIndex < 0 ? 0 : toIndex > desc.length - 1 ? desc.length - 1 : toIndex;
  if (clamped === from) return items;
  const [moved] = desc.splice(from, 1);
  desc.splice(clamped, 0, moved);
  // desc[0] is front-most → highest z. Re-stamp z = (n-1-index) and return ascending.
  const n = desc.length;
  return desc.map((it, idx) => ({ ...it, z: n - 1 - idx })).sort((a, b) => a.z - b.z);
}

/** Items in draw order (z ascending) — the order a canvas paints / a View tree
 *  stacks. A small convenience so every renderer agrees on order. */
export function itemsInDrawOrder(scene: Scene): LayoutItem[] {
  return [...scene.items].sort((a, b) => a.z - b.z);
}

// ── fit math ─────────────────────────────────────────────────────────────────

/** A box in an arbitrary (px) space — what fitToBox computes for drawing. */
export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Given a destination box (px) and a source's intrinsic size (e.g. a camera's
 *  videoWidth/videoHeight, or a slide's pixel size), compute:
 *   - `draw`: where to PLACE the source (px) so it fits per `fit`.
 *   - `clip`: the destination box itself (cover overflows it → clip to crop).
 *
 *  contain → the source is scaled to fit ENTIRELY inside `dest` and centered;
 *            `draw` may be smaller than `dest` (letterbox gaps around it).
 *  cover   → the source is scaled to COVER `dest` and centered; `draw` may be
 *            larger than `dest` (overflow is cropped by `clip`).
 *
 *  This is the one place fit-vs-shrink is decided. The web compositor draws the
 *  source into `draw` clipped to `clip`; the web preview sets object-fit; RN sets
 *  resizeMode or positions the video child at `draw` inside a clipped parent. The
 *  source's TRUE aspect is honored — fixing the "camera crops to height with no
 *  control" bug, because the box is derived from real source dimensions. */
export function fitToBox(
  dest: PixelBox,
  source: { w: number; h: number },
  fit: FitMode,
): { draw: PixelBox; clip: PixelBox } {
  const clip: PixelBox = { ...dest };
  // Degenerate source (track not ready, 0 dimensions): fill the box, no scaling
  // info available — caller typically shows a placeholder anyway.
  if (!source.w || !source.h) return { draw: { ...dest }, clip };

  const destRatio = dest.w / dest.h;
  const srcRatio = source.w / source.h;
  // contain: pick the scale that keeps the WHOLE source in-box (min).
  // cover  : pick the scale that COVERS the box (max). Equivalent to comparing
  //          the aspect ratios to decide which axis is the limiting one.
  const fitWidthFirst = fit === 'contain' ? srcRatio > destRatio : srcRatio < destRatio;

  let drawW: number;
  let drawH: number;
  if (fitWidthFirst) {
    drawW = dest.w;
    drawH = dest.w / srcRatio;
  } else {
    drawH = dest.h;
    drawW = dest.h * srcRatio;
  }
  // Center the drawn source within the destination box (letterbox or crop).
  const drawX = dest.x + (dest.w - drawW) / 2;
  const drawY = dest.y + (dest.h - drawH) / 2;
  return { draw: { x: drawX, y: drawY, w: drawW, h: drawH }, clip };
}

/** Convert a normalized rect to a px box against a frame size. The single
 *  normalized→px projection both platforms use (web canvas/DOM, RN px layout). */
export function rectToPixels(rect: Rect, frame: { w: number; h: number }): PixelBox {
  return { x: rect.x * frame.w, y: rect.y * frame.h, w: rect.w * frame.w, h: rect.h * frame.h };
}
