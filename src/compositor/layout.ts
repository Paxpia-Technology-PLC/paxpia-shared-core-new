// compositor/layout — THE CANONICAL scene→output placement math (WI-17).
//
// ── The bug this fixes ───────────────────────────────────────────────────────
// Mobile published the active scene's PRIMARY tile FULL-FRAME (its raw camera
// track straight to the SFU), ignoring the scene's authored rect/placement. So a
// scene that places a camera in a small corner, or a cam+screenshare split, looked
// CORRECT in the mobile studio preview + on web when WEB streams (web composites
// each item onto a 9:16 canvas via `studio/compositor.ts drawItem`), but a
// MOBILE-streamed scene always arrived on web viewers stretched to the whole frame.
//
// The placement math lived in TWO ad-hoc places — web `studio/compositor.ts`
// (`rectToPixels` + `fitToBox` per item into a canvas) and the mobile native
// Kotlin (`PaxpiaCompositorCapturer.tileViewport` / `coverCropMatrix`) — with no
// single shared contract that mobile's TS compositor pushed down. This module is
// that contract: one pure function that turns a Scene's media items into the exact
// ordered pixel rects (+ crop info) a compositor paints, so web preview, the
// MOBILE published frame, and the viewer render are byte-for-byte the same layout.
//
// PURE: no DOM / RN / MediaStream — only the layout model + the shared `fitToBox`/
// `rectToPixels`/`itemsInDrawOrder` geometry (already in `@paxpia/core/layout`).
// A platform compositor consumes the output: web draws each `placement` into its
// `dest`/`draw`/`clip` on a canvas; mobile maps each to a native tile viewport;
// iOS/Android realize the SAME `cover`/`contain` crop natively.

import { fitToBox, itemsInDrawOrder, rectToPixels, type PixelBox } from '../layout/ops';
import { FRAME_ASPECT, type FitMode, type LayoutItem, type Scene } from '../layout/types';

/** The pixel-space placement of ONE media tile on the output canvas. Everything a
 *  compositor needs to paint the tile, derived once from the scene + the output
 *  size so no platform re-derives geometry. */
export interface TilePlacement {
  /** The scene item this came from (id/type/ref/z/fit carried for the platform). */
  item: LayoutItem;
  /** The tile's box on the output canvas (px) — `rectToPixels(item.rect, out)`. The
   *  destination rect every platform clips to. */
  dest: PixelBox;
  /** z-order (ascending = drawn first / background). Same as `item.z`, surfaced so a
   *  consumer that flattens to a list keeps painter's order without re-reading the item. */
  z: number;
  /** Fit mode for this tile (cover = crop to fill; contain = letterbox whole). */
  fit: FitMode;
  /** True when `fit === 'cover'` — the common "crop to fill the box" mode. A small
   *  convenience for native bridges whose tile shape carries a boolean `cover`. */
  cover: boolean;
}

/** The full composite plan for a scene: the ordered media tile placements on a
 *  fixed-size 9:16 output, plus quick predicates a compositor branches on. */
export interface CompositePlan {
  /** Output canvas size (px) the placements are computed against (9:16). */
  output: { w: number; h: number };
  /** Media tiles (camera/screen only) in DRAW ORDER (z ascending). overlay/doc/
   *  whiteboard items are composed on the VIEWER as interactive layers, never baked
   *  into the published video — so they are excluded here (parity with web's
   *  `drawItem` skip + the seam doc in `compositor/types.ts`). */
  tiles: TilePlacement[];
  /** The lowest-z media tile (the "primary" / background source), or null when the
   *  scene has no media. The passthrough fallback publishes THIS source raw. */
  primary: TilePlacement | null;
  /** True when the scene needs a real multi-tile / placed composite rather than the
   *  raw passthrough of the primary source. See {@link sceneNeedsComposite}. */
  needsComposite: boolean;
}

/** A reference 9:16 output size (px) when a caller doesn't supply one. Matches the
 *  web canvas + the native compositor default (720×1280). Computed from
 *  `FRAME_ASPECT` so it can never drift from the layout model's frame ratio. */
