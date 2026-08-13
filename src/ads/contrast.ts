// Brand-colour safety for the CTA bar.
//
// Advertisers upload a brand colour and it fills the highest-value tap target on the
// card. That means an arbitrary hex, chosen for a logo on white paper, has to stay
// legible against BOTH app themes — and creatorTheme.ts already documents what happens
// when it doesn't: #F59E0B is 2.1:1 on white and fails even the 3:1 bar for graphical
// objects, which is why every creator tone carries a darkened light-mode twin.
//
// The rule here: a brand colour that fails contrast is ADJUSTED, never rejected. An
// advertiser whose campaign is blocked because their brand is yellow will not thank you
// for your accessibility standards — they will file a support ticket. Darkening for
// light mode and lightening for dark mode keeps the brand recognisable while keeping
// the label readable, which is what both sides actually want.
//
// Pure maths, no platform: web and mobile render the result, the Go creative-review
// path can run the same check at upload time and warn in the builder.

/** WCAG AA for normal text. */
export const CONTRAST_AA = 4.5;
/** WCAG AA for large text and graphical objects. */
export const CONTRAST_LARGE = 3.0;

export interface Rgb { r: number; g: number; b: number }

/** Parse `#rgb`, `#rrggbb` (with or without the hash). Returns null when unparseable —
 *  never throws, because this runs on advertiser-supplied data. */
export function parseHex(hex: string): Rgb | null {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Relative luminance, per WCAG 2.x. */
export function luminance({ r, g, b }: Rgb): number {
  const chan = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/** Contrast ratio between two colours, 1..21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** Which label colour reads better on this background. */
export function bestLabelOn(bg: Rgb): '#FFFFFF' | '#000000' {
  return contrastRatio(bg, WHITE) >= contrastRatio(bg, BLACK) ? '#FFFFFF' : '#000000';
}

function mix(c: Rgb, target: Rgb, amount: number): Rgb {
  return {
    r: c.r + (target.r - c.r) * amount,
    g: c.g + (target.g - c.g) * amount,
    b: c.b + (target.b - c.b) * amount,
  };
}

export interface SafeBrandColor {
  /** The colour to actually paint. */
  background: string;
  /** The label colour that clears the threshold against it. */
  label: string;
  /** True when the supplied colour had to be moved. Surfaced in the builder's preview
   *  so an advertiser learns it at upload time rather than discovering it in the feed. */
  adjusted: boolean;
  ratio: number;
}

/**
 * Which label a filled surface is allowed to use.
 *
 * `'auto'` picks whichever of black/white contrasts better, which is the correct answer
 * to "is this legible" and the WRONG answer to "does this look like an ad platform".
 * A mid-bright brand — the app's own #429ef5 among them — scores 7.4:1 against BLACK and
 * only 2.8:1 against white, so auto paints black text on a bright blue slab. It passes
 * AA and it looks like a 2014 banner: no shipping ad product puts black on a saturated
 * fill, they all darken the fill and set white on it.
 *
 * `'light'` says so: the label is white, and the FILL moves until white clears the bar.
 */
export type LabelPreference = 'auto' | 'light';

/**
 * Make a brand colour safe for one theme.
 *
 * Walks the colour toward black (light theme) or white (dark theme) in small steps until
 * its best label clears `threshold`. Steps are small so a brand stays recognisable —
 * most colours need one or two, and the ones that need many were never going to work as
 * a full-bleed background.
 *
 * Under `prefer: 'light'` the walk is always toward black regardless of theme, because
 * the thing being satisfied is white-on-brand rather than best-of-two-on-brand.
 */
export function safeBrandColor(
  hex: string | undefined,
  theme: 'light' | 'dark',
  fallback: string,
  threshold: number = CONTRAST_AA,
  prefer: LabelPreference = 'auto',
): SafeBrandColor {
  const parsed = parseHex(hex ?? '') ?? parseHex(fallback);
  if (!parsed) {
    return { background: fallback, label: '#FFFFFF', adjusted: true, ratio: 0 };
  }

  // In light mode the card is white, so a pale brand disappears into it — darken.
  // In dark mode the card is near-black, so a very dark brand disappears — lighten.
  // A forced-white label overrides both: only darkening can rescue it.
  const target = prefer === 'light' || theme === 'light' ? BLACK : WHITE;
  const labelFor = (c: Rgb) => (prefer === 'light' ? '#FFFFFF' : bestLabelOn(c));

  let current = parsed;
  let ratio = contrastRatio(current, parseHex(labelFor(current))!);
  let adjusted = false;

  for (let step = 0; step < 12 && ratio < threshold; step++) {
    current = mix(current, target, 0.08);
    ratio = contrastRatio(current, parseHex(labelFor(current))!);
    adjusted = true;
  }

  return { background: toHex(current), label: labelFor(current), adjusted, ratio };
}

export interface SafeAccent {
  /** The colour to paint the glyph or label in. */
  color: string;
  adjusted: boolean;
  ratio: number;
}

/**
 * Make a brand colour safe as INK — text or a glyph drawn ON a known background, rather
 * than as a fill with text on top of it.
 *
 * `safeBrandColor` cannot answer this. It optimises the contrast between a brand and its
 * own label, so it happily returns a colour that is unreadable against the surface it is
 * about to be drawn on: a dark navy brand scores 12:1 against white text and vanishes
 * against a near-black card. This walks the other axis — away from the background — until
 * the brand itself is readable on it.
 *
 * Used wherever the brand is expressed as a tint rather than a slab: a CTA that is a wash
 * of the brand with the brand's own name in it needs both halves to be this colour.
 */
export function accentOn(
  hex: string | undefined,
  background: string,
  fallback: string,
  threshold: number = CONTRAST_AA,
): SafeAccent {
  const parsed = parseHex(hex ?? '') ?? parseHex(fallback);
  const bg = parseHex(background);
  if (!parsed || !bg) return { color: hex ?? fallback, adjusted: false, ratio: 0 };

  // Away from the background, whichever way that is: lighten on a dark surface, darken
  // on a light one.
  const target = luminance(bg) > 0.4 ? BLACK : WHITE;

  let current = parsed;
  let ratio = contrastRatio(current, bg);
  let adjusted = false;

  // Larger steps and more of them than the fill walk allows: ink has to clear the bar
  // outright, and a brand that starts close to the background needs real distance. The
  // cap still exists so a pathological input terminates — 20 × 10% lands ~88% of the way
  // to white or black, which clears AA against any surface this app renders.
  for (let step = 0; step < 20 && ratio < threshold; step++) {
    current = mix(current, target, 0.1);
    ratio = contrastRatio(current, bg);
    adjusted = true;
  }

  return { color: toHex(current), adjusted, ratio };
}

/** Does this colour work in BOTH themes without adjustment? What the builder should
 *  tell an advertiser before they commit to it. */
export function brandColorPassesBothThemes(hex: string, threshold: number = CONTRAST_AA): boolean {
  const l = safeBrandColor(hex, 'light', hex, threshold);
  const d = safeBrandColor(hex, 'dark', hex, threshold);
  return !l.adjusted && !d.adjusted;
}
