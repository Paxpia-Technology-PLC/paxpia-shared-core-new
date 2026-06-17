// DOC SCROLL — the platform-agnostic MATH for the whole-doc "scroll" view mode
// (the sibling of docViewport.ts, which owns single-page pan/zoom). Scroll mode lays
// every page end-to-end on ONE vertical axis with NO native scroll container (so
// there is no scrollbar — web translates an overflow:hidden layer; mobile a
// reanimated translateY), and mounts only a WINDOW of pages around the current
// position so a 900-page PDF costs O(window) live leaves, not O(pageCount).
//
// Pure: numbers in → numbers out. No DOM, no RN, no fetch. The render layers feed it
// the current position + page count + an overscan and apply the resulting page
// window + derived page index. Used by BOTH the web docLeaves scroll path and the
// mobile WebView scroll bootstrap so the two never diverge.

/** The inclusive [first, last] page indices to MOUNT around `center` for a doc of
 *  `pageCount` pages, keeping `overscan` pages of margin on each side. Off-window
 *  pages render as fixed-extent spacers so the axis length stays correct without
 *  painting them. Clamped to [0, pageCount-1]. Pure.
 *
 *  Example: cullWindow(10, 100, 2) → [8, 12] — mount pages 8..12, spacer the rest. */
export function cullWindow(center: number, pageCount: number, overscan: number): [number, number] {
  if (pageCount <= 0) return [0, 0];
  const c = Math.max(0, Math.min(Math.round(center), pageCount - 1));
  const first = Math.max(0, c - overscan);
  const last = Math.min(pageCount - 1, c + overscan);
  return [first, last];
}

/** The page index the viewport TOP sits on for a normalized scroll position (the
 *  "page derived from position" rule for the bottom bar + the synced `page` field).
 *  scrollPos is "pages-as-float" (4.5 = halfway down page 4), so the page is its
 *  floor, clamped. Pure. */
export function pageAtScroll(scrollPos: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(scrollPos), pageCount - 1));
}

/** Clamp a proposed normalized scroll position to [0, pageCount-1] (no rubber-band
 *  past the first/last page). The scroll-mode analog of clampPan. Pure. */
export function clampScrollPos(scrollPos: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.max(0, Math.min(scrollPos, pageCount - 1));
}

/** Overscan (pages mounted on EACH side of the centre) for a device tier. Web/desktop
 *  mounts more (smooth fast scroll); a low-RAM phone mounts fewer live page WebViews.
 *  A single knob so the cull window is sized consistently across platforms. */
export const DOC_OVERSCAN_DESKTOP = 2;
export const DOC_OVERSCAN_MOBILE = 1;
