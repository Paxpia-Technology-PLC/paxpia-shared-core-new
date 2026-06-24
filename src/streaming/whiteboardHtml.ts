// whiteboardHtml — the ONE shared synced-WHITEBOARD renderer, the sibling of
// streaming/docHtml.ts. A single self-contained HTML document that hosts a live
// <svg> board inside a WebView so strokes are appended to a LIVE DOM node and
// composited NATIVELY (no RN re-render per stroke — this kills the inline-SVG ~5fps
// problem the old `LiveWhiteboardOverlay` had). Hosted IDENTICALLY on both platforms:
// web injects it into an <iframe srcdoc>, mobile into a react-native-webview. Same
// HTML ⇒ byte-identical board on every front.
//
// ── REUSE, DON'T FORK ─────────────────────────────────────────────────────────
// It reuses docHtml.ts's `frameHead` + `runtimePreamble` VERBATIM (imported, not
// copied), so the pan/zoom math, the local-gesture→{e:'tf'} report, the host-follow
// `applyTransform`, the report()/`__onHost` bridge and the `DOC_FRAME_MSG_PREFIX`
// (→ the same `parseDocFrameMsg` host code) are LITERALLY the same file as the doc
// engine. This gives the whiteboard the doc PERSONAL-STREAMER transform / takeover
// model for FREE — a viewer can pan/zoom/focus their own view and resync exactly as
// they do for a PDF, because it renders through the same frame.
//
// The whiteboard adds only a thin shim AFTER the shared preamble (filled into the
// preamble's per-kind `__onWb` hook):
//
//   host → frame (JSON):  {t:'tf',s,x,y}        set transform (live)          — REUSED
//                         {t:'wb.add', stroke}  append one stroke to the DOM
//                         {t:'wb.del', id}      remove a stroke
//                         {t:'wb.wipe'}         clear
//                         {t:'wb.set', strokes} replace (snapshot)
//                         {t:'capture'}         content-only screenshot request
//   frame → host (`pxdoc:` + JSON):
//                         {e:'tf',s,x,y}        local gesture transform → takeover — REUSED
//                         {e:'wb.draw', stroke} editable mode only: a finished local stroke
//                         {e:'capture', dataUrl} content-only PNG (chrome-free by construction)
//                         {e:'ready'|'fps'|'err'}                               — REUSED
//
// PURE string builder — no DOM, no RN, no fetch. The host component (web iframe /
// mobile WebView) owns the wiring; this only describes the document.

import { frameHead, runtimePreamble } from './docHtml';
import type { WbStroke } from '../overlays/whiteboard';

export interface BuildWhiteboardHtmlOptions {
  /** The fixed authoring/render space (publisher coords). Mirrors WhiteboardPayload.canvas. */
  canvas: { w: number; h: number };
  /** Optional background (presigned image/PDF-page url) the board is drawn over. Load it
   *  through the host's same-origin baseUrl plumbing or `{e:'capture'}` will taint. */
  backgroundUrl?: string;
  /** Snapshot baked into the first paint (a late joiner converges without a round-trip). */
  initialStrokes?: WbStroke[];
  /** Streamer/dash AUTHOR mode: capture pointer → emit {e:'wb.draw'}. Viewers omit it. */
  editable?: boolean;
  /** Operator pen colour the authoring frame starts with (the chrome's active swatch). The
   *  shell rebuilds the frame on change, so a swatch click → this default → the NEXT stroke
   *  carries it. Defaults to white. Operator-only (a viewer frame has no pen). */
  penColor?: string;
  /** Operator pen width the authoring frame starts with (the chrome's active width). Same
   *  rebuild-on-change discipline as penColor. Defaults to 4. */
  penWidth?: number;
  /** TRANSPARENT background (the operator's "show what's underneath" toggle): when true the
   *  page + board background become alpha-0 so the underlying scene sources (camera/screen/
   *  etc.) composite through, and the content-only screenshot is filled with transparent
   *  pixels instead of the opaque ink fill. Strokes (and any backgroundUrl image) stay fully
   *  visible either way — only the EMPTY canvas is made see-through. Default = opaque (the
   *  shared `frameHead` ink fill). */
  transparent?: boolean;
  /** ALWAYS-DRAW (annotation-over-doc): when true a pointer-down ALWAYS starts a stroke, even
   *  when zoomed — because for a doc annotation the DOC owns pan/zoom (the annotation just
   *  draws on top), so the normal "pan when zoomed instead of draw" priority is wrong here.
   *  Default false (the placed-whiteboard keeps draw-when-fit / pan-when-zoomed). */
  alwaysDraw?: boolean;
}

