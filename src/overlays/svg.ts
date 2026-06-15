// SVG OVERLAY — a NEW overlay kind alongside doc / poll / quiz / vote, carried on
// the SAME `overlay` data topic. It is the foundation for future integrations: a
// streamer (or, later, an integration bot) ships a self-contained SVG document
// that positions its OWN content/transforms over the live preview, and every
// viewer paints it as an absolute layer above the video.
//
// WHY a distinct wire kind (not an OverlayInstance):
//   • An SVG overlay is FIRE-AND-FORGET + MULTIPLE: many independent SVGs can be
//     live at once (each keyed by its own id), with a TTL as the primary cleanup.
//     The OverlayInstance/slot model is single-active-per-slot with votes/gen —
//     wrong shape for "a set of N transient decorations". So SVG rides additive
//     `overlay.svg` / `overlay.svg.delete` envelopes on the shared topic that the
//     Go bot's decoder ignores (unknown `t` → null), exactly like live.sync.
//   • The reducer here is a pure SET keyed by id, each entry carrying an expiry
//     (receivedAt + ttlMs). Re-sending the same id REPLACES; a delete or TTL lapse
//     removes. Pure + platform-free so web + mobile prune identically; only the DOM
//     injection (+ the security sanitize) lives per-platform in the web renderer.
//
// SECURITY NOTE (the sanitizer is the load-bearing part) lives in the WEB layer:
// it needs a DOM to parse/serialize. This module is intentionally DOM-free — it
// only models + transports the raw svg string; the renderer sanitizes before it
// ever touches innerHTML. The size cap below is the reliable-packet budget.

/** Max bytes of an svg document we accept on the wire (the reliable-packet cap).
 *  A larger document is rejected at decode time (returns null) rather than risk a
 *  fragmented/oversized reliable packet. 15 KiB. */
export const SVG_OVERLAY_MAX_BYTES = 15 * 1024;

/** Default time-to-live for an SVG overlay when the sender omits `ttlMs`. TTL is
 *  the PRIMARY cleanup path (delete is optional), so an absent ttl still expires.
 *  60s — long enough for a decoration to land, short enough that a dropped delete
 *  can't strand it forever. */
export const SVG_OVERLAY_DEFAULT_TTL_MS = 60_000;

// ── Wire (v1, on the `overlay` topic) ────────────────────────────────────────

/** SET an SVG overlay. `svg` is a FULL SVG document (≤ SVG_OVERLAY_MAX_BYTES) that
 *  positions its own content/transforms over the preview. Re-sending the same `id`
 *  REPLACES the prior one. `ttlMs` bounds its life (defaults applied on receive). */
export interface SvgOverlaySetMsg {
  t: 'overlay.svg';
  v: number;
  id: string;
  svg: string;
  ttlMs?: number;
}

/** DELETE an SVG overlay by id. Optional — TTL is the primary cleanup; this is for
 *  an early removal (e.g. the streamer pulls a decoration before it expires). */
export interface SvgOverlayDeleteMsg {
  t: 'overlay.svg.delete';
  v: number;
  id: string;
}

/** Any SVG-overlay envelope on the shared topic. */
export type SvgOverlayMsg = SvgOverlaySetMsg | SvgOverlayDeleteMsg;

/** Wire version for the SVG-overlay envelope (independent of the bot overlay wire,
 *  so it can evolve without a flag day on the participation protocol). */
export const SVG_OVERLAY_WIRE_VERSION = 1;

// ── Model + reducer (pure; the SET of live SVGs keyed by id) ──────────────────

/** One live SVG overlay as a client holds it. `svg` is the RAW (un-sanitized)
 *  document exactly as it came off the wire — the renderer sanitizes at inject
 *  time. `expiresAtMs` = receivedAt + ttlMs; the pruner drops entries at/after it. */
export interface SvgOverlay {
  id: string;
  /** Raw SVG document string (sanitized by the renderer before DOM injection). */
  svg: string;
  /** Wall-clock ms when this overlay was received (for diagnostics / re-replace). */
  receivedAtMs: number;
  /** Wall-clock ms at/after which this overlay is expired and should be pruned. */
  expiresAtMs: number;
}

/** The live SVG set: id → SvgOverlay. A plain record so it's trivially serializable
 *  and the web layer can map over its values into positioned DOM layers. */
export type SvgOverlayState = Record<string, SvgOverlay>;

/** A fresh, empty SVG overlay set. */
export function emptySvgOverlays(): SvgOverlayState {
  return {};
}

/** Fold a decoded SET message into the state at receive time `nowMs`. Same id ⇒
 *  REPLACE (new svg + refreshed expiry). Pure — returns a new state. An absent /
 *  non-positive ttl falls back to the default so an entry always expires. */
