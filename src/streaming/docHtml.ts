// docHtml — the ONE shared synced-document RENDERER. A single self-contained HTML
// document that renders a raw PDF (pdf.js) or EPUB (epub.js) and is hosted IDENTICALLY
// on both platforms: web injects it into an <iframe srcdoc>, mobile into a
// react-native-webview. Same HTML ⇒ same pdf.js/epub.js build ⇒ byte-identical render
// web↔mobile (this is what kills the "different on every front" divergence).
//
// ── WHY ONE HTML FRAME (not web-canvas + mobile-webview) ─────────────────────
// Before this, web rasterised pdf.js to a DOM <canvas> (pdfjs 4.10) while mobile ran
// pdf.js INSIDE a WebView (pdfjs 3.11 from a CDN). Two engines, two versions, two fit
// models. By hosting the SAME HTML in an <iframe> (web) and a WebView (mobile) the
// engine, the version and the fit math are literally the same file.
//
// ── THE TRANSFORM/CONTROL PROTOCOL (§ personal-streamer parity) ───────────────
// Zoom/pan/page are NOT owned by the frame's native pinch any more — native pinch is
// disabled (`user-scalable=no`). Instead the shared `DocOverlay` owns a `{scale,panX,
// panY}` transform (the SAME `docViewport` math used for images) and the synced page,
// and pushes them into the frame as host→frame messages. The frame applies the
// transform as a CSS `transform` on its content and re-rasterises the PDF page crisply
// when zoomed. This means a streamer's zoom/pan/page broadcast and a viewer's local
// takeover work for PDF + EPUB exactly like they already do for images — one model,
// every doc kind, both platforms.
//
//   host → frame (JSON):  {t:'tf',s,x,y}  set transform (live)
//                         {t:'pg',n}      set 0-based page (single mode)
//                         {t:'md',m}      (mode is a build param; sent for completeness)
//   frame → host (string, `pxdoc:` + JSON):
//                         pxdoc:{e:'ready'}
//                         pxdoc:{e:'pages',n}      total page/section count
//                         pxdoc:{e:'page',n}       current 0-based page (after nav)
//                         pxdoc:{e:'interact'}     first user touch → local takeover
//                         pxdoc:{e:'fps',v,mode}   perf sample (device-pass metric)
//                         pxdoc:{e:'err',m}        render error (shows an in-frame card)
//
// PURE string builders — no DOM, no RN, no fetch. The host component (web iframe /
// mobile WebView) owns the wiring; this only describes the document.

import type { DocViewMode } from './live';
import { FIT_SCALE_TO_FRAME_JS, FIT_SCALE_TO_FRAME_FN } from './docScale';
import type { WbStroke } from '../overlays/whiteboard';

/** The pinned doc-engine builds. ONE version everywhere (was pdfjs 4.10 web / 3.11
 *  mobile). Legacy UMD builds so they run in an <iframe> AND on the fleet's older
 *  Android WebViews. */
export const DOC_PDFJS_VERSION = '3.11.174';
export const DOC_EPUBJS_VERSION = '0.3.93';
export const DOC_JSZIP_VERSION = '3.10.1';

/** Where the engine <script>s load from. Default = jsDelivr CDN (works today on the
 *  Mac sim + dev). The DECIDED end state is local bundling: pass a `libBase` that
 *  points at the bundled assets (web `/vendor/`, mobile a file:// asset dir) and the
 *  exact same HTML loads them offline with no version drift. Parameterised so flipping
 *  CDN→local is a one-line host change, not an engine rewrite. */
export interface DocLibSources {
  /** Absolute URL or base of the pdf.js main build. */
  pdfLib: string;
  /** Absolute URL or base of the pdf.js worker build. */
  pdfWorker: string;
  /** Absolute URL of the jszip build (epub dep). */
  jszip: string;
  /** Absolute URL of the epub.js build. */
  epubjs: string;
}

/** The default CDN library sources (current behaviour; swap for local later). */
export const DOC_CDN_LIBS: DocLibSources = {
  pdfLib: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${DOC_PDFJS_VERSION}/legacy/build/pdf.min.js`,
  pdfWorker: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${DOC_PDFJS_VERSION}/legacy/build/pdf.worker.min.js`,
  jszip: `https://cdn.jsdelivr.net/npm/jszip@${DOC_JSZIP_VERSION}/dist/jszip.min.js`,
  epubjs: `https://cdn.jsdelivr.net/npm/epubjs@${DOC_EPUBJS_VERSION}/dist/epub.min.js`,
};

/** The frame→host message prefix. The host strips this and JSON-parses the rest. */
export const DOC_FRAME_MSG_PREFIX = 'pxdoc:';

