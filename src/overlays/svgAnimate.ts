// SMIL ANIMATION BAKER (mobile parity) — a platform-agnostic, DOM-free function
// that takes a SANITIZED SVG string + an elapsed time and returns a NEW SVG string
// with every SMIL <animate>/<animateTransform> BAKED into a static value on its
// target element at that instant, and the <animate*> tags removed.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Web renders SMIL natively (the browser animates <animate*> over time). React
// Native's react-native-svg <SvgXml> parser has NO mapping for animate /
// animateTransform / animateMotion / set — those tags fall through to a
// missing-tag renderer and paint NOTHING, so an SVG overlay that web animates is
// STATIC (or "scene-flips") on mobile. To reach parity WITHOUT a native change,
// the mobile renderer ticks this baker on every frame: each tick re-derives the
// current attribute/transform values from the animation timing and rewrites the
// SVG, so re-rendering the baked string advances the animation in JS.
//
// SCOPE: the common overlay surface — <animate> on a numeric/length/color/opacity
// attribute, and <animateTransform type="translate|scale|rotate"> — with `dur`,
// `begin`, `repeatCount` (number | "indefinite"), `values`(;-list) | `from`/`to`,
// and linear `calcMode` (the default). Unhandled forms are dropped gracefully
// (the element keeps its authored static attributes). PURE + Hermes-safe (no DOM,
// no URL ctor); the platform supplies `nowMs` (an animation clock).
//
// INTERPOLATION FIDELITY: keyframe values are interpolated CONTINUOUSLY, not just
// the plain numbers the first cut handled. `lerpValue` now covers a plain number
// (opacity / stroke-dashoffset draw-ons), a multi-number tuple (translate / scale /
// viewBox), a COLOR (fill / stroke / stop-color — per-channel RGBA), and a path-`d`
// MORPH between two paths that share the same command skeleton. This is what makes
// the animated lines/draw-ons that web renders natively actually appear on mobile
// instead of snapping at the segment midpoint.

/** Parse an SVG clock value (`dur`, `begin`) → milliseconds. Supports `1.5s`,
 *  `250ms`, a bare number (seconds), and `00:00:02` (h:m:s) loosely. Returns 0 for
 *  an empty/`indefinite`/unparseable value. */
export function parseClockMs(v: string | undefined): number {
  if (!v) return 0;
  const s = v.trim().toLowerCase();
  if (s === '' || s === 'indefinite') return 0;
  if (s.endsWith('ms')) {
    const n = parseFloat(s.slice(0, -2));
    return Number.isFinite(n) ? n : 0;
  }
  if (s.endsWith('s')) {
    const n = parseFloat(s.slice(0, -1));
    return Number.isFinite(n) ? n * 1000 : 0;
  }
  if (s.includes(':')) {
    const parts = s.split(':').map((p) => parseFloat(p));
    if (parts.some((p) => !Number.isFinite(p))) return 0;
    let ms = 0;
    for (const p of parts) ms = ms * 60 + p;
    return ms * 1000;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n * 1000 : 0; // bare number = seconds (SVG default)
}

/** One parsed <animate*> directive (already extracted from the SVG string). */
interface Anim {
  /** 'attr' (<animate>) or 'transform' (<animateTransform>). */
  mode: 'attr' | 'transform';
  attributeName?: string;
  /** transform type for animateTransform. */
  transformType?: 'translate' | 'scale' | 'rotate';
  durMs: number;
  beginMs: number;
  /** -1 ⇒ indefinite (loop forever); else the repeat count. */
  repeat: number;
  /** Keyframe stops (already split). At least 2 entries when present. */
  values: string[];
}

/** Read one attribute's value out of a start-tag attribute string (quoted). */
function attr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(attrs);
  if (!m) return undefined;
  return m[2] ?? m[3] ?? '';
}

/** Build the keyframe list from `values` (preferred) or `from`/`to`/`by`. */
function readValues(attrs: string): string[] {
  const values = attr(attrs, 'values');
  if (values != null && values.trim() !== '') {
    return values
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v !== '');
  }
  const from = attr(attrs, 'from');
  const to = attr(attrs, 'to');
  if (from != null && to != null) return [from.trim(), to.trim()];
  if (to != null) return [to.trim()]; // a lone `to` is a constant (best-effort)
  return [];
}

