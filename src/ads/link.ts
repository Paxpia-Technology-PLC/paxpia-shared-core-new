// Advertiser-supplied destination links, and the one gate every CTA passes through.
//
// ── WHY A LINK IS NOT JUST A STRING ──────────────────────────────────────────────
//
// A CTA target is the only field in the whole ads model that an advertiser authors and
// a VIEWER's device then acts on. On mobile that action is `Linking.openURL`, which is
// not a browser call — it is "hand this string to the operating system and let it decide
// who opens it". `tel:`, `sms:`, `intent:`, a bank's `myapp://transfer?...` deep link and
// `javascript:` are all valid arguments to it. So the string has to be narrowed to
// http/https BEFORE it reaches the platform, and it has to be narrowed in the domain
// core rather than at each of the two call sites that open it, because a gate that lives
// at the call site is a gate that the third call site won't have.
//
// The second reason is plainer: advertisers type `example.com`. A field that only accepts
// a fully-qualified URL rejects the most common thing a person will enter, so the
// normaliser supplies the scheme instead of complaining about it.
//
// ── WHAT IS DELIBERATELY REJECTED ────────────────────────────────────────────────
//
//   • any scheme other than http/https  — see above; this is the security boundary
//   • userinfo (`https://paxpia.et@evil.example`) — the classic look-alike: the part a
//     reader treats as the destination is the part the browser treats as a username
//   • hosts with no dot (`localhost`) and bare IPs — neither is a real advertiser
//     destination, and both are how an ad points at something on the viewer's own network
//   • whitespace and control characters anywhere, including the zero-width and
//     line-separator ranges, which are what make two different URLs render identically
//
// No `new URL()`. React Native's URL is a partial polyfill whose parsing has historically
// disagreed with the web's, and a security gate must not behave differently on one of the
// two platforms that share this file.

import type { AdCreativeDraft, AdCtaLabel, AdTarget } from './types';
import { isAdCtaLabel } from './types';

/** Generous but finite. Real destinations with campaign parameters run long; nothing
 *  legitimate runs past this, and an unbounded string is a field that can be used to
 *  push the rest of a payload out of a log line. */
export const AD_LINK_MAX_LENGTH = 2048;

/** Why a link was refused. The caller maps these to copy — the advertiser needs to know
 *  WHICH thing is wrong, because "invalid link" is not something a person can act on. */
export type AdLinkProblem = 'empty' | 'too_long' | 'scheme' | 'malformed';

export interface AdLinkResult {
  /** The normalised absolute URL, or null when `problem` is set. */
  url: string | null;
  problem?: AdLinkProblem;
}

/** Whitespace, C0/C1 controls, and the invisible characters that let two visually
 *  identical strings resolve to different hosts. Written as escapes rather than as the
 *  literal characters deliberately: a zero-width space pasted into a source file is
 *  invisible to the next reader and to code review. */
const FORBIDDEN_CHARS = new RegExp(
  '[\\s'
  + '\\u0000-\\u001f\\u007f-\\u009f'   // C0 and C1 controls
  + '\\u00ad'                          // soft hyphen
  + '\\u200b-\\u200f'                  // zero-width joiners + bidi marks
  + '\\u2028\\u2029'                   // line / paragraph separators
  + '\\u202a-\\u202e\\u2066-\\u2069'   // bidi overrides -- right-to-left spoofing
  + '\\ufeff'                          // BOM
  + ']',
);

/**
 * A scheme, MINUS the dot that RFC 3986 allows in one.
 *
 * Dropping `.` from the character class is what disambiguates `example.et:8443/x` — which
 * a person typing into this field means as host:port, and which the RFC-exact pattern
 * reads as a scheme named `example.et`, rejecting a perfectly good destination as an
 * unsupported protocol. No scheme this field accepts has a dot in it, and the ones it
 * refuses (`javascript:`, `data:`, `tel:`, `intent:`, an app's own `paxpia:`) don't
 * either, so nothing that matters is misread the other way.
 */
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+-]*):/;

/** Two or more dot-separated labels ending in an alphabetic TLD. Rejects `localhost`,
 *  rejects `10.0.0.1` (numeric last label), accepts `abugida.edu.et`. */
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

/**
 * Normalise whatever the advertiser typed into an absolute http(s) URL, or say why not.
 *
 * Scheme-less input gets `https://` — not `http://`. An advertiser who omits the scheme
 * has expressed no preference, and defaulting to the plaintext one on their behalf would
 * be choosing the worse option for their own visitors.
 *
 * The host is lower-cased (it is case-insensitive, and a mixed-case host is the same
 * destination stored two ways); the path, query and fragment are left EXACTLY as typed,
 * because those are case-sensitive and re-encoding them is how a working signed URL stops
 * working.
 */
