// DOC VIEWPORT — the platform-agnostic zoom/pan MATH for the doc/image viewer. It
// is the single source of truth for "where is the content after the user zoomed
// toward their cursor / panned with arrows / dragged", so the web DocOverlay
// (wheel + keys + drag) and the mobile DocPdfRenderer (pinch + pan gesture) bottom
// out on the EXACT same transform. The render layers only wire events to these
// functions and apply the resulting { scale, panX, panY } to their transform.
//
// ── The transform model these numbers describe ───────────────────────────────
// The content is drawn with `translate(panX, panY) scale(scale)` about the
// CONTAINER CENTRE (CSS transform-origin: center; the RN equivalent is a centred
// content box). panX/panY are in container px. At scale = 1 the content exactly
// fills the container (object-contain), so there is nothing to pan; as scale grows
// the overflow on each axis is `(scale - 1) * size`, half of which can move in
// either direction before an edge pulls inside the frame.
//
// Pure: no DOM, no RN, no fetch. Only numbers in → numbers out, so it is unit-
// testable and identical on every platform. Zoom is clamped via clampDocZoom (owned
// here, re-exported by docRender for back-compat) so a wheel on web and a pinch on
// mobile top/bottom out at the same DOC_MIN_ZOOM..DOC_MAX_ZOOM.

/** The zoom clamp shared by both doc renderers (web wheel-zoom + RN pinch) and the
 *  viewport math below. The SINGLE source so a pinch on mobile and a wheel on web
 *  bottom/top out the same; docRender re-exports these so existing imports of
 *  `DOC_MIN_ZOOM` / `DOC_MAX_ZOOM` / `clampDocZoom` from there keep working. */
export const DOC_MIN_ZOOM = 1;
export const DOC_MAX_ZOOM = 4;

/** Clamp a proposed zoom into [DOC_MIN_ZOOM, DOC_MAX_ZOOM]. Pure; shared so the
 *  gesture math can't drift between platforms. */
export function clampDocZoom(z: number): number {
  return Math.min(DOC_MAX_ZOOM, Math.max(DOC_MIN_ZOOM, z));
}

/** A 2-D size (the container the doc paints into), in px. */
export interface ViewportSize {
  width: number;
  height: number;
}

/** A point in CONTAINER coordinates (0,0 = the container's top-left), in px. The
 *  cursor/pinch-focus position for zoom-at-point. */
export interface ViewportPoint {
  x: number;
  y: number;
}

/** The doc viewport transform: a zoom scale + a pan translation (px), matching the
 *  renderer's `translate(panX, panY) scale(scale)` about the container centre.
 *  Serializable + identical to the px fields of DocPresenterState (zoom/panX/panY),
 *  so the streamer can broadcast it and a viewer can mirror it 1:1. */
export interface DocViewport {
  scale: number;
  panX: number;
  panY: number;
}

/** The identity viewport: fit (scale 1), no pan. The reset-to-fit target. */
export function fitViewport(): DocViewport {
  return { scale: DOC_MIN_ZOOM, panX: 0, panY: 0 };
}

/** Half the pannable overflow on one axis for a given scale + container size. At
 *  scale ≤ 1 the content fits, so the bound is 0 (no pan). Above 1 the content is
 *  `(scale - 1) * size` larger than the frame; half of that can move either way
 *  before the opposite edge crosses into view. */
function panBound(scale: number, size: number): number {
  return Math.max(0, ((scale - 1) * size) / 2);
}

/** Clamp a pan translation so the content can never be dragged entirely out of the
 *  frame: each axis is held within ±panBound(scale, size). At scale 1 this snaps
 *  the pan to 0 (nothing to pan), so a zoom-out always re-centres. Pure. */
export function clampPan(vp: DocViewport, container: ViewportSize): DocViewport {
  const bx = panBound(vp.scale, container.width);
  const by = panBound(vp.scale, container.height);
  const panX = Math.min(bx, Math.max(-bx, vp.panX));
  const panY = Math.min(by, Math.max(-by, vp.panY));
  if (panX === vp.panX && panY === vp.panY) return vp;
  return { ...vp, panX, panY };
}

/** Pan by a screen-space delta (px) and re-clamp. Drives arrow-key pan (a fixed
 *  step per press) and click-drag pan (the pointer delta). Positive dx/dy move the
 *  CONTENT right/down (so an ArrowRight that should reveal content to the right
 *  passes a NEGATIVE dx). The caller picks the sign that matches its input. */
export function panBy(vp: DocViewport, dx: number, dy: number, container: ViewportSize): DocViewport {
  return clampPan({ ...vp, panX: vp.panX + dx, panY: vp.panY + dy }, container);
}

/** Zoom toward a focal point (the cursor / pinch centre) so the content under that
 *  point stays put. `nextScaleRaw` is the proposed new scale (clamped here). With
 *  the centre-origin transform a content point maps to screen as
 *      screen = centre + (content - centre) * scale + pan
 *  Holding the focal screen point fixed across scale s → s' gives
 *      pan' = focus - centre - (focus - centre - pan) * (s'/s)
 *  per axis. The result is re-clamped so the zoom-at-point can't push an edge in.
 *  Pure — web passes the mouse position, RN the pinch focus; same math. */
export function zoomAtPoint(
  vp: DocViewport,
  nextScaleRaw: number,
  focus: ViewportPoint,
  container: ViewportSize,
): DocViewport {
  const next = clampDocZoom(nextScaleRaw);
  if (next === vp.scale) return vp;
  const ratio = next / vp.scale;
  const cx = container.width / 2;
  const cy = container.height / 2;
  const panX = focus.x - cx - (focus.x - cx - vp.panX) * ratio;
  const panY = focus.y - cy - (focus.y - cy - vp.panY) * ratio;
  return clampPan({ scale: next, panX, panY }, container);
}

/** Zoom toward the container CENTRE by a multiplicative step (e.g. the ± buttons,
 *  or a keyboard +/-). A convenience over zoomAtPoint with focus = centre. */
export function zoomByFactor(vp: DocViewport, factor: number, container: ViewportSize): DocViewport {
  return zoomAtPoint(vp, vp.scale * factor, { x: container.width / 2, y: container.height / 2 }, container);
}

/** The pixel step an arrow-key press pans, as a fraction of the container axis, so
 *  a tap moves a sensible, size-relative amount (≈8% of the frame). Shared so web's
 *  arrow-pan and any mobile d-pad/remote pan step identically. */
export const DOC_ARROW_PAN_FRACTION = 0.08;