/** Parse the repeatCount attribute → -1 for indefinite, else a finite count (≥1). */
function readRepeat(attrs: string): number {
  const rc = attr(attrs, 'repeatcount') ?? attr(attrs, 'repeatCount');
  if (rc == null) return 1;
  const s = rc.trim().toLowerCase();
  if (s === 'indefinite') return -1;
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Round to a compact, stable precision (keeps the baked string small). */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Color interpolation (the fix for "color keyframes fall to a discrete step") ──
// SMIL `fill`/`stroke`/`stop-color` keyframes morph between two colors over the
// timeline; without per-channel interpolation a fill would SNAP at the segment
// midpoint. We parse #rgb / #rrggbb / rgb()/rgba() / the common named colors into
// RGBA, lerp each channel, and re-emit rgb()/rgba() (a universally-valid SVG color
// react-native-svg paints). A value we can't parse on EITHER side falls through to
// the caller's step behaviour. Hermes-safe (no DOM/canvas color parsing).

const NAMED_COLORS: Record<string, [number, number, number, number]> = {
  black: [0, 0, 0, 1], white: [255, 255, 255, 1], red: [255, 0, 0, 1],
  green: [0, 128, 0, 1], lime: [0, 255, 0, 1], blue: [0, 0, 255, 1],
  yellow: [255, 255, 0, 1], cyan: [0, 255, 255, 1], aqua: [0, 255, 255, 1],
  magenta: [255, 0, 255, 1], fuchsia: [255, 0, 255, 1], gray: [128, 128, 128, 1],
  grey: [128, 128, 128, 1], silver: [192, 192, 192, 1], maroon: [128, 0, 0, 1],
  olive: [128, 128, 0, 1], navy: [0, 0, 128, 1], teal: [0, 128, 128, 1],
  purple: [128, 0, 128, 1], orange: [255, 165, 0, 1], transparent: [0, 0, 0, 0],
};

/** Parse a color string → [r,g,b,a] (0..255 channels, 0..1 alpha), or null. */
function parseColor(s: string): [number, number, number, number] | null {
  const v = s.trim().toLowerCase();
  if (v === '') return null;
  const named = NAMED_COLORS[v];
  if (named) return [...named];
  if (v[0] === '#') {
    const hex = v.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const ch = hex.split('').map((c) => parseInt(c + c, 16));
      if (ch.some((n) => !Number.isFinite(n))) return null;
      return [ch[0], ch[1], ch[2], hex.length === 4 ? ch[3] / 255 : 1];
    }
    if (hex.length === 6 || hex.length === 8) {
      const ch = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
      if (ch.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
      return [ch[0], ch[1], ch[2], hex.length === 8 ? ch[3] / 255 : 1];
    }
    return null;
  }
  const rgb = /^rgba?\(\s*([^)]+)\)$/.exec(v);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter((p) => p !== '').map((p) => parseFloat(p));
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return [parts[0], parts[1], parts[2], parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : 1];
    }
  }
  return null;
}

/** Interpolate two colors, returning a paintable rgb()/rgba() string, or null when
 *  either side isn't a recognizable color (so the caller can step instead). */
function lerpColor(a: string, b: string, f: number): string | null {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return null;
  const ch = [0, 1, 2].map((i) => Math.round(ca[i] + (cb[i] - ca[i]) * f));
  const al = r3(ca[3] + (cb[3] - ca[3]) * f);
  return al >= 1 ? `rgb(${ch[0]},${ch[1]},${ch[2]})` : `rgba(${ch[0]},${ch[1]},${ch[2]},${al})`;
}

// ── Path `d` interpolation (the fix for "path-d morphs fall to discrete steps") ──
// A draw-on / morph animates the `d` of a <path> between two keyframes. SMIL morphs
// require the two `d` strings to share the SAME command structure (same letters in
// the same order) — only the numeric operands change. We tokenize each into an
// interleaved [command, ...numbers] stream and, when the command skeleton matches,
// lerp the numbers in place (commands copied verbatim). A structural mismatch (a
// genuinely different path topology) can't be linearly morphed, so we step.

/** Split a path-`d` (or any number-bearing token string) into ordered tokens:
 *  command letters and numeric operands, preserving order. */
function pathTokens(d: string): { cmds: string; nums: number[]; order: ('c' | 'n')[] } {
  const order: ('c' | 'n')[] = [];
  let cmds = '';
  const nums: number[] = [];
  const re = /([a-zA-Z])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    if (m[1] != null) {
      cmds += m[1];
      order.push('c');
    } else {
      nums.push(parseFloat(m[2]));
      order.push('n');
    }
  }
  return { cmds, nums, order };
}

/** Interpolate two path-`d` strings sharing the same command skeleton + operand
 *  count, lerping each numeric operand. Returns null on a structural mismatch. */