export function setSvgOverlay(
  state: SvgOverlayState,
  msg: SvgOverlaySetMsg,
  nowMs: number,
): SvgOverlayState {
  const ttl = msg.ttlMs != null && msg.ttlMs > 0 ? msg.ttlMs : SVG_OVERLAY_DEFAULT_TTL_MS;
  return {
    ...state,
    [msg.id]: {
      id: msg.id,
      svg: msg.svg,
      receivedAtMs: nowMs,
      expiresAtMs: nowMs + ttl,
    },
  };
}

/** Remove one id from the state (a delete event). Pure — returns the SAME ref when
 *  the id wasn't present (so a no-op delete doesn't churn React renders). */
export function deleteSvgOverlay(state: SvgOverlayState, id: string): SvgOverlayState {
  if (!(id in state)) return state;
  const next = { ...state };
  delete next[id];
  return next;
}

/** Drop every entry whose expiry is at/before `nowMs`. Pure — returns the SAME ref
 *  when nothing expired (so a prune tick with no expiries is render-free). This is
 *  the TTL cleanup the renderer's interval calls; it never mutates the input. */
export function pruneExpiredSvgOverlays(state: SvgOverlayState, nowMs: number): SvgOverlayState {
  let changed = false;
  const next: SvgOverlayState = {};
  for (const id in state) {
    if (state[id].expiresAtMs > nowMs) next[id] = state[id];
    else changed = true;
  }
  return changed ? next : state;
}

/** The live overlays as an array (insertion order of the record). Convenience for
 *  the renderer to map over; the DOM stacks them in this order. */
export function liveSvgOverlays(state: SvgOverlayState): SvgOverlay[] {
  return Object.values(state);
}

// ── encode / decode ──────────────────────────────────────────────────────────
// Mirrors the overlay/live-sync wire: UTF-8 JSON with TextEncoder/TextDecoder
// feature-detected off globalThis (no lib.dom pulled into this platform-free pkg).

interface TE {
  encode(s: string): Uint8Array;
}
interface TD {
  decode(b: Uint8Array): string;
}
const gg = globalThis as unknown as {
  TextEncoder?: new () => TE;
  TextDecoder?: new () => TD;
};

/** Serialize an SVG-overlay message to the bytes published on the `overlay` topic.
 *  Stamps the wire version when the caller omitted it. */
export function encodeSvgOverlayMsg(msg: SvgOverlayMsg): Uint8Array {
  const withV = { ...msg, v: (msg as { v?: number }).v ?? SVG_OVERLAY_WIRE_VERSION };
  const json = JSON.stringify(withV);
  if (gg.TextEncoder) return new gg.TextEncoder().encode(json);
  const out = new Uint8Array(json.length);
  for (let i = 0; i < json.length; i++) out[i] = json.charCodeAt(i) & 0xff;
  return out;
}

/** Parse bytes into an SVG-overlay message, or null when they aren't one (so a
 *  foreign / participation packet on the shared topic is safely ignored, never
 *  throws). A SET whose `id`/`svg` are malformed — or whose svg exceeds the byte
 *  cap — also decodes to null (it must not reach the DOM injector). */
export function decodeSvgOverlayMsg(bytes: Uint8Array): SvgOverlayMsg | null {
  let json: string;
  if (gg.TextDecoder) json = new gg.TextDecoder().decode(bytes);
  else {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    json = s;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as { t?: unknown; id?: unknown; svg?: unknown; ttlMs?: unknown };
  if (o.t === 'overlay.svg') {
    if (typeof o.id !== 'string' || !o.id) return null;
    if (typeof o.svg !== 'string' || !o.svg) return null;
    // Enforce the reliable-packet budget on the RAW svg bytes (UTF-8), so an
    // oversized document is rejected here and never reaches the renderer.
    if (svgByteLength(o.svg) > SVG_OVERLAY_MAX_BYTES) return null;
    const ttlMs = typeof o.ttlMs === 'number' && o.ttlMs > 0 ? o.ttlMs : undefined;
    return { t: 'overlay.svg', v: SVG_OVERLAY_WIRE_VERSION, id: o.id, svg: o.svg, ttlMs };
  }
  if (o.t === 'overlay.svg.delete') {
    if (typeof o.id !== 'string' || !o.id) return null;
    return { t: 'overlay.svg.delete', v: SVG_OVERLAY_WIRE_VERSION, id: o.id };
  }
  return null;
}

/** UTF-8 byte length of an svg string (TextEncoder when available; else a manual
 *  code-unit count that's exact for ASCII and a safe over/under-estimate otherwise
 *  — used only to gate the reliable-packet cap). */
function svgByteLength(svg: string): number {
  if (gg.TextEncoder) return new gg.TextEncoder().encode(svg).length;
  return svg.length;
}
