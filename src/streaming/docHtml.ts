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

/** A decoded frame→host event. */
export type DocFrameReport =
  | { e: 'ready' }
  | { e: 'pages'; n: number }
  | { e: 'page'; n: number }
  | { e: 'interact' }
  // A LOCAL in-frame gesture produced this transform → the shell records it as the
  // viewport and (on a viewer) flips to local takeover (the personal-streamer focus).
  | { e: 'tf'; s: number; x: number; y: number }
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
function frameHead(mode: DocViewMode): string {
  const scrolled = mode === 'scroll';
  return (
    '<!doctype html><html><head>' +
    '<meta charset="utf-8">' +
    // user-scalable=no: the SHARED transform owns zoom; native pinch is disabled so the
    // gesture layer is the single source of truth (web↔mobile parity).
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">' +
    '<style>' +
    'html,body{margin:0;padding:0;background:#0b0e16;color:#e8e8ef;}' +
    'html,body{height:' + (scrolled ? 'auto' : '100%') + ';overflow:' + (scrolled ? 'auto' : 'hidden') + ';}' +
    // #stage = the fixed viewport (single mode). #content = the transformed layer.
    '#stage{position:' + (scrolled ? 'static' : 'fixed') + ';inset:0;overflow:hidden;}' +
    '#content{transform-origin:center center;will-change:transform;width:100%;' + (scrolled ? '' : 'height:100%;') + '}' +
    '.pg{display:block;width:100%;margin:0 auto ' + (scrolled ? '8px' : '0') + ';background:#0b0e16;}' +
    '#e{position:fixed;inset:0;display:none;align-items:center;justify-content:center;color:#9aa;font:13px sans-serif;padding:16px;text-align:center;}' +
    '</style></head><body>'
  );
}

// The shared runtime preamble: report bridge + perf probe + host→frame intake +
// transform application. `applyTransform` is the doc-kind-agnostic CSS apply; the page
// hook (`__onSetPage`) is filled in per kind below.
function runtimePreamble(mode: DocViewMode): string {
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
    'function __clampPan(s,x,y){var bx=__bound(s,__cw()),by=__bound(s,__ch());return {s:s,x:Math.min(bx,Math.max(-bx,x)),y:Math.min(by,Math.max(-by,y))};}',
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
      'var drag=null,pinch=null,lastTap=0;' +
      'function pt(e){return {x:e.clientX,y:e.clientY};}' +
      'document.addEventListener("pointerdown",function(e){if(__vp.s>1){drag={id:e.pointerId,x:e.clientX,y:e.clientY,ox:__vp.x,oy:__vp.y};}},{passive:true});' +
      'document.addEventListener("pointermove",function(e){if(drag&&e.pointerId===drag.id){var nx=drag.ox+(e.clientX-drag.x),ny=drag.oy+(e.clientY-drag.y);__localVp(__clampPan(__vp.s,nx,ny));}},{passive:true});' +
      'document.addEventListener("pointerup",function(e){if(drag&&e.pointerId===drag.id)drag=null;' +
      'var now=nowMs();if(now-lastTap<300){var r=__vp.s>1.01?1:2.2;__zoomAt(r,e.clientX,e.clientY);lastTap=0;}else lastTap=now;},{passive:true});' +
      // touch pinch (two fingers): scale about the midpoint.
      'document.addEventListener("touchmove",function(e){if(e.touches&&e.touches.length===2){var a=e.touches[0],b=e.touches[1];var d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);var mx=(a.clientX+b.clientX)/2,my=(a.clientY+b.clientY)/2;if(pinch){__zoomAt(__vp.s*(d/pinch.d),mx,my);}pinch={d:d};}},{passive:true});' +
      'document.addEventListener("touchend",function(e){if(!e.touches||e.touches.length<2)pinch=null;},{passive:true});' +
      // trackpad/ctrl-wheel zoom (web parity).
      'document.addEventListener("wheel",function(e){if(e.ctrlKey){e.preventDefault();__zoomAt(__vp.s*Math.exp(-e.deltaY*0.0015),e.clientX,e.clientY);}},{passive:false});' +
      '})();'
    ),
    '__onSetPage=function(n){};', // filled per kind
    // host→frame message intake (RN injects strings via document message; iframe via window message).
    'function __onHost(raw){var d=raw;try{var m=(typeof d==="string")?JSON.parse(d):d;' +
      'if(!m||!m.t)return;' +
      'if(m.t==="tf")applyTransform(m.s,m.x,m.y);' +
      'else if(m.t==="pg")__onSetPage(m.n);' +
      '}catch(_){}}',
    'document.addEventListener("message",function(ev){__onHost(ev.data);});', // RN (older)
    'window.addEventListener("message",function(ev){__onHost(ev.data);});', // iframe + RN (newer)
    'var __onSetPage;',
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
    // render page n (1-based) into a canvas at fit-width * dpr (crisp).
    'function renderOne(n,canvas){return __pdf.getPage(n).then(function(pg){' +
      'var base=pg.getViewport({scale:1});var scale=(vwidth()/base.width)*dpr;var vp=pg.getViewport({scale:scale});' +
      'canvas.width=vp.width;canvas.height=vp.height;canvas.style.height=(vp.height/dpr)+"px";' +
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
    '<style>html,body{height:100%;overflow:hidden;}#stage{position:fixed;inset:0;overflow:hidden;}#content{height:100%;}#area{height:100%;}</style>',
    '<div id="stage"><div id="content"><div id="area"></div></div></div><div id="e"></div>',
    '<script src="' + libs.jszip + '"></script>',
    '<script src="' + libs.epubjs + '"></script>',
    '<script>',
    runtimePreamble(mode),
    'var __book=null,__rend=null,__total=0;',
    '__onSetPage=function(n0){if(!__rend||!__book)return;try{var spine=__book.spine;if(spine&&spine.get){var it=spine.get(n0|0);if(it)__rend.display(it.href);}}catch(_){}};',
    'if(!window.ePub){showErr("Could not load EPUB engine");report({e:"err",m:"no-epub-lib"});}else{try{',
    'var book=ePub(' + JSON.stringify(o.url) + ');__book=book;',
    'var rendition=book.renderTo("area",{width:"100%",height:"100%",flow:' + (scrolled ? '"scrolled"' : '"paginated"') + ',manager:' + (scrolled ? '"continuous"' : '"default"') + ',spread:"none"});__rend=rendition;',
    'rendition.themes.default({"body":{"background":"#0b0e16","color":"#e8e8ef","padding":"0 14px"}});',
    'rendition.display().then(function(){report({e:"ready"});});',
    'book.ready.then(function(){var n=(book.spine&&book.spine.length)||(book.packaging&&book.packaging.spine&&book.packaging.spine.length)||1;__total=n;report({e:"pages",n:n});}).catch(function(){showErr("Could not open EPUB");report({e:"err",m:"not-ready"});});',
    'rendition.on("relocated",function(loc){try{report({e:"page",n:(loc&&loc.start&&loc.start.index!=null?loc.start.index:0)});}catch(_){}});',
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