function lerpPath(a: string, b: string, f: number): string | null {
  const ta = pathTokens(a);
  const tb = pathTokens(b);
  if (
    ta.cmds !== tb.cmds ||
    ta.nums.length !== tb.nums.length ||
    ta.order.length !== tb.order.length ||
    ta.order.some((k, i) => k !== tb.order[i])
  ) {
    return null; // different topology → can't linearly morph
  }
  let ni = 0;
  let ci = 0;
  const cmdChars = ta.cmds.split('');
  return ta.order
    .map((k) => {
      if (k === 'c') return cmdChars[ci++];
      const v = ta.nums[ni] + (tb.nums[ni] - ta.nums[ni]) * f;
      ni++;
      return String(r3(v));
    })
    .join(' ')
    .replace(/\s+([a-zA-Z])/g, '$1') // re-snug a command letter to its operands
    .trim();
}

/** Linearly interpolate between two keyframe strings. Handles, in order: a plain
 *  number (e.g. opacity / stroke-dashoffset), a multi-number tuple (translate /
 *  scale / viewBox), a COLOR (fill / stroke / stop-color), and a path-`d` morph
 *  sharing the same command skeleton. A pair we can't interpolate on either side
 *  steps at the segment midpoint (hold `a`, then `b`) — the previous behaviour. */
function lerpValue(a: string, b: string, f: number): string {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && /^-?\d*\.?\d+\s*$/.test(a) && /^-?\d*\.?\d+\s*$/.test(b)) {
    // Trim to a sane precision so the string stays compact.
    return String(r3(na + (nb - na) * f));
  }
  // Multi-number tuples (e.g. "0 0" → "10 20" for translate, or "1 1" → "2 2"):
  const ta = a.trim().split(/[\s,]+/).map(Number);
  const tb = b.trim().split(/[\s,]+/).map(Number);
  if (ta.length > 1 && ta.length === tb.length && ta.every(Number.isFinite) && tb.every(Number.isFinite)) {
    return ta.map((x, i) => r3(x + (tb[i] - x) * f)).join(' ');
  }
  // COLOR keyframes (fill / stroke / stop-color): per-channel RGBA lerp.
  const col = lerpColor(a, b, f);
  if (col != null) return col;
  // PATH `d` morph / stroke-dasharray-style list with matching command skeleton.
  if (/[a-df-zA-DF-Z]/.test(a) && /[a-df-zA-DF-Z]/.test(b)) {
    const path = lerpPath(a, b, f);
    if (path != null) return path;
  }
  return f < 0.5 ? a : b; // genuinely non-interpolable → discrete step
}

/** Compute the current value of an animation at `tMs` (absolute animation clock).
 *  Returns null while the animation hasn't started or has ended (so the element
 *  keeps its authored static value before begin / after a finite end). */
function valueAt(anim: Anim, tMs: number): string | null {
  if (anim.values.length === 0 || anim.durMs <= 0) return null;
  const local = tMs - anim.beginMs;
  if (local < 0) return null; // not started yet
  if (anim.values.length === 1) return anim.values[0];
  let progressed = local / anim.durMs; // in iterations
  if (anim.repeat >= 0 && progressed >= anim.repeat) {
    // Ended: SMIL holds the LAST keyframe by default (fill is usually 'remove', but
    // overlays read better held; we hold to avoid a snap-to-empty flash).
    return anim.values[anim.values.length - 1];
  }
  const frac = progressed - Math.floor(progressed); // 0..1 within this iteration
  const segs = anim.values.length - 1;
  const pos = frac * segs;
  const i = Math.min(segs - 1, Math.floor(pos));
  const segF = pos - i;
  return lerpValue(anim.values[i], anim.values[i + 1], segF);
}

/** Compose a baked transform string for an animateTransform at the current value. */
function bakeTransform(type: Anim['transformType'], value: string): string {
  switch (type) {
    case 'translate':
      return `translate(${value})`;
    case 'scale':
      return `scale(${value})`;
    case 'rotate':
      return `rotate(${value})`;
    default:
      return '';
  }
}

/** Does the sanitized SVG contain any SMIL animation worth baking? Cheap pre-check
 *  so the renderer can skip the tick entirely for a static overlay. */
export function hasSmilAnimation(svg: string): boolean {
  return /<animate(transform|motion)?\b/i.test(svg) || /<set\b/i.test(svg);
}