export function normalizeAdLink(raw: string): AdLinkResult {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { url: null, problem: 'empty' };
  if (trimmed.length > AD_LINK_MAX_LENGTH) return { url: null, problem: 'too_long' };
  if (FORBIDDEN_CHARS.test(trimmed)) return { url: null, problem: 'malformed' };

  const matched = SCHEME.exec(trimmed);
  let scheme: 'http' | 'https';
  let authorityAndTail: string;

  if (matched) {
    const found = matched[1].toLowerCase();
    if (found !== 'http' && found !== 'https') return { url: null, problem: 'scheme' };
    scheme = found;
    // Tolerates `https:/example.et` and `https:example.et` as well as the correct form —
    // all three are typos of the same intent, and none is ambiguous.
    authorityAndTail = trimmed.slice(matched[0].length).replace(/^\/*/, '');
  } else {
    scheme = 'https';
    // A protocol-relative `//example.et` and a stray leading slash are the same intent.
    authorityAndTail = trimmed.replace(/^\/*/, '');
  }

  if (!authorityAndTail) return { url: null, problem: 'malformed' };

  const cut = authorityAndTail.search(/[/?#]/);
  const authority = cut === -1 ? authorityAndTail : authorityAndTail.slice(0, cut);
  const tail = cut === -1 ? '' : authorityAndTail.slice(cut);

  // Userinfo. Rejected rather than stripped: stripping it would silently change the
  // destination the advertiser asked for, which is worse than refusing it.
  if (!authority || authority.includes('@')) return { url: null, problem: 'malformed' };

  const parts = authority.split(':');
  if (parts.length > 2) return { url: null, problem: 'malformed' };
  const [host, port] = parts;
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return { url: null, problem: 'malformed' };
  if (port !== undefined && (Number(port) === 0 || Number(port) > 65_535)) {
    return { url: null, problem: 'malformed' };
  }
  if (!HOST.test(host)) return { url: null, problem: 'malformed' };

  return { url: `${scheme}://${host.toLowerCase()}${port ? `:${port}` : ''}${tail}` };
}

/**
 * The gate for a URL that arrived over the wire rather than from a text field.
 *
 * Same rules, no normalisation: a serve response's `cta.target.url` was already normalised
 * when it was authored, so the only question left is whether it is safe to hand to the
 * platform. Answering that with the same predicate the field used is the point — one set
 * of rules, checked on the way in AND on the way out.
 */
export function isSafeAdUrl(url: string): boolean {
  if (!url || FORBIDDEN_CHARS.test(url)) return false;
  const matched = SCHEME.exec(url);
  if (!matched) return false;
  const scheme = matched[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return false;
  return normalizeAdLink(url).url !== null;
}

/** A CTA that is safe to render and safe to act on. */
export interface ResolvedAdCta {
  label: AdCtaLabel;
  target: AdTarget;
}

/**
 * The single answer to "does this creative have a call to action?".
 *
 * Returns null — meaning RENDER NO CTA BAR — for three cases that all look different in
 * the payload and identical to the viewer:
 *
 *  1. `cta` is absent. A boosted post whose author gave no destination: there is nothing
 *     to send anybody to, and a button reading "Learn more" that leads back to the post
 *     already on screen is a promise the ad cannot keep.
 *  2. `cta` is present but EMPTY. This is the shape the Go service actually returns for
 *     case 1: `Creative.CTA` is a value struct, not a pointer, so an omitted `cta`
 *     round-trips as `{"label":"","target":{"kind":""}}`. A client that only checked for
 *     absence would render a blank brand-coloured bar wired to nothing.
 *  3. `cta` is present and populated but its target is unusable — an unknown label, a
 *     route with no route name, or a URL that fails `isSafeAdUrl`. A creative that
 *     reaches a viewer with a `javascript:` target is a review failure, and this is the
 *     layer that makes it inert regardless.
 *
 * URL targets come back NORMALISED, so what opens is what this function vetted rather
 * than the raw string beside it.
 */
export function resolveAdCta(creative: AdCreativeDraft): ResolvedAdCta | null {
  const cta = creative.cta;
  if (!cta || !isAdCtaLabel(cta.label)) return null;

  const target = cta.target;
  if (!target) return null;

  if (target.kind === 'route') {
    const route = target.route?.trim();
    return route ? { label: cta.label, target: { ...target, route } } : null;
  }

  if (target.kind === 'url') {
    const normalized = normalizeAdLink(target.url ?? '');
    return normalized.url ? { label: cta.label, target: { kind: 'url', url: normalized.url } } : null;
  }

  return null;
}
