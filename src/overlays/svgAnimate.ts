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

/** Linearly interpolate between two NUMERIC keyframe strings; if either side isn't
 *  a plain number we fall back to a step (hold the from value until the midpoint),
 *  so a non-numeric value (e.g. a color word) at least advances discretely. */
function lerpValue(a: string, b: string, f: number): string {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && /^-?\d*\.?\d+\s*$/.test(a) && /^-?\d*\.?\d+\s*$/.test(b)) {
    const v = na + (nb - na) * f;
    // Trim to a sane precision so the string stays compact.
    return String(Math.round(v * 1000) / 1000);
  }
  // Multi-number tuples (e.g. "0 0" → "10 20" for translate, or "1 1" → "2 2"):
  const ta = a.trim().split(/[\s,]+/).map(Number);
  const tb = b.trim().split(/[\s,]+/).map(Number);
  if (ta.length > 1 && ta.length === tb.length && ta.every(Number.isFinite) && tb.every(Number.isFinite)) {
    return ta.map((x, i) => Math.round((x + (tb[i] - x) * f) * 1000) / 1000).join(' ');
  }
  return f < 0.5 ? a : b; // non-numeric → discrete step
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