/** COLOR-PARITY (mobile over-saturation fix) — react-native-svg's <SvgXml> renders
 *  neither CSS `mix-blend-mode` nor SVG `color-interpolation-filters="linearRGB"` (the
 *  SVG default the browser uses inside <filter>). The art overlays lean on BOTH: high
 *  Hours add `.blend{mix-blend-mode:screen}` so overlapping translucent layers LIGHTEN
 *  toward white on web, and feGaussianBlur/feColorMatrix composite in linearRGB. With
 *  those ignored, mobile stacks every fill as plain source-over alpha in sRGB, so the
 *  same document paints visibly MORE saturated / denser than web.
 *
 *  We can't make react-native-svg honour those, so we approximate web's softer composite
 *  by computing a single parity OPACITY the host applies to the whole overlay: when the
 *  document uses screen-blend (or many stacked translucent layers), a screen blend's
 *  result is always lighter/less-saturated than source-over, which at the macro level
 *  reads like a reduced overall opacity. Returns 1 (no change) for documents that don't
 *  use blend modes, so a plain card is untouched. PURE + Hermes-safe (regex, no DOM). */
export function svgSaturationParityOpacity(svg: string): number {
  // `mix-blend-mode:screen|lighten|color-dodge` — the lightening blends web applies that
  // react-native-svg drops. Their visual effect vs source-over is a softer, lighter
  // composite; ~0.82 brings the mobile stack into line with web without washing it out.
  if (/mix-blend-mode\s*:\s*(screen|lighten|color-dodge|plus-lighter|hard-light)/i.test(svg)) {
    return 0.82;
  }
  return 1;
}

/** Extract the remote raster URLs referenced by an SVG's `<image href>` /
 *  `<image xlink:href>` elements, so the platform can PREFETCH them before the SVG
 *  paints (the fix for "image overlay shown without the image"). Only http(s)/data
 *  URLs are returned — a relative/blob/file ref a remote viewer can't fetch is
 *  skipped. De-duped, order-preserving. PURE + Hermes-safe (regex over the string,
 *  no DOM). */