/** Build the self-contained whiteboard HTML. The single entry the platform hosts (web
 *  iframe, mobile WebView) call — sibling to buildDocHtml. */
export function buildWhiteboardHtml(o: BuildWhiteboardHtmlOptions): string {
  const w = o.canvas?.w && o.canvas.w > 0 ? o.canvas.w : 1000;
  const h = o.canvas?.h && o.canvas.h > 0 ? o.canvas.h : 1000;
  const editable = !!o.editable;
  const transparent = !!o.transparent;
  const alwaysDraw = !!o.alwaysDraw;
  const penColor = typeof o.penColor === 'string' && o.penColor ? o.penColor : '#ffffff';
  const penWidth = typeof o.penWidth === 'number' && o.penWidth > 0 ? o.penWidth : 4;
  const initial = Array.isArray(o.initialStrokes) ? o.initialStrokes : [];

  // The transparent toggle is a thin CSS OVERRIDE appended AFTER the shared frameHead (whose
  // `html,body{background:#0b0e16}` is the opaque default). When transparent we null out the
  // page + stage + content fills so the host surface (and whatever scene source sits under the
  // composited board) shows through; the strokes <g> + any backgroundUrl <image> are unaffected,
  // so the drawing itself never goes invisible. This lives in whiteboardHtml.ts (not frameHead)
  // so the doc engine's opaque page is untouched — only the board opts into see-through.
  const bgOverride = transparent
    ? '<style>html,body{background:transparent !important;}#stage,#content{background:transparent !important;}</style>'
    : '';

  // The board lives inside #content (the SAME node frameHead/runtimePreamble transform).
  // An <svg> that FILLS #content (Bug 4 fit-to-rect): instead of a fixed SQUARE viewBox
  // letterboxed by `meet`, the viewBox is recomputed at runtime (`__fitBoard`) to the
  // MEASURED container aspect with the WB_W×WB_H canvas centred — so the drawing surface
  // takes up ALL the vertical+horizontal space of any rect, while strokes keep true
  // proportions (no stretch). `crossorigin` on the background lets the capture canvas stay
  // un-tainted for a CORS-clean bg (Bug 3). Background (if any) is an <image> inside the
  // SVG so it composites into the screenshot with no chrome.
  const bg = o.backgroundUrl
    ? '<image id="wbbg" x="0" y="0" width="' + w + '" height="' + h +
      '" href="' + escapeAttr(o.backgroundUrl) + '" crossorigin="anonymous" preserveAspectRatio="xMidYMid meet"></image>'
    : '';

  const body = [
    // The transparent-background override (empty unless the operator toggled it on) sits
    // FIRST so it wins over frameHead's opaque page fill.
    bgOverride,
    // #board fills #content; the viewBox is set to the container aspect by __fitBoard so the
    // board fills its rect at ANY aspect (Bug 4). The initial viewBox is the bare canvas; it
    // is replaced on ready + resize. preserveAspectRatio="none" is safe once the viewBox
    // matches the container aspect (no distortion), and lets the fit be exact.
    '<div id="stage"><div id="content">' +
      '<svg id="board" width="100%" height="100%" viewBox="0 0 ' + w + ' ' + h + '" ' +
      'preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
      bg + '<g id="strokes"></g></svg>' +
      '</div></div><div id="e"></div>',
    '<script>',
    // The shared transform/gesture/report engine — single mode, VERBATIM from docHtml.ts.
    runtimePreamble('single'),
    // ── whiteboard config baked into first paint ──────────────────────────────
    'var WB_W=' + w + ',WB_H=' + h + ',WB_EDIT=' + JSON.stringify(editable) + ',WB_TRANSPARENT=' + JSON.stringify(transparent) + ';',
    'var __strokes=' + safeJson(initial) + ';',
    'var SVGNS="http://www.w3.org/2000/svg";',
    // ── Bug 4: FILL-TO-RECT. Recompute the board's viewBox to the MEASURED container
    // aspect with the WB_W×WB_H canvas centred, so the board fills ALL the rect (no
    // letterbox under the controls) while strokes keep true proportions. Re-run on
    // ready + every resize. (`__bw`/`__bh` cache the live viewBox the capture reads.)
    'var __bw=WB_W,__bh=WB_H,__bx=0,__by=0;',
    'function __fitBoard(){var svg=document.getElementById("board");if(!svg)return;' +
      'var cw=__cw(),ch=__ch();if(cw<=0||ch<=0)return;var car=cw/ch,bar=WB_W/WB_H;' +
      'var vw,vh;if(car>=bar){vw=WB_H*car;vh=WB_H;}else{vw=WB_W;vh=WB_W/car;}' +
      'var vx=(WB_W-vw)/2,vy=(WB_H-vh)/2;__bw=vw;__bh=vh;__bx=vx;__by=vy;' +
      'svg.setAttribute("viewBox",vx+" "+vy+" "+vw+" "+vh);}' +
      '',
    'window.addEventListener("resize",function(){__fitBoard();__render();});',
    // ── Bug 5: LOSSLESS ZOOM. Override the shared __render so a zoom RE-RASTERISES the
    // vector SVG at the zoomed device size instead of CSS-scaling a baked raster layer
    // (which the GPU upscales → pixelation). We size #content to container*scale px so the
    // browser re-tessellates the strokes at that resolution, and apply PAN as a translate
    // only (no scale() → no raster upscale). __vp/__clampPan still own the gesture math —
    // only the APPLICATION changes, so the doc/PDF path (which keeps the preamble __render)
    // is untouched. (__render is a hoisted fn binding; reassigning it here rebinds every
    // caller — applyTransform/__localVp — to the lossless version.)
    '__render=function(){var c=__ensureContent();if(!c)return;var cw=__cw(),ch=__ch(),s=__vp.s||1;' +
      'c.style.width=(cw*s)+"px";c.style.height=(ch*s)+"px";' +
      // centre the (scaled-up) content in the stage, then pan; no CSS scale ⇒ vectors
      // re-rasterise at the new pixel size (lossless), not a stretched bitmap.
      'var ox=((cw-cw*s)/2)+(__vp.x||0),oy=((ch-ch*s)/2)+(__vp.y||0);' +
      'c.style.transform="translate("+ox+"px,"+oy+"px)";};',
    'function __gel(){return document.getElementById("strokes");}',
    // append ONE stroke <path> to the LIVE svg DOM (native composite, no re-render).
    'function __paint(s){if(!s||!s.id)return;var g=__gel();if(!g)return;' +
      'if(g.querySelector(\'[data-id="\'+__cssEsc(s.id)+\'"]\'))return;' +
      'var p=document.createElementNS(SVGNS,"path");p.setAttribute("data-id",s.id);' +
      'p.setAttribute("d",s.d||"");p.setAttribute("stroke",s.color||"#fff");' +
      'p.setAttribute("stroke-width",String(s.width||3));p.setAttribute("fill","none");' +
      'p.setAttribute("stroke-linecap","round");p.setAttribute("stroke-linejoin","round");' +
      'g.appendChild(p);}',
    'function __cssEsc(v){return String(v).replace(/["\\\\]/g,"\\\\$&");}',
    'function __delStroke(id){var g=__gel();if(!g)return;var n=g.querySelector(\'[data-id="\'+__cssEsc(id)+\'"]\');if(n)g.removeChild(n);}',
    'function __wipe(){var g=__gel();if(g)while(g.firstChild)g.removeChild(g.firstChild);}',
    'function __setAll(list){__wipe();__strokes=list||[];for(var i=0;i<__strokes.length;i++)__paint(__strokes[i]);}',
    // ── host→frame whiteboard verbs (fills the preamble per-kind hook) ─────────
    '__onWb=function(m){' +
      'if(m.t==="wb.add"){if(m.stroke){__strokes.push(m.stroke);__paint(m.stroke);}}' +
      'else if(m.t==="wb.del"){if(m.id!=null){__strokes=__strokes.filter(function(s){return s.id!==m.id;});__delStroke(m.id);}}' +
      'else if(m.t==="wb.wipe"){__strokes=[];__wipe();}' +
      'else if(m.t==="wb.set"){__setAll(m.strokes||[]);}' +
      'else if(m.t==="capture"){__capture();}' +
      '};',
    // ── content-only screenshot: serialise #board svg → offscreen canvas → PNG ──
    // Chrome lives OUTSIDE the frame (RN/React tree), so the frame's DOM is content-only
    // by construction — the result can't leak the resync banner / zoom buttons / chat.
    // Bug 3 robustness: (1) capture at the LIVE viewBox aspect (not the square canvas) so
    // it matches what's shown; (2) if `toDataURL` throws a SecurityError because a
    // cross-origin background tainted the canvas, RETRY without the background <image> so
    // the strokes still save — capture never hard-fails on a tainted bg.
    'function __serialize(svg){return new XMLSerializer().serializeToString(svg);}',
    'function __rasterize(xml,cw,ch,done,fail){var img=new Image();var cv=document.createElement("canvas");' +
      'cv.width=Math.max(1,Math.round(cw));cv.height=Math.max(1,Math.round(ch));' +
      'img.onload=function(){try{var ctx=cv.getContext("2d");if(!WB_TRANSPARENT){ctx.fillStyle="#0b0e16";ctx.fillRect(0,0,cv.width,cv.height);}else{ctx.clearRect(0,0,cv.width,cv.height);}' +
      'ctx.drawImage(img,0,0,cv.width,cv.height);done(cv.toDataURL("image/png"));}' +
      'catch(err){fail(err);}};' +
      'img.onerror=function(){fail(new Error("capture-img"));};' +
      'img.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(xml);}',
    'function __capture(){try{var svg=document.getElementById("board");if(!svg){report({e:"err",m:"no-board"});return;}' +
      // Render at the live viewBox aspect (Bug 4 fit), capped so a deep zoom-out can\'t make a huge bitmap.
      'var ar=(__bw>0&&__bh>0)?(__bw/__bh):(WB_W/WB_H);var cw=WB_W,ch=Math.max(1,Math.round(WB_W/ar));' +
      'var xml=__serialize(svg);' +
      '__rasterize(xml,cw,ch,function(d){report({e:"capture",dataUrl:d});},function(){' +
      // Tainted by a cross-origin bg (or bg decode failed) → drop the <image> and re-capture
      // strokes-only so the save still works on plain-http LAN dev (Bug 3, no secure ctx needed).
      'try{var clone=svg.cloneNode(true);var bgn=clone.querySelector("#wbbg");if(bgn&&bgn.parentNode)bgn.parentNode.removeChild(bgn);' +
      '__rasterize(__serialize(clone),cw,ch,function(d){report({e:"capture",dataUrl:d});},function(err2){report({e:"err",m:"capture "+(err2&&err2.message||err2)});});}' +
      'catch(err3){report({e:"err",m:"capture "+(err3&&err3.message||err3)});}});' +
      '}catch(err){report({e:"err",m:"capture "+(err&&err.message||err)});}}',
    // ── editable (author) mode: pointer → finished local stroke → {e:'wb.draw'} ──
    // Capture in CANVAS coords (svg.getScreenCTM inverse) so the d is render-agnostic and
    // every front replays it identically. We DON'T paint locally on pointerup — the host
    // echoes the stroke back via {t:'wb.add'} after it broadcasts, so author + viewers
    // share one paint path (no double-draw). A live preview path is shown while drawing.
    WB_EDIT(editable, penColor, penWidth, alwaysDraw),
    // ── bake the initial snapshot (late joiner) ───────────────────────────────
    'for(var __i=0;__i<__strokes.length;__i++)__paint(__strokes[__i]);',
    // Fit the board to the rect (Bug 4) + apply the lossless render (Bug 5) before ready.
    '__fitBoard();__render();',
    'report({e:"ready"});',
    '</script></body></html>',
  ].join('\n');

  return frameHead('single') + body;
}

