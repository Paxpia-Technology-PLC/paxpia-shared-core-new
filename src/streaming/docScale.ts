// docScale — the ONE page-fit scale every SINGLE-PAGE PDF rasterizer uses.
//
// ─── WHERE THIS CAME FROM ────────────────────────────────────────────────────
// The expression is lifted VERBATIM out of the mobile doc pane's own bootstrap
// (`Paxpia-mobile/src/components/live/document/docWebViewHtml.ts`, commit
// d9e721b "Live session hardening"), where it shipped verified: tsc clean, the
// full jest suite clean, and a physical-iOS pass. Its comment there stated the
// intent, which is preserved here because it is the whole point of the helper:
//
//     Height as well as width: the scale below fits the page to BOTH, so a page
//     taller than the frame is scaled to fit instead of being cropped by the
//     body's overflow:hidden. For the common cases (a 16:9 deck, an A4 portrait
//     page on a phone) width is still the binding constraint, so this changes
//     the rendered resolution for neither — it only bounds the pathological one.
//
// ─── WHY IT IS A SAFETY BOUND AND NOT JUST A LAYOUT NICETY ───────────────────
// Fitting on WIDTH ALONE makes the backing store `frameW · dpr · (h / w)` tall,
// with nothing on the right-hand side bounded. A "large PDF" — an A0 poster, a
// stitched scan, a long single-page export — carries an aspect ratio no phone
// frame implies. At dpr 3 on a 430pt device that is 1290px wide; aspect 20:1
// gives a ~25,800px canvas, ≈133 MB of backing store for ONE page. That is past
// iOS Safari's ~16.7 MP canvas ceiling and past what an Android WebView will
// allocate, so pdf.js draws into a canvas that silently failed to allocate (a
// blank pane, no error) or the renderer process is OOM-killed mid-lesson.
// Binding the OTHER axis too caps the backing store at one frame's worth of
// pixels, whatever the page's aspect ratio.
//
// ─── SINGLE-PAGE ONLY, DELIBERATELY ──────────────────────────────────────────
// This is a fit-to-frame, so it belongs only where ONE page occupies the whole
// frame. A SCROLL-mode viewer stacks pages in a scroller and must stay
// fit-WIDTH: binding height there would shrink an ordinary A4 page until the
// whole document fitted on screen, leaving nothing to scroll. Scroll mode's own
// unbounded-growth problem is a different defect with a different fix (it never
// releases a rasterized canvas) and is tracked separately — do not "fix" it by
// reaching for this.
//
// ─── WHY THE JS SOURCE IS A SEPARATE CONSTANT ────────────────────────────────
// Two of the three consumers are string builders that inject this into a WebView
// document, so they need the expression as TEXT. Deriving that text from the
// function with `Function.prototype.toString()` would guarantee they agree, but
// Hermes does not retain function source — it answers `toString()` with a
// `[bytecode]` stub — so on the phone the injected bootstrap would be a syntax
// error. The text is therefore written out, and `test/docScale.test.ts` EVALUATES
// it and asserts it agrees with the function below on a table that includes the
// pathological aspect ratios. That test is what keeps the two byte-identical;
// edit one without the other and it fails.

/** Just the page geometry the scale needs — pdf.js' `getViewport({scale:1})`
 *  result satisfies it structurally, as does any `{width, height}`. */
export interface PdfPageSize {
  width: number;
  height: number;
}

/**
 * The render scale for ONE PDF page presented whole inside a frame.
 *
 * @param base    the page at `scale: 1` (`page.getViewport({scale: 1})`).
 * @param frameW  frame width in CSS px.
 * @param frameH  frame height in CSS px.
 * @param dpr     device pixel ratio, so the raster is crisp at 1:1.
 * @returns       the scale to pass to `getViewport({scale})`.
 */
export function fitScaleToFrame(
  base: PdfPageSize,
  frameW: number,
  frameH: number,
  dpr: number,
): number {
  return Math.min(frameW / base.width, frameH / base.height) * dpr;
}

/** The name `FIT_SCALE_TO_FRAME_JS` defines, for injected bootstraps to call. */
export const FIT_SCALE_TO_FRAME_FN = '__fitScaleToFrame';

/** `fitScaleToFrame` as JS source, for the WebView string builders. Identical
 *  expression to the function above; `test/docScale.test.ts` enforces that. */
export const FIT_SCALE_TO_FRAME_JS =
  'function ' + FIT_SCALE_TO_FRAME_FN + '(base,frameW,frameH,dpr){' +
  'return Math.min(frameW/base.width,frameH/base.height)*dpr;}';