export function extractSvgImageHrefs(svg: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<image\b[^>]*?\b(?:xlink:href|href)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    const url = (m[2] ?? m[3] ?? '').trim();
    if (!url || seen.has(url)) continue;
    if (!/^(https?:\/\/|data:)/i.test(url)) continue; // only fetchable refs
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Bake every SMIL <animate>/<animateTransform> in `svg` to its value at `nowMs`
 * (an animation clock — e.g. ms since the overlay appeared), returning a static
 * SVG string with the animate tags removed and the computed value applied to the
 * PARENT element (as the named attribute, or merged into `transform`).
 *
 * Re-render the result on a tick to animate. If `svg` has no SMIL it's returned
 * unchanged (cheap). PURE; never throws (a malformed animate is dropped).
 */
export function bakeSvgAnimations(svg: string, nowMs: number): string {
  if (!hasSmilAnimation(svg)) return svg;

  // Walk the element tree, tracking the current OPEN parent so an <animate> child
  // can bake onto it. We rebuild the string, dropping <animate*>/<set> tags and
  // rewriting the parent's start tag with the computed value.
  // Strategy: collect, per parent start-tag occurrence, the baked attr/transform it
  // should carry, then a second pass injects them. Because parents may contain
  // multiple animates, we index parents by their start-tag position.

  // First pass: tokenize into a list of {type:'tag'|'text', ...}.
  type Tok =
    | { kind: 'open'; raw: string; name: string; attrs: string; selfClose: boolean; start: number }
    | { kind: 'close'; raw: string; name: string }
    | { kind: 'text'; raw: string };
  const toks: Tok[] = [];
  const TAG = /<\s*(\/?)\s*([:\w-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*(\/?)\s*>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(svg)) !== null) {
    if (m.index > last) toks.push({ kind: 'text', raw: svg.slice(last, m.index) });
    last = TAG.lastIndex;
    const closing = m[1] === '/';
    const name = m[2];
    if (closing) {
      toks.push({ kind: 'close', raw: m[0], name });
    } else {
      toks.push({
        kind: 'open',
        raw: m[0],
        name,
        attrs: m[3] ?? '',
        selfClose: m[4] === '/',
        start: m.index,
      });
    }
  }
  if (last < svg.length) toks.push({ kind: 'text', raw: svg.slice(last) });

  // Map an open-token index → the baked { attr name → value, transform pieces[] }.
  const bakedAttrs = new Map<number, Record<string, string>>();
  const bakedTransforms = new Map<number, string[]>();

  // Parent stack of open-token indices (skipping self-closing).
  const stack: number[] = [];
  for (let ti = 0; ti < toks.length; ti++) {
    const t = toks[ti];
    if (t.kind === 'open') {
      const lname = t.name.toLowerCase();
      const isAnim = lname === 'animate' || lname === 'animatetransform' || lname === 'set';
      if (isAnim) {
        const parentIdx = stack.length > 0 ? stack[stack.length - 1] : -1;
        if (parentIdx >= 0) {
          const anim: Anim = {
            mode: lname === 'animatetransform' ? 'transform' : 'attr',
            attributeName: attr(t.attrs, 'attributename') ?? attr(t.attrs, 'attributeName'),
            transformType: ((attr(t.attrs, 'type') ?? '').toLowerCase() as Anim['transformType']) || undefined,
            durMs: parseClockMs(attr(t.attrs, 'dur')),
            beginMs: parseClockMs(attr(t.attrs, 'begin')),
            repeat: lname === 'set' ? -1 : readRepeat(t.attrs),
            values: lname === 'set' ? [attr(t.attrs, 'to') ?? ''] : readValues(t.attrs),
          };
          // `set` is an instantaneous hold of `to` after begin.
          const val = lname === 'set'
            ? (nowMs - anim.beginMs >= 0 ? anim.values[0] : null)
            : valueAt(anim, nowMs);
          if (val != null) {
            if (anim.mode === 'transform') {
              const piece = bakeTransform(anim.transformType, val);
              if (piece) {
                const arr = bakedTransforms.get(parentIdx) ?? [];
                arr.push(piece);
                bakedTransforms.set(parentIdx, arr);
              }
            } else if (anim.attributeName) {
              const map = bakedAttrs.get(parentIdx) ?? {};
              map[anim.attributeName] = val;
              bakedAttrs.set(parentIdx, map);
            }
          }
        }
      }
      // Push non-self-closing, non-animate opens (animates are leaves anyway).
      if (!t.selfClose && !isAnim) stack.push(ti);
    } else if (t.kind === 'close') {
      // Pop until we match (tolerant of minor nesting noise).
      if (stack.length > 0) stack.pop();
    }
  }

  // Second pass: emit, dropping animate tags and rewriting parents that got bakes.
  let out = '';
  for (let ti = 0; ti < toks.length; ti++) {
    const t = toks[ti];
    if (t.kind === 'text') {
      out += t.raw;
      continue;
    }
    if (t.kind === 'close') {
      const lname = t.name.toLowerCase();
      if (lname === 'animate' || lname === 'animatetransform' || lname === 'set') continue;
      out += t.raw;
      continue;
    }
    // open tag
    const lname = t.name.toLowerCase();
    if (lname === 'animate' || lname === 'animatetransform' || lname === 'set') continue; // drop
    const ba = bakedAttrs.get(ti);
    const bt = bakedTransforms.get(ti);
    if (!ba && !bt) {
      out += t.raw;
      continue;
    }
    out += rewriteStartTag(t.name, t.attrs, t.selfClose, ba, bt);
  }
  return out;
}

/** Rewrite one start tag, overriding/inserting the baked attributes and merging the
 *  baked transform pieces into its `transform` attribute (appended after any
 *  authored transform so the animated transform composes on top). */
function rewriteStartTag(
  name: string,
  attrs: string,
  selfClose: boolean,
  bakedAttrs: Record<string, string> | undefined,
  bakedTransforms: string[] | undefined,
): string {
  const overrides: Record<string, string> = { ...(bakedAttrs ?? {}) };
  // Parse existing attributes into an ordered list so we can replace in place.
  const ATTR = /([:\w-]+)\s*(=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let existingTransform = '';
  const parts: string[] = [];
  let a: RegExpExecArray | null;
  while ((a = ATTR.exec(attrs)) !== null) {
    const an = a[1];
    const lan = an.toLowerCase();
    let raw = a[3] ?? '';
    const quoted = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'");
    const val = quoted ? raw.slice(1, -1) : raw;
    if (lan === 'transform') {
      existingTransform = val;
      continue; // re-emitted below (merged with baked)
    }
    if (Object.prototype.hasOwnProperty.call(overrides, an)) {
      parts.push(`${an}="${overrides[an]}"`);
      delete overrides[an];
      continue;
    }
    parts.push(a[2] !== undefined ? `${an}=${quoted ? raw : `"${val}"`}` : an);
  }
  // Any baked attrs not present on the element are appended.
  for (const k of Object.keys(overrides)) parts.push(`${k}="${overrides[k]}"`);
  // Merge transform: authored first, then the animated pieces on top.
  if (bakedTransforms && bakedTransforms.length > 0) {
    const merged = [existingTransform, ...bakedTransforms].filter((s) => s.trim() !== '').join(' ');
    parts.push(`transform="${merged}"`);
  } else if (existingTransform) {
    parts.push(`transform="${existingTransform}"`);
  }
  return `<${name}${parts.length ? ' ' + parts.join(' ') : ''}${selfClose ? '/' : ''}>`;
}
