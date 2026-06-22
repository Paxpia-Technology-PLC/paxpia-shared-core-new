// WHITEBOARD OVERLAY — a synced, takeover-capable freehand board carried on the
// SAME `overlay` data topic as svg / poll / quiz / doc. It RETIRES the naive private
// `paxpia.live.data` plane (mobile `realtime/liveData.ts` `wb` namespace): the exact
// same product behaviour (path append / erase-by-id / wipe / late-joiner snapshot,
// gen-gated) now rides the shared overlay transport, so the consume ladder gains one
// branch and nothing else changes.
//
// MODELLED ON `overlays/svg.ts` (keyed pure-reducer set, UTF-8 JSON codec, byte cap)
// and the SEMANTICS of the original mobile `useLiveWhiteboard.applyWb`:
//   • A board is an ordered set of vector strokes within a GENERATION (`gen`).
//   • `snapshot` REPLACES the whole board (full state for a late joiner).
//   • `wipe` bumps the generation and clears (the wipe is the empty-at-new-gen state).
//   • `stroke` APPENDS — but a stroke at a NEWER gen than we hold implies we MISSED a
//     wipe, so we start fresh from that stroke (the gen-stale discipline).
//   • `erase` removes one stroke by id within the current gen.
//
// PURE + platform-free: no DOM, no RN. The HTML renderer (streaming/whiteboardHtml.ts)
// composites strokes into a live WebView DOM at 60fps; this module only models +
// transports the stroke set. CRDT-ready the same way the doc seam is: applyWb is a
// pure fold over an ordered, id-keyed set, so swapping LWW-snapshot+gen for a CRDT log
// later is a change HERE, not in the renderer.

/** Max bytes of ONE whiteboard wire message we accept (the reliable-packet cap).
 *  A larger message — an oversized stroke `d`, or a snapshot whose serialized form
 *  exceeds this — is rejected at decode time (returns null) rather than risk a
 *  fragmented/oversized reliable packet. 8 KiB. */
export const WB_MAX_STROKE_BYTES = 8 * 1024;

/** Wire version for the whiteboard envelope (independent of the other overlay wires,
 *  so it can evolve without a flag day on the rest of the participation protocol). */
export const WB_WIRE_VERSION = 1;

// ── Stroke model ──────────────────────────────────────────────────────────────

/** One finished freehand stroke. `d` is SVG path data in CANVAS coords (the fixed
 *  WhiteboardPayload.canvas space), so it is renderer-agnostic — the WebView <svg>/
 *  <canvas> and any fallback paint it identically. `id` is sender-assigned + stable
 *  so erase/undo can target it. */
export interface WbStroke {
  id: string;
  d: string;
  color: string;
  width: number;
}

// ── Wire (v1, on the SHARED `overlay` topic — NOT a new topic) ────────────────

/** APPEND one finished stroke to the board at `gen`. A stroke at a gen NEWER than the
 *  receiver holds means a wipe was missed → the receiver starts fresh from this stroke. */
export interface WbStrokeMsg {
  t: 'overlay.wb.stroke';
  v: number;
  boardId: string;
  gen: number;
  stroke: WbStroke;
}

/** ERASE one stroke by id within the current generation. */
export interface WbEraseMsg {
  t: 'overlay.wb.erase';
  v: number;
  boardId: string;
  gen: number;
  id: string;
}

/** WIPE the board: bumps the generation and clears. */
export interface WbWipeMsg {
  t: 'overlay.wb.wipe';
  v: number;
  boardId: string;
  gen: number;
}

/** SNAPSHOT the full stroke set at `gen` — the late-joiner sync the publisher replies
 *  with on request_state / ParticipantConnected (REPLACES whatever the receiver held). */
export interface WbSnapshotMsg {
  t: 'overlay.wb.snapshot';
  v: number;
  boardId: string;
  gen: number;
  strokes: WbStroke[];
}

/** Any whiteboard envelope on the shared topic. */
export type WbMsg = WbStrokeMsg | WbEraseMsg | WbWipeMsg | WbSnapshotMsg;

// ── Model + reducer (pure; the board state is gen + an ordered stroke list) ───

/** A board as a client holds it: the current generation + its ordered strokes. */
export interface WbBoardState {
  gen: number;
  strokes: WbStroke[];
}

/** A fresh, empty board (gen 0, no strokes). */
export function emptyBoard(): WbBoardState {
  return { gen: 0, strokes: [] };
}

/** Fold one decoded whiteboard message into the board (gen-aware). PURE — returns a
 *  new state (or the same ref when an erase is a no-op, so React doesn't churn).
 *    • snapshot → REPLACE (full set at msg.gen).
 *    • wipe     → clear at msg.gen (the empty-at-gen state).
 *    • stroke   → append; but a stroke at a gen NEWER than ours ⇒ a missed wipe, so we
 *                 start fresh from this stroke. A stroke at an OLDER gen is stale → drop.
 *    • erase    → remove the id within the current gen; an older-gen erase is stale → drop. */
