// Layout model — the single, platform-agnostic description of HOW a live scene
// is composed: which inputs/overlays exist, where each sits, in what z-order, and
// how each fits its box. This is the contract a streamer AUTHORS and a viewer
// MIRRORS, so the producer preview, the published (composited) video, and the
// consumer player all render the identical arrangement.
//
// ── Coordinate system ───────────────────────────────────────────────────────
// Every rect is NORMALIZED to 0..1 of the 9:16 portrait frame, top-left origin:
//   x,y = top-left corner; w,h = size; all in [0,1].
// Normalized (rather than px) so the SAME numbers drive a 360x640 web preview, a
// 720x1280 publish canvas, and any phone screen — resolution-independent by
// construction. Helpers (clampRect/moveItem/resizeItem) keep items INSIDE [0,1],
// so nothing is ever authored outside the frame (no free-form off-canvas tiles).
//
// ── React Native mapping (this is the spec the RN app follows) ──────────────
// • A `Scene` → an absolutely-positioned container `View` sized to the 9:16 box
//   (e.g. width = screenW, height = screenW * 16/9, clipped via overflow:'hidden').
// • Each `LayoutItem` → an absolutely-positioned child `View`. Convert the
//   normalized rect to px against the container size:
//     left = rect.x * W, top = rect.y * H, width = rect.w * W, height = rect.h * H.
//   Set `zIndex: item.z` and `style.overflow:'hidden'` (so `cover` crops).
// • `type:'camera' | 'screen'` → an `<RTCView>` / `@livekit/react-native`
//   `<VideoTrack>` bound to the track named by `ref`. Apply the fit (see fitToBox):
//     contain → objectFit/resizeMode 'contain' (letterbox), cover → 'cover' (crop).
//   On RN, a raw `<VideoView>` can use `resizeMode`; for finer control use the
//   px box from fitToBox() and position the video child explicitly.
// • `type:'overlay' | 'doc' | 'whiteboard'` → a child `View` hosting the JS overlay
//   renderer (poll/quiz/doc/whiteboard), positioned by the same normalized→px math.
//   A `whiteboard` tile renders the shared `WhiteboardOverlay` (WebView board) inside
//   its box — placed/resized/z-ordered exactly like a doc, composited alongside camera.
// • Gestures (drag-move, corner-resize) → react-native-gesture-handler Pan
//   gestures whose onUpdate translates px deltas back into normalized deltas
//   (divide by container W/H) and calls moveItem()/resizeItem() — the SAME pure
//   reducers the web canvas uses. No platform branches in the math.

/** What a layout item shows. Drives which renderer/track binds to the box.
 *  - camera     : a getUserMedia / LiveKit camera track (live video)
 *  - screen     : a getDisplayMedia / LiveKit screen-share track
 *  - overlay    : an interactive overlay widget (poll / quiz / vote-button / etc.)
 *  - doc        : a synced paged document (slides / PDF / worksheet)
 *  - whiteboard : a synced, takeover-capable freehand board (the shared
 *                 `WhiteboardOverlay`, WebView-rendered) — a first-class POSITIONABLE
 *                 scene source like `doc`, so a board composes inside a multi-source
 *                 9:16 scene (camera + whiteboard + …) rather than being full-frame only. */
export type LayoutItemType = 'camera' | 'screen' | 'overlay' | 'doc' | 'whiteboard';

/** How the source content fits its (normalized) box:
 *  - contain: scale to fit ENTIRELY inside the box — letterbox bars, NO crop.
 *             Use when the source aspect must be preserved whole (a slide/doc).
 *  - cover  : scale to FILL the box — crops the overflow, NO letterbox. Use for
 *             camera tiles you want edge-to-edge.
 *  Maps to CSS object-fit on web and resizeMode on React Native 1:1. */
export type FitMode = 'contain' | 'cover';

/** A normalized rectangle in 0..1 frame space (top-left origin). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One placed element in a scene. `ref` ties the box to its live source: a
 *  device/track id for camera/screen, or an overlay/doc instance id. The model
 *  carries NO MediaStream/DOM — those live per-platform and are looked up by
 *  `ref`, keeping this description serializable + RN-portable. */
export interface LayoutItem {
  id: string;
  type: LayoutItemType;
  /** Placement in 0..1 frame space. Always kept inside [0,1] by the helpers. */
  rect: Rect;
  /** Stacking order; higher draws on top. Contiguous after reorderZ(). */
  z: number;
  /** Letterbox (contain) vs crop (cover) for this item's source. */
  fit: FitMode;
  /** Live-source binding: device/track id (camera/screen) or overlay id. */
  ref?: string;
  /** Human label for the inputs panel / a11y (optional). */
  label?: string;
}

/** A named composition of items. A producer authors several scenes and switches
 *  the active one live; the viewer mirrors whichever scene is active. */
export interface Scene {
  id: string;
  name: string;
  items: LayoutItem[];
}

/** The frame aspect every rect is normalized against. Portrait 9:16 for now
 *  (the web "mobile simulation"); kept as a constant so the publish canvas and
 *  any preview agree on the box ratio. width/height are RELATIVE (ratio only). */
export const FRAME_ASPECT = { w: 9, h: 16 } as const;

/** Frame aspect ratio as width/height (9/16 = 0.5625). */
export function frameAspectRatio(): number {
  return FRAME_ASPECT.w / FRAME_ASPECT.h;
}