export const DEFAULT_COMPOSITE_HEIGHT = 1280;
export function defaultCompositeOutput(): { w: number; h: number } {
  const h = DEFAULT_COMPOSITE_HEIGHT;
  const w = Math.round((h * FRAME_ASPECT.w) / FRAME_ASPECT.h);
  return { w, h };
}

/** The camera/screen items of a scene in draw order (z ascending). The only items
 *  that carry pixels a compositor bakes into the published track. */
export function mediaItemsInDrawOrder(scene: Scene): LayoutItem[] {
  return itemsInDrawOrder(scene).filter((i) => i.type === 'camera' || i.type === 'screen');
}

/** Is a normalized rect effectively the WHOLE frame (full-bleed primary)? A tile
 *  authored at {0,0,1,1} (the `defaultRect(0)` first-source placement) covers the
 *  whole 9:16 output, so publishing its source raw IS the correct composite — no
 *  per-pixel placement needed. Anything smaller / offset is a real placement the
 *  compositor must honor. `eps` absorbs float authoring noise. */
export function isFullFrameRect(rect: { x: number; y: number; w: number; h: number }, eps = 0.001): boolean {
  return (
    Math.abs(rect.x) <= eps &&
    Math.abs(rect.y) <= eps &&
    Math.abs(rect.w - 1) <= eps &&
    Math.abs(rect.h - 1) <= eps
  );
}

/** Does the active scene need a placed/multi-tile COMPOSITE (vs raw passthrough of
 *  the single primary source)? True when EITHER:
 *   • the scene has >1 media tile (cam + screenshare, two cameras), OR
 *   • the single media tile is NOT full-frame (a small/offset camera that must be
 *     placed at its authored rect over the background, not stretched edge-to-edge).
 *  This is the WI-17 fix: a single placed camera publishes at its rect with the rest
 *  of the 9:16 frame as background, instead of being blown up to fill the display.
 *  Also requires the tile's `cover` fit to honor `contain` letterboxing (a single
 *  full-frame `contain` camera would letterbox, which the raw passthrough can't do —
 *  so a non-cover primary needs the composite too). */
export function sceneNeedsComposite(scene: Scene | undefined): boolean {
  if (!scene) return false;
  const media = mediaItemsInDrawOrder(scene);
  if (media.length === 0) return false;
  if (media.length > 1) return true;
  const only = media[0];
  return !isFullFrameRect(only.rect) || only.fit !== 'cover';
}

/** Compute the full composite plan for a scene against an output size (default 9:16
 *  720×1280). Each media item → its `dest` px box (via the shared `rectToPixels`),
 *  in draw order, with its fit. The platform compositor then uses `fitToBox`
 *  (re-exported here as {@link tileDraw}) with the SOURCE's true dimensions to crop/
 *  letterbox inside `dest`. Pure. */
export function composeScene(scene: Scene | undefined, output?: { w: number; h: number }): CompositePlan {
  const out = output ?? defaultCompositeOutput();
  if (!scene) return { output: out, tiles: [], primary: null, needsComposite: false };
  const media = mediaItemsInDrawOrder(scene);
  const tiles: TilePlacement[] = media.map((item) => ({
    item,
    dest: rectToPixels(item.rect, out),
    z: item.z,
    fit: item.fit,
    cover: item.fit === 'cover',
  }));
  return {
    output: out,
    tiles,
    primary: tiles[0] ?? null,
    needsComposite: sceneNeedsComposite(scene),
  };
}

/** Given a tile placement + the source's intrinsic pixel size, the px `draw`/`clip`
 *  boxes to paint (the shared `fitToBox` applied to the tile's `dest`). A thin
 *  convenience so a canvas consumer doesn't re-import `fitToBox` separately — it's
 *  the EXACT call web's `drawItem` makes today, now sourced from the shared plan. */
export function tileDraw(
  placement: TilePlacement,
  source: { w: number; h: number },
): { draw: PixelBox; clip: PixelBox } {
  return fitToBox(placement.dest, source, placement.fit);
}