export function applyWb(prev: WbBoardState, msg: WbMsg): WbBoardState {
  switch (msg.t) {
    case 'overlay.wb.snapshot':
      // A snapshot is authoritative for its gen. Ignore a strictly-older one (we've
      // already advanced past it via a live wipe); otherwise adopt it wholesale.
      if (msg.gen < prev.gen) return prev;
      return { gen: msg.gen, strokes: msg.strokes.slice() };
    case 'overlay.wb.wipe':
      // A wipe only ever moves us forward (or re-asserts the current empty gen).
      if (msg.gen < prev.gen) return prev;
      return { gen: msg.gen, strokes: [] };
    case 'overlay.wb.stroke': {
      if (msg.gen < prev.gen) return prev; // stale stroke from a superseded gen → drop
      // A stroke at a NEWER gen means we missed the wipe that bumped it → start fresh.
      const base = msg.gen > prev.gen ? [] : prev.strokes;
      return { gen: msg.gen, strokes: [...base, msg.stroke] };
    }
    case 'overlay.wb.erase': {
      if (msg.gen < prev.gen) return prev; // stale erase → drop
      // A newer-gen erase implies a missed wipe → the board is already empty there.
      if (msg.gen > prev.gen) return { gen: msg.gen, strokes: [] };
      if (!prev.strokes.some((s) => s.id === msg.id)) return prev; // no-op → same ref
      return { gen: prev.gen, strokes: prev.strokes.filter((s) => s.id !== msg.id) };
    }
    default:
      return prev;
  }
}

// ── encode / decode ──────────────────────────────────────────────────────────
// Mirrors overlays/svg.ts: UTF-8 JSON with TextEncoder/TextDecoder feature-detected
// off globalThis (no lib.dom pulled into this platform-free pkg), and a byte cap that
// rejects an oversized message at decode time (returns null — never reaches the DOM).

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

function utf8Encode(s: string): Uint8Array {
  if (gg.TextEncoder) return new gg.TextEncoder().encode(s);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function utf8Decode(bytes: Uint8Array): string {
  if (gg.TextDecoder) return new gg.TextDecoder().decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Serialize a whiteboard message to the bytes published on the `overlay` topic.
 *  Stamps the wire version when the caller omitted it. */
export function encodeWbMsg(msg: WbMsg): Uint8Array {
  const withV = { ...msg, v: (msg as { v?: number }).v ?? WB_WIRE_VERSION };
  return utf8Encode(JSON.stringify(withV));
}

/** Parse bytes into a whiteboard message, or null when they aren't one (so a foreign /
 *  participation packet on the shared topic is safely ignored, never throws). A message
 *  whose required fields are malformed — or whose SERIALIZED form exceeds the byte cap —
 *  also decodes to null (it must not reach the renderer). */
export function decodeWbMsg(bytes: Uint8Array): WbMsg | null {
  // Enforce the reliable-packet budget on the RAW bytes first, so an oversized message
  // (a giant stroke `d` or a fat snapshot) is rejected here and never parsed/rendered.
  if (bytes.length > WB_MAX_STROKE_BYTES) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(utf8Decode(bytes));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as {
    t?: unknown;
    boardId?: unknown;
    gen?: unknown;
    stroke?: unknown;
    strokes?: unknown;
    id?: unknown;
  };
  if (typeof o.boardId !== 'string' || !o.boardId) return null;
  if (typeof o.gen !== 'number' || !Number.isFinite(o.gen)) return null;
  switch (o.t) {
    case 'overlay.wb.stroke': {
      const stroke = normalizeStroke(o.stroke);
      if (!stroke) return null;
      return { t: 'overlay.wb.stroke', v: WB_WIRE_VERSION, boardId: o.boardId, gen: o.gen, stroke };
    }
    case 'overlay.wb.erase': {
      if (typeof o.id !== 'string' || !o.id) return null;
      return { t: 'overlay.wb.erase', v: WB_WIRE_VERSION, boardId: o.boardId, gen: o.gen, id: o.id };
    }
    case 'overlay.wb.wipe':
      return { t: 'overlay.wb.wipe', v: WB_WIRE_VERSION, boardId: o.boardId, gen: o.gen };
    case 'overlay.wb.snapshot': {
      if (!Array.isArray(o.strokes)) return null;
      const strokes: WbStroke[] = [];
      for (const raw of o.strokes) {
        const s = normalizeStroke(raw);
        if (!s) return null; // a malformed stroke poisons the whole snapshot
        strokes.push(s);
      }
      return { t: 'overlay.wb.snapshot', v: WB_WIRE_VERSION, boardId: o.boardId, gen: o.gen, strokes };
    }
    default:
      return null;
  }
}

/** Validate + coerce a raw value into a WbStroke, or null if it isn't one. */
function normalizeStroke(raw: unknown): WbStroke | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as { id?: unknown; d?: unknown; color?: unknown; width?: unknown };
  if (typeof s.id !== 'string' || !s.id) return null;
  if (typeof s.d !== 'string' || !s.d) return null;
  if (typeof s.color !== 'string' || !s.color) return null;
  if (typeof s.width !== 'number' || !Number.isFinite(s.width)) return null;
  return { id: s.id, d: s.d, color: s.color, width: s.width };
}