/** A transform the host pushes into the frame (the shared docViewport numbers). */
export interface DocFrameTransform {
  scale: number;
  panX: number;
  panY: number;
}

/** A decoded frame→host event. Shared by the doc engine AND the whiteboard engine
 *  (streaming/whiteboardHtml.ts) — both render through the SAME frame, so the report
 *  bridge + parser are common. The `wb.draw` / `capture` arms are whiteboard-only. */
export type DocFrameReport =
  | { e: 'ready' }
  | { e: 'pages'; n: number }
  // `n` = the current 0-based page / EPUB section index (the synced scroll position unit).
  // `frac` (optional) = the fine-grained within-section scroll fraction (0..1) an EPUB
  // continuous reader reports so a producer can broadcast — and a viewer converge to — the
  // EXACT scroll offset, not just the section. Absent for paged PDFs (page IS the position).
  | { e: 'page'; n: number; frac?: number }
  | { e: 'interact' }
  // A LOCAL in-frame gesture produced this transform → the shell records it as the
  // viewport and (on a viewer) flips to local takeover (the personal-streamer focus).
  | { e: 'tf'; s: number; x: number; y: number }
  // WHITEBOARD (editable/author mode): a finished local stroke to broadcast upstream.
  | { e: 'wb.draw'; stroke: WbStroke }
  // WHITEBOARD: a content-only screenshot result (base64 PNG data url), chrome-free by
  // construction (chrome lives OUTSIDE the frame). Reply to a host {t:'capture'}.
  | { e: 'capture'; dataUrl: string }
  | { e: 'fps'; v: number; mode?: string }
  | { e: 'err'; m: string };

/** Parse a raw frame→host message string into a typed report (null if it isn't ours).
 *  Used by BOTH platform hosts so the wire format can't drift. */
export function parseDocFrameMsg(raw: string): DocFrameReport | null {
  if (!raw || raw.indexOf(DOC_FRAME_MSG_PREFIX) !== 0) return null;
  try {
    const obj = JSON.parse(raw.slice(DOC_FRAME_MSG_PREFIX.length));
    return obj && typeof obj.e === 'string' ? (obj as DocFrameReport) : null;
  } catch {
    return null;
  }
}

/** Encode a host→frame transform message. */
export function encodeSetTransform(t: DocFrameTransform): string {
  return JSON.stringify({ t: 'tf', s: t.scale, x: t.panX, y: t.panY });
}
/** Encode a host→frame set-page (0-based) message. */
export function encodeSetPage(page0: number): string {
  return JSON.stringify({ t: 'pg', n: Math.max(0, Math.floor(page0)) });
}

/** Encode a host→frame SCROLL-POSITION message (§2 scroll-position sync). `pos` is the
 *  normalized "pages-as-float" coordinate the producer broadcasts (section index + within-
 *  section fraction, e.g. 4.5 = halfway down section 4). The EPUB scroll-mode frame splits
 *  it back into `{i: section, f: fraction}`: it `display(section)`s then scrolls to `f` of
 *  the section's range, so a viewer converges to the streamer's EXACT scroll offset (not
 *  just the section). Paged PDFs ignore it (their position IS the page). Mirrors the frame's
 *  `__onWb`/`pos` intake + the `{e:'page',n,frac}` it reports up. */
export function encodeSetScrollPos(pos: number): string {
  const p = Number.isFinite(pos) ? Math.max(0, pos) : 0;
  const i = Math.floor(p);
  const f = Math.max(0, Math.min(1, p - i));
  return JSON.stringify({ t: 'pos', i, f });
}

// ── WHITEBOARD host→frame encoders (sit beside encodeSetTransform; the whiteboard
//    frame from streaming/whiteboardHtml.ts decodes them in its __onHost intake) ──

/** Append one stroke to the live whiteboard DOM (native composite, no RN re-render). */
export function encodeWbAdd(stroke: WbStroke): string {
  return JSON.stringify({ t: 'wb.add', stroke });
}
/** Remove one stroke from the whiteboard by id. */
export function encodeWbDel(id: string): string {
  return JSON.stringify({ t: 'wb.del', id });
}
/** Clear the whiteboard. */
export function encodeWbWipe(): string {
  return JSON.stringify({ t: 'wb.wipe' });
}
/** Replace the whole whiteboard stroke set (a snapshot apply). */
export function encodeWbSet(strokes: WbStroke[]): string {
  return JSON.stringify({ t: 'wb.set', strokes });
}
/** Ask the frame for a content-only screenshot; it replies {e:'capture',dataUrl}. */
export function encodeRequestCapture(): string {
  return JSON.stringify({ t: 'capture' });
}