// The editable-author capture shim, emitted only when editable. Pointer down/move builds
// an SVG path `d` in canvas coords; pointer up emits the finished stroke up to the host
// (which broadcasts it, then echoes wb.add back so it paints). Gated behind WB_EDIT so a
// viewer frame ships zero authoring code. When zoomed (transform owns pan), drawing is
// suppressed in favour of pan — mirrors the doc gesture priority.
function WB_EDIT(editable: boolean, penColor: string, penWidth: number, alwaysDraw: boolean): string {
  if (!editable) return '/* viewer / nav mode: no authoring capture */';
  return [
    '(function(){',
    'var svg=document.getElementById("board");var cur=null,curD="",prev=document.createElementNS(SVGNS,"path");',
    'var ALWAYS_DRAW=' + JSON.stringify(alwaysDraw) + ';',
    'prev.setAttribute("fill","none");prev.setAttribute("stroke-linecap","round");prev.setAttribute("stroke-linejoin","round");',
    // Pen colour/width seed from the chrome's active swatch/width (rebuilt-on-change), and
    // can still be live-set by the host via window.__wbSetColor/__wbSetWidth if wired.
    'var COLOR=' + safeJson(penColor) + ',WIDTH=' + JSON.stringify(penWidth) + ';',
    'window.__wbSetColor=function(c){COLOR=c;};window.__wbSetWidth=function(w){WIDTH=w;};',
    // screen px → canvas coords via the svg CTM (accounts for the fit + the CSS transform).
    'function toCanvas(cx,cy){try{var ctm=svg.getScreenCTM();if(!ctm)return null;var pt=svg.createSVGPoint();pt.x=cx;pt.y=cy;var p=pt.matrixTransform(ctm.inverse());return {x:p.x,y:p.y};}catch(_){return null;}}',
    'function fmt(n){return Math.round(n*100)/100;}',
    // Draw-when-fit / pan-when-zoomed for the placed board; ALWAYS draw for an annotation
    // (the doc owns zoom, so a stroke must start regardless of the annotation\'s scale).
    // DRAW-vs-PAN (#bug): once we commit to a stroke, OWN the gesture — stopPropagation
    // so the SHARED preamble's document-level pan handler (which grabs on pointerdown when
    // __vp.s>1) does NOT also fire and translate the content. Without this, a draw while
    // zoomed in DRAW mode both drew AND panned (pan dominated → "draw just pans"). The
    // guard above already lets a pan through when NOT drawing (zoomed placed-board nav), so
    // pan-when-intended still works; we only seize the pointer when a stroke actually starts.
    'svg.addEventListener("pointerdown",function(e){if(!ALWAYS_DRAW&&__vp.s>1.01)return;var p=toCanvas(e.clientX,e.clientY);if(!p)return;e.stopPropagation();cur=e.pointerId;curD="M"+fmt(p.x)+" "+fmt(p.y);prev.setAttribute("d",curD);prev.setAttribute("stroke",COLOR);prev.setAttribute("stroke-width",String(WIDTH));__gel().appendChild(prev);},{passive:true});',
    'svg.addEventListener("pointermove",function(e){if(cur===null||e.pointerId!==cur)return;var p=toCanvas(e.clientX,e.clientY);if(!p)return;curD+=" L"+fmt(p.x)+" "+fmt(p.y);prev.setAttribute("d",curD);},{passive:true});',
    'function finish(){if(cur===null)return;cur=null;try{if(prev.parentNode)prev.parentNode.removeChild(prev);}catch(_){}if(curD.indexOf("L")<0){curD="";return;}var stroke={id:"s"+Date.now()+"_"+Math.floor(Math.random()*1e6),d:curD,color:COLOR,width:WIDTH};curD="";report({e:"wb.draw",stroke:stroke});}',
    'svg.addEventListener("pointerup",finish,{passive:true});',
    'svg.addEventListener("pointercancel",finish,{passive:true});',
    'svg.addEventListener("pointerleave",finish,{passive:true});',
    '})();',
  ].join('\n');
}

/** JSON for embedding in the script (escape `<` so a stroke `d` can't break out of the
 *  <script>). Mirrors the doc engine's JSON.stringify-into-script discipline. */
function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

/** Escape a value for an HTML attribute (the backgroundUrl in the SVG <image href>). */
function escapeAttr(v: string): string {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