export interface BuildDocHtmlOptions {
  /** The doc kind to render. */
  kind: 'pdf' | 'epub';
  /** The presigned source URL of the raw document. */
  url: string;
  /** The 0-based page to show first (single mode). */
  page?: number;
  /** single (one synced page / paginated) or scroll (one continuous scroller). */
  mode?: DocViewMode;
  /** Known total page count hint (single-mode pre-size; the frame re-reports the real
   *  count once the engine opens the doc). */
  pageCount?: number;
  /** Where to load the engine <script>s from (defaults to the jsDelivr CDN). */
  libs?: DocLibSources;
}

/** True if a url looks like an EPUB (by extension or an epub mime in the query). */
export function looksLikeEpub(url: string): boolean {
  const u = url.toLowerCase();
  return /\.epub(\?|#|$)/.test(u) || u.includes('application/epub');
}

// The shared frame head: viewport (native pinch OFF — the shared transform owns zoom),
// base CSS, the report() bridge (postMessage to BOTH the RN bridge and the iframe
// parent), a perf probe, and the host→frame message intake. Concatenated, never a
// template literal at runtime, so the doc-engine's own code can't collide with `${}`.
//
// EXPORTED so streaming/whiteboardHtml.ts reuses the EXACT same frame head (and the
// runtimePreamble transform engine below) VERBATIM — the whiteboard inherits the doc
// personal-streamer pan/zoom/takeover model for free instead of forking the math.
//
// `transparent` (BUG 2 — annotation whiteboard-over-doc): when true the frame is born
// SEE-THROUGH at the SOURCE — `html`,`body`,`#stage`,`#content` all paint `transparent`
// (with `color-scheme:dark` so the browser doesn't impose its own white backdrop on the
// iframe document). This replaces the old approach of a body-level `!important` override
// fighting an already-emitted opaque head rule (which "barely addressed it"); now the
// opaque rule is never emitted for a transparent frame, so the doc underneath shows
// THROUGH with no specificity race. Docs (PDF/EPUB) always pass false (opaque, unchanged).
export function frameHead(mode: DocViewMode, transparent = false): string {
  const scrolled = mode === 'scroll';
  // The page fill: opaque ink for docs / a normal board; fully transparent for an
  // annotation board so the underlying scene/doc composites through every layer.
  const pageBg = transparent ? 'transparent' : '#0b0e16';
  return (
    '<!doctype html><html><head>' +
    '<meta charset="utf-8">' +
    // user-scalable=no: the SHARED transform owns zoom; native pinch is disabled so the
    // gesture layer is the single source of truth (web↔mobile parity).
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">' +
    '<style>' +
    // color-scheme:dark stops the browser painting a default WHITE iframe backdrop behind a
    // transparent document (the subtle bit that made prior transparency attempts still show
    // white). Harmless for the opaque frame.
    ':root{color-scheme:dark;}' +
    'html,body{margin:0;padding:0;background:' + pageBg + ';color:#e8e8ef;}' +
    'html,body{height:' + (scrolled ? 'auto' : '100%') + ';overflow:' + (scrolled ? 'auto' : 'hidden') + ';}' +
    // SINGLE mode: the shared transform owns ALL gestures, so the page must NOT do native
    // pan/zoom/scroll — `touch-action:none` makes Android WebView yield multi-touch (pinch)
    // + drag to our handlers (the missing piece behind "pinch does nothing" + the pan jank /
    // snap-back). Inert on iOS WKWebView. SCROLL mode keeps native touch-action (it scrolls).
    (scrolled ? '' : 'html,body{touch-action:none;-ms-touch-action:none;overscroll-behavior:none;}#stage,#content{touch-action:none;-ms-touch-action:none;}') +
    // #stage = the fixed viewport (single mode). #content = the transformed layer. Both are
    // explicitly transparent for an annotation board so nothing opaque sits over the doc.
    '#stage{position:' + (scrolled ? 'static' : 'fixed') + ';inset:0;overflow:hidden;background:transparent;}' +
    // SINGLE mode also CENTRES the page in the viewport. `.pg` is width-fitted with
    // its natural height, so a page shorter than the frame used to leave all of its
    // slack BELOW it — a 16:9 slide or a portrait cover on a tall phone rendered as a
    // band jammed against the top of the stage, which reads as the material being
    // collapsed rather than presented.
    //
    // `margin:auto` inside a flex column rather than `justify-content:center`: auto
    // margins absorb only FREE space, so they resolve to 0 the moment the page is
    // taller than the stage. A tall page is therefore laid out exactly as before and
    // nothing is clipped off the top — which is what makes this safe for the web
    // frame, where a page usually already fills the height and this is a no-op.
    // SCROLL mode is untouched: it must run past the viewport and start at the top.
    '#content{transform-origin:center center;will-change:transform;width:100%;' + (scrolled ? '' : 'height:100%;display:flex;flex-direction:column;') + 'background:transparent;}' +
    '.pg{display:block;width:100%;margin:' + (scrolled ? '0 auto 8px' : 'auto') + ';background:' + pageBg + ';}' +
    '#e{position:fixed;inset:0;display:none;align-items:center;justify-content:center;color:#9aa;font:13px sans-serif;padding:16px;text-align:center;}' +
    '</style></head><body>'
  );
}

// The shared runtime preamble: report bridge + perf probe + host→frame intake +
// transform application. `applyTransform` is the doc-kind-agnostic CSS apply; the page
// hook (`__onSetPage`) is filled in per kind below.
//
// EXPORTED for streaming/whiteboardHtml.ts: it appends a small whiteboard intake/paint
// shim AFTER this preamble (host wb.add/wb.del/wb.wipe/wb.set + capture), so the
// transform/gesture engine, the report() bridge and `__onHost` are byte-identical to
// the doc frame — the whiteboard gets the personal-streamer transform for free.
export function runtimePreamble(mode: DocViewMode): string {
  const scrolled = mode === 'scroll';
  return [
    'var MODE=' + JSON.stringify(mode) + ';',
    'var PFX=' + JSON.stringify(DOC_FRAME_MSG_PREFIX) + ';',
    // report(obj) → both RN bridge and iframe parent.
    'function report(o){try{var s=PFX+JSON.stringify(o);' +
      'if(window.ReactNativeWebView&&window.ReactNativeWebView.postMessage)window.ReactNativeWebView.postMessage(s);' +
      'if(window.parent&&window.parent!==window)window.parent.postMessage(s,"*");}catch(_){}}',
    'function showErr(m){var e=document.getElementById("e");if(e){e.style.display="flex";e.textContent=m;}}',
    'window.onerror=function(msg,src,line){report({e:"err",m:String(msg)+" @"+(line||0)});return false;};',
    'window.addEventListener("unhandledrejection",function(ev){report({e:"err",m:String(ev&&ev.reason&&(ev.reason.message||ev.reason)||"?")});});',
    // first user touch → interact (host flips to local takeover). Never preventDefault.
    'var __interacted=false;function __fireInteract(){if(__interacted)return;__interacted=true;report({e:"interact"});}',
    'document.addEventListener("touchstart",__fireInteract,{passive:true});',
    'document.addEventListener("pointerdown",__fireInteract,{passive:true});',
    'document.addEventListener("wheel",__fireInteract,{passive:true});',
    // perf probe (fps; device pass reads this off the log).
    'function nowMs(){return (performance&&performance.now)?performance.now():Date.now();}',
    'var __frames=0,__last=nowMs();',
    'function __tick(){__frames++;var t=nowMs();if(t-__last>=1000){report({e:"fps",v:Math.round(__frames*1000/(t-__last)),mode:MODE});__frames=0;__last=t;}requestAnimationFrame(__tick);}requestAnimationFrame(__tick);',
    // ── THE TRANSFORM + GESTURE ENGINE (single mode) ──────────────────────────
    // The frame owns the live {scale,panX,panY} for smoothness, but the shared shell is
    // the source of truth for SYNC: when the host pushes a transform (the streamer's, or
    // a resync) we apply it WITHOUT reporting (follow); when the USER gestures we apply
    // locally AND report it up (→ the shell flips to local takeover). The math mirrors
    // @paxpia/core docViewport EXACTLY (clamp 1..4, centre-origin zoom-at-point, pan
    // bound = (scale-1)*size/2) so a pinch here equals a wheel on web equals the image
    // path — one model, every surface.
    'var MINZ=1,MAXZ=4;',
    'var __vp={s:1,x:0,y:0};var __content=null;',
    'function __ensureContent(){if(!__content)__content=document.getElementById("content");return __content;}',
    'function __cw(){return document.documentElement.clientWidth||window.innerWidth||1;}',
    'function __ch(){return document.documentElement.clientHeight||window.innerHeight||1;}',
    'function __clampZ(z){return Math.min(MAXZ,Math.max(MINZ,z));}',
    'function __bound(s,size){return Math.max(0,((s-1)*size)/2);}',
    // Vertical pan bound from the CONTENT height (the rendered page can be TALLER than the
    // viewport at fit-width, so a tall PDF page must pan vertically even at scale 1 — the old
    // (s-1)*ch/2 bound was 0 at s=1 and snapped every downward drag back to centre). Width is
    // fit-to-frame so the horizontal bound stays (s-1)*cw/2. A board/short page (content==frame)
    // collapses to the same result, so the whiteboard frame is unaffected.
    'function __contentH(){var c=__ensureContent();return c?Math.max(c.scrollHeight||0,c.offsetHeight||0,__ch()):__ch();}',
    'function __clampPan(s,x,y){var bx=__bound(s,__cw());var by=Math.max(0,(__contentH()*s-__ch())/2);return {s:s,x:Math.min(bx,Math.max(-bx,x)),y:Math.min(by,Math.max(-by,y))};}',
    'function __render(){var c=__ensureContent();if(c)c.style.transform="translate("+__vp.x+"px,"+__vp.y+"px) scale("+__vp.s+")";}',
    // apply from the HOST (follow) — no report back.
    'function applyTransform(s,x,y){__vp=__clampPan(__clampZ(s||1),x||0,y||0);__render();}',
    // apply from a local GESTURE — report up so the shell takes over + records it.
    'var __rpt=null;function __reportVp(){if(__rpt)return;__rpt=requestAnimationFrame(function(){__rpt=null;report({e:"tf",s:__vp.s,x:__vp.x,y:__vp.y});});}',
    'function __localVp(v){__vp=v;__render();__reportVp();}',
    // zoom toward a focal point (centre-origin), mirroring docViewport.zoomAtPoint.
    'function __zoomAt(nextRaw,fx,fy){var next=__clampZ(nextRaw);if(next===__vp.s)return;var ratio=next/__vp.s;var cx=__cw()/2,cy=__ch()/2;var nx=fx-cx-(fx-cx-__vp.x)*ratio;var ny=fy-cy-(fy-cy-__vp.y)*ratio;__localVp(__clampPan(next,nx,ny));}',
    scrolled ? '/* scroll mode: native body scroll; no gesture transform */' : (
      // single mode: wire pan-when-zoomed, pinch, double-tap-to-toggle-zoom.
      '(function(){' +
      'var drag=null,pinch=null,lastTap=0,__lastZoom=2.2;' +
      // PAN: start a drag whenever the content overflows the frame on EITHER axis (zoomed in,
      // OR a tall fit-width page at scale 1) — not only when s>1, so a tall PDF pans at fit.
      'document.addEventListener("pointerdown",function(e){if(__vp.s>1||__contentH()>__ch()+1){drag={id:e.pointerId,x:e.clientX,y:e.clientY,ox:__vp.x,oy:__vp.y};}},{passive:true});' +
      'document.addEventListener("pointermove",function(e){if(drag&&e.pointerId===drag.id){var nx=drag.ox+(e.clientX-drag.x),ny=drag.oy+(e.clientY-drag.y);__localVp(__clampPan(__vp.s,nx,ny));}},{passive:true});' +
      // DOUBLE-TAP: at default zoom → restore the LAST non-default zoom (first time: 2.2x); else
      // store the current zoom and return to default. (Was a fixed fit<->2.2 toggle.)
      'document.addEventListener("pointerup",function(e){if(drag&&e.pointerId===drag.id)drag=null;' +
      'var now=nowMs();if(now-lastTap<300){var atDef=__vp.s<=1.01;var r;if(atDef){r=__lastZoom>1.01?__lastZoom:2.2;}else{__lastZoom=__vp.s;r=1;}__zoomAt(r,e.clientX,e.clientY);lastTap=0;}else lastTap=now;},{passive:true});' +
      // touch pinch (two fingers): scale about the midpoint. NON-PASSIVE + preventDefault so
      // Android WebView yields the multi-touch gesture to us (the missing piece — with
      // touch-action:none on the frame this makes pinch-to-zoom actually fire).
      'document.addEventListener("touchmove",function(e){if(e.touches&&e.touches.length===2){if(e.cancelable)e.preventDefault();var a=e.touches[0],b=e.touches[1];var d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);var mx=(a.clientX+b.clientX)/2,my=(a.clientY+b.clientY)/2;if(pinch){__zoomAt(__vp.s*(d/pinch.d),mx,my);}pinch={d:d};}},{passive:false});' +
      'document.addEventListener("touchend",function(e){if(!e.touches||e.touches.length<2)pinch=null;},{passive:true});' +
      // WHEEL = ZOOM, CAPTURED (R5). In single/nav mode a wheel inside the frame zooms about
      // the pointer and is preventDefault-ed so it NEVER propagates out to scroll the host
      // page. (Was ctrl-wheel only, which let a plain wheel bubble/scroll the page.) Scroll
      // mode keeps native scroll (this block is single-mode only).
      'document.addEventListener("wheel",function(e){e.preventDefault();e.stopPropagation();__zoomAt(__vp.s*Math.exp(-e.deltaY*0.0015),e.clientX,e.clientY);},{passive:false});' +
      '})();'
    ),
    '__onSetPage=function(n){};', // filled per kind
    // Per-kind host-message hook (default no-op). The doc frame leaves it; the whiteboard
    // frame (whiteboardHtml.ts) fills it to handle wb.add/wb.del/wb.wipe/wb.set/capture —
    // so the shared __onHost intake below NEVER forks, it just delegates unknown verbs.
    '__onWb=function(m){};',
    // host→frame message intake (RN injects strings via document message; iframe via window message).
    'function __onHost(raw){var d=raw;try{var m=(typeof d==="string")?JSON.parse(d):d;' +
      'if(!m||!m.t)return;' +
      'if(m.t==="tf")applyTransform(m.s,m.x,m.y);' +
      'else if(m.t==="pg")__onSetPage(m.n);' +
      'else __onWb(m);' +
      '}catch(_){}}',
    'document.addEventListener("message",function(ev){__onHost(ev.data);});', // RN (older)
    'window.addEventListener("message",function(ev){__onHost(ev.data);});', // iframe + RN (newer)
    'var __onSetPage,__onWb;',
  ].join('\n');
}

/** Build the pdf.js document for a raw PDF `url`. single mode rasterises one synced
 *  page (re-rasters on host `pg`); scroll mode lazily rasterises all pages in one
 *  scroller (no nested scrollbar). */
function buildPdfHtml(o: BuildDocHtmlOptions): string {
  const libs = o.libs ?? DOC_CDN_LIBS;
  const mode: DocViewMode = o.mode ?? 'single';
  const page1 = Math.max(1, Math.floor((o.page ?? 0) + 1));
  const body = [
    '<div id="stage"><div id="content"><div id="pages"></div></div></div><div id="e"></div>',
    '<script src="' + libs.pdfLib + '"></script>',
    '<script>',
    runtimePreamble(mode),
    'var __pdf=null,__cur=' + page1 + ',__total=' + Math.max(0, o.pageCount ?? 0) + ';',
    'var dpr=window.devicePixelRatio||1;',
    'function vwidth(){return document.documentElement.clientWidth||window.innerWidth||320;}',
    'function vheight(){return document.documentElement.clientHeight||window.innerHeight||480;}',
    // The ONE single-page fit scale, shared with every other renderer that presents a
    // page whole (streaming/docScale.ts). Injected as source because this is a string
    // builder; a unit test evaluates it against the TS function so the two cannot drift.
    FIT_SCALE_TO_FRAME_JS,
    // render page n (1-based) into a canvas at dpr (crisp).
    //  SINGLE — ONE page presented whole, so it fits BOTH axes. Fitting on width alone
    //    left the backing store `vwidth()*dpr*(h/w)` tall with nothing bounding the
    //    right-hand side, so a page whose aspect ratio no frame implies (an A0 poster, a
    //    stitched scan) rasterized past the platform's canvas ceiling — a silently blank
    //    pane, or an OOM-killed renderer, mid-lesson.
    //  SCROLL — pages stack in a scroller, so fit-WIDTH is correct and deliberate:
    //    binding height here would shrink an ordinary A4 until the whole document fitted
    //    on screen, leaving nothing to scroll. Scroll mode's own unbounded growth (it
    //    never releases a rasterized canvas) is a separate defect, tracked separately.
    'function renderOne(n,canvas){return __pdf.getPage(n).then(function(pg){' +
      'var base=pg.getViewport({scale:1});' +
      'var scale=MODE==="single"?' + FIT_SCALE_TO_FRAME_FN + '(base,vwidth(),vheight(),dpr):(vwidth()/base.width)*dpr;' +
      'var vp=pg.getViewport({scale:scale});' +
      'canvas.width=vp.width;canvas.height=vp.height;canvas.style.height=(vp.height/dpr)+"px";' +
      // `.pg` is `width:100%`, which would stretch a height-bound page back across the
      // frame and distort it. An INLINE width wins over the stylesheet and is a no-op for
      // every page that still binds on width (the common case) — it equals 100% there.
      'if(MODE==="single")canvas.style.width=(vp.width/dpr)+"px";' +
      'return pg.render({canvasContext:canvas.getContext("2d"),viewport:vp}).promise;});}',
    'function singleRender(n){var box=document.getElementById("pages");box.innerHTML="";' +
      'var c=document.createElement("canvas");c.className="pg";box.appendChild(c);' +
      'return renderOne(n,c).then(function(){report({e:"page",n:(n-1)});});}',
    // host set-page (single mode): clamp + re-raster crisply.
    '__onSetPage=function(n0){if(MODE!=="single"||!__pdf)return;var n=Math.max(1,Math.min((n0|0)+1,__total||1));if(n===__cur)return;__cur=n;singleRender(n);};',
    'if(!window.pdfjsLib){showErr("Could not load PDF engine");report({e:"err",m:"no-pdf-lib"});}else{',
    'pdfjsLib.GlobalWorkerOptions.workerSrc=' + JSON.stringify(libs.pdfWorker) + ';',
    'pdfjsLib.getDocument(' + JSON.stringify(o.url) + ').promise.then(function(pdf){__pdf=pdf;__total=pdf.numPages;report({e:"pages",n:pdf.numPages});',
    'if(MODE==="single"){var n=Math.max(1,Math.min(__cur,__total));__cur=n;return singleRender(n).then(function(){report({e:"ready"});});}',
    // scroll mode: pre-size each page canvas from page-1 aspect, lazy-raster on intersect.
    'var io=new IntersectionObserver(function(es){es.forEach(function(en){if(!en.isIntersecting)return;var cv=en.target;if(cv.__d)return;cv.__d=true;io.unobserve(cv);renderOne(parseInt(cv.getAttribute("data-p"),10),cv).catch(function(e){report({e:"err",m:"page "+(e&&e.message||e)});});});},{rootMargin:"400px"});',
    'return pdf.getPage(1).then(function(p1){var b=p1.getViewport({scale:1});var aspect=b.height/b.width;var box=document.getElementById("pages");var vw=vwidth();' +
      'for(var i=1;i<=__total;i++){var cv=document.createElement("canvas");cv.className="pg";cv.setAttribute("data-p",i);cv.style.height=(vw*aspect)+"px";box.appendChild(cv);io.observe(cv);}report({e:"ready"});});',
    '}).catch(function(err){showErr("Could not render PDF");report({e:"err",m:"open "+(err&&err.message||err)});});',
    '}',
    '</script></body></html>',
  ].join('\n');
  return frameHead(mode) + body;
}

/** Build the epub.js reader for a raw EPUB `url`. single mode paginates (host pg →
 *  rendition.display(section)); scroll mode is one continuous reader (no nested
 *  scrollbar). */
function buildEpubHtml(o: BuildDocHtmlOptions): string {
  const libs = o.libs ?? DOC_CDN_LIBS;
  const mode: DocViewMode = o.mode ?? 'single';
  const scrolled = mode === 'scroll';
  const body = [
    // EPUB fills the viewport in BOTH modes; epub.js owns the scroll (paginated = one
    // page; CONTINUOUS = the whole book in ONE scroller — fixes "scroll stuck on one
    // chapter"). Override frameHead's pdf-oriented scroll so the body never double-scrolls.
    // SUPPRESS TEXT SELECTION (drag-to-scroll must not start a selection) + HIDE the native
    // scrollbar (the non-intrusive overlay bar replaces it; no layout shift / double bar).
    '<style>html,body{height:100%;overflow:hidden;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;}' +
      '#stage{position:fixed;inset:0;overflow:hidden;}#content{height:100%;}#area{height:100%;user-select:none;}' +
      '#area,#area *{scrollbar-width:none;-ms-overflow-style:none;}#area::-webkit-scrollbar,#area *::-webkit-scrollbar{width:0;height:0;display:none;}' +
      (scrolled ? '#area{cursor:grab;}#area.dragging{cursor:grabbing;}' : '') +
      '#sb{position:fixed;top:2px;right:2px;bottom:2px;width:4px;border-radius:4px;pointer-events:none;z-index:9;opacity:0;transition:opacity .25s;}#sb.on{opacity:1;}' +
      '#sbt{position:absolute;left:0;right:0;border-radius:4px;background:rgba(255,255,255,0.32);min-height:24px;}</style>',
    '<div id="stage"><div id="content"><div id="area"></div></div></div><div id="sb"><div id="sbt"></div></div><div id="e"></div>',
    '<script src="' + libs.jszip + '"></script>',
    '<script src="' + libs.epubjs + '"></script>',
    '<script>',
    runtimePreamble(mode),
    'var __book=null,__rend=null,__total=0,__lastIdx=0,SCROLLED=' + (scrolled ? 'true' : 'false') + ';',
    '__onSetPage=function(n0){if(!__rend||!__book)return;try{var spine=__book.spine;if(spine&&spine.get){var it=spine.get(n0|0);if(it){__lastIdx=n0|0;__rend.display(it.href);}}}catch(_){}};',
    'if(!window.ePub){showErr("Could not load EPUB engine");report({e:"err",m:"no-epub-lib"});}else{try{',
    'var book=ePub(' + JSON.stringify(o.url) + ');__book=book;',
    'var rendition=book.renderTo("area",{width:"100%",height:"100%",flow:' + (scrolled ? '"scrolled"' : '"paginated"') + ',manager:' + (scrolled ? '"continuous"' : '"default"') + ',spread:"none"});__rend=rendition;',
    // No-select also INSIDE each section iframe (epub content lives in nested iframes).
    'rendition.themes.default({"body":{"background":"#0b0e16","color":"#e8e8ef","padding":"0 14px","user-select":"none","-webkit-user-select":"none"}});',
    'rendition.display().then(function(){report({e:"ready"});});',
    'book.ready.then(function(){var n=(book.spine&&book.spine.spineItems&&book.spine.spineItems.length)||(book.spine&&book.spine.length)||(book.packaging&&book.packaging.spine&&book.packaging.spine.length)||1;__total=n;report({e:"pages",n:n});}).catch(function(){showErr("Could not open EPUB");report({e:"err",m:"not-ready"});});',
    'rendition.on("relocated",function(loc){try{__lastIdx=(loc&&loc.start&&loc.start.index!=null?loc.start.index:0);report({e:"page",n:__lastIdx});}catch(_){}});',
    // ── scroll-position sync + non-intrusive overlay scrollbar + drag-to-scroll (scroll mode) ──
    'function __scroller(){var a=document.getElementById("area");if(!a)return null;var c=a.querySelector(".epub-container")||a.firstElementChild||a;if(c&&c.scrollHeight>c.clientHeight+2)return c;if(a.scrollHeight>a.clientHeight+2)return a;return c||a;}',
    'var __sb=document.getElementById("sb"),__sbt=document.getElementById("sbt");',
    'function __paintBar(sc){if(!SCROLLED||!sc||!__sb||!__sbt)return;var sh=sc.scrollHeight,ch=sc.clientHeight;if(sh<=ch+2){__sb.classList.remove("on");return;}__sb.classList.add("on");var th=__sb.clientHeight,thumb=Math.max(24,Math.round(th*ch/sh)),mt=th-thumb,top=Math.round((sc.scrollTop/(sh-ch))*mt);__sbt.style.height=thumb+"px";__sbt.style.top=top+"px";}',
    'var __sr=null;function __reportPos(){__sr=null;var sc=__scroller();if(!sc)return;__paintBar(sc);var sh=sc.scrollHeight,ch=sc.clientHeight,frac=sh>ch?(sc.scrollTop/(sh-ch)):0;report({e:"page",n:__lastIdx,frac:Math.round(frac*1000)/1000});}',
    'function __onScroll(){if(__sr)return;__sr=requestAnimationFrame(__reportPos);}',
    'function __wireScroll(){var sc=__scroller();if(sc){sc.addEventListener("scroll",__onScroll,{passive:true});__paintBar(sc);}}',
    'if(SCROLLED){rendition.on("rendered",function(){try{__wireScroll();}catch(_){}});var __t=0,__iv=setInterval(function(){__wireScroll();if(++__t>12)clearInterval(__iv);},400);' +
      'var __area=document.getElementById("area"),__drag=null;' +
      '__area.addEventListener("pointerdown",function(e){var sc=__scroller();if(!sc)return;__drag={id:e.pointerId,y:e.clientY,top:sc.scrollTop,sc:sc};__area.classList.add("dragging");try{__area.setPointerCapture(e.pointerId);}catch(_){}});' +
      '__area.addEventListener("pointermove",function(e){if(!__drag||e.pointerId!==__drag.id)return;__drag.sc.scrollTop=__drag.top-(e.clientY-__drag.y);__onScroll();});' +
      'function __ed(e){if(__drag&&(!e||e.pointerId===__drag.id)){__drag=null;__area.classList.remove("dragging");}}__area.addEventListener("pointerup",__ed);__area.addEventListener("pointercancel",__ed);__area.addEventListener("pointerleave",__ed);}',
    // host pos:<i> <frac> → scroll to a synced position (scroll mode follow).
    '__onWb=function(m){if(m&&m.t==="pos"){__lastIdx=m.i|0;try{var sp=__book.spine,it=sp&&sp.get&&sp.get(m.i|0);if(it&&__rend)__rend.display(it.href!=null?it.href:m.i);}catch(_){}setTimeout(function(){var sc=__scroller();if(sc){var sh=sc.scrollHeight,ch=sc.clientHeight;if(sh>ch)sc.scrollTop=Math.round((m.f||0)*(sh-ch));__paintBar(sc);}},120);}};',
    '}catch(err){showErr("Could not open EPUB");report({e:"err",m:"open "+(err&&err.message||err)});}}',
    '</script></body></html>',
  ].join('\n');
  return frameHead(mode) + body;
}

/** Build the self-contained doc HTML for the given options. The single entry the
 *  platform hosts (web iframe, mobile WebView) call. */
export function buildDocHtml(o: BuildDocHtmlOptions): string {
  return o.kind === 'epub' ? buildEpubHtml(o) : buildPdfHtml(o);
}
