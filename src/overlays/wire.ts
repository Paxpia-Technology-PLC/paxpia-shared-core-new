// Overlay data-channel wire protocol — the contract between the web/mobile
// clients and the server-side overlay bot, carried over LiveKit data packets.
//
// WHY this lives here (platform-free): web and mobile must encode/decode the
// EXACT same bytes, and the Go bot mirrors these shapes field-for-field. Keeping
// the schema + (de)serialization + aggregation in one platform-agnostic module
// means a wire change is a single-source edit, and the aggregation the streamer
// dashboard shows is computed by the identical pure function the server uses.
//
// Transport (decided — see services/overlays):
//   • LiveKit data packets on topic "overlay".
//   • Control (streamer create/activate/close/reveal/next) + viewer responses go
//     RELIABLE + ordered — these are low-frequency, must-not-drop state edits.
//   • State replay (overlay.changed) to a single joining identity goes RELIABLE
//     to that destination identity.
//   • Live results (overlay.results) broadcast is LOSSY + throttled (~500ms):
//     high-frequency, last-write-wins, a dropped tick is corrected by the next.
//
// All messages are JSON (UTF-8) for debuggability + zero codegen; the envelope's
// `t` discriminator keeps them cheap to route. A `v` version field lets us evolve
// the schema without a flag day.

import type { OverlayInstance, OverlayKind, OverlayPhase } from './types';

/** The data-channel topic the bot listens on / publishes to. */
export const OVERLAY_TOPIC = 'overlay';

/** Wire protocol version. Bump on a breaking envelope change. */
export const OVERLAY_WIRE_VERSION = 1;

// ── Direction: CLIENT → SERVER (bot) ─────────────────────────────────────────

/** Streamer control verbs. The bot is server-authoritative: it validates the
 *  sender is the room's streamer before applying control. */
export type OverlayControlAction =
  | 'create' // stage a new overlay in `draft` (not yet shown to viewers)
  | 'activate' // open the overlay for participation (draft|closed → active)
  | 'close' // stop accepting responses (active → closed); tallies freeze
  | 'reveal' // reveal answer/results (e.g. quiz correct option) (closed → revealed)
  | 'next' // advance to the next staged overlay / clear the active one
  | 'request_state'; // (any participant) ask the bot to replay current state to me

/** STREAMER control message. `overlay` is required for `create`; `overlayId` for
 *  state transitions. `request_state` needs neither (the bot replays the active
 *  overlay for the room + this identity's own prior response). */
export interface OverlayControlMsg {
  t: 'overlay.control';
  v: number;
  action: OverlayControlAction;
  /** Full instance for `create` (server assigns id/gen/timestamps if absent). */
  overlay?: OverlayInstance;
  /** Target for activate/close/reveal/next. */
  overlayId?: string;
}

/** VIEWER (or streamer) response to the active overlay — a vote/answer choice.
 *  Idempotent by (overlayId, gen, identity): re-sending the same or a different
 *  choice in the same generation does NOT change the committed vote (vote-once).
 *  `clientNonce` lets the sender match an optimistic update to its ack. */
export interface OverlayResponseMsg {
  t: 'overlay.response';
  v: number;
  overlayId: string;
  gen: number;
  /** The chosen option id (poll/quiz option, or vote-button side id). */
  choice: string;
  clientNonce?: string;
}

/** Anything a client publishes to the bot. */
export type OverlayClientMsg = OverlayControlMsg | OverlayResponseMsg;

// ── Direction: SERVER (bot) → CLIENTS ────────────────────────────────────────

/** The current active/staged overlay for a room. Broadcast on every phase change
 *  (and replayed reliably to a single identity on join/request_state). `mine` is
 *  populated ONLY on a targeted replay — the committed choice for THIS identity
 *  in the current generation, so a reload/login restores the "you voted" state.
 *  On a room-wide broadcast `mine` is omitted (it's per-identity). */
export interface OverlayStateMsg {
  t: 'overlay.changed';
  v: number;
  roomName: string;
  /** null ⇒ no active overlay (cleared / `next` with nothing staged). */
  overlay: OverlayInstance | null;
  /** This identity's committed choice for overlay.gen (targeted replay only). */
  mine?: string;
  /** True when this is a 1:1 replay to a joining/asking identity (not a bcast). */
  replay?: boolean;
}

/** Live tallies for the active overlay. Broadcast LOSSY + throttled. `tallies`
 *  is choiceId → count; `total` is the response count (sum of tallies). Carrying
 *  `gen` lets a client ignore a stray tick for a previous round. */
export interface OverlayResultsMsg {
  t: 'overlay.results';
  v: number;
  roomName: string;
  overlayId: string;
  gen: number;
  phase: OverlayPhase | 'draft' | 'revealed';
  tallies: Record<string, number>;
  total: number;
}

/** Anything the bot publishes to clients. */
export type OverlayServerMsg = OverlayStateMsg | OverlayResultsMsg;

export type OverlayWireMsg = OverlayClientMsg | OverlayServerMsg;

// ── encode / decode ──────────────────────────────────────────────────────────

// TextEncoder/TextDecoder are available in every target runtime (modern browsers,
// React Native/Hermes, Node, Go's webview), but they live in DOM/Node lib typings
// we deliberately don't pull into this platform-free package. Feature-detect via
// globalThis with a minimal local interface so the module needs no lib.dom.
interface TE {
  encode(s: string): Uint8Array;
}
interface TD {
  decode(b: Uint8Array): string;
}
type TECtor = new () => TE;
type TDCtor = new () => TD;
const g = globalThis as unknown as { TextEncoder?: TECtor; TextDecoder?: TDCtor };
const enc: TE | null = g.TextEncoder ? new g.TextEncoder() : null;
const dec: TD | null = g.TextDecoder ? new g.TextDecoder() : null;

/** Serialize a message to the bytes published over the LiveKit data channel.
 *  Stamps the wire version so the receiver can branch on it. */
export function encodeOverlayMsg(msg: OverlayWireMsg): Uint8Array {
  const withV = { ...msg, v: (msg as { v?: number }).v ?? OVERLAY_WIRE_VERSION };
  const json = JSON.stringify(withV);
  if (enc) return enc.encode(json);
  // Fallback for environments without TextEncoder (older RN): UTF-8 by hand.
  const out = new Uint8Array(json.length);
  for (let i = 0; i < json.length; i++) out[i] = json.charCodeAt(i) & 0xff;
  return out;
}

/** Parse bytes from the data channel into a typed message, or null if it isn't a
 *  well-formed overlay envelope (so a foreign payload on a shared topic is just
 *  ignored, never throws). */
export function decodeOverlayMsg(bytes: Uint8Array): OverlayWireMsg | null {
  let json: string;
  if (dec) json = dec.decode(bytes);
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
  const t = (obj as { t?: unknown }).t;
  if (typeof t !== 'string') return null;
  switch (t) {
    case 'overlay.control':
    case 'overlay.response':
    case 'overlay.changed':
    case 'overlay.results':
      return obj as OverlayWireMsg;
    default:
      return null;
  }
}

// ── pure aggregation helpers ─────────────────────────────────────────────────
// The server computes tallies from persisted rows; the client folds an optimistic
// local vote in until the authoritative results arrive. Both use these so the
// bar a streamer sees and the bar a viewer sees are computed the same way.

/** A persisted response, as the server holds it (one row per identity, latest
 *  generation wins per identity for the active round). */
export interface OverlayResponseRow {
  identity: string;
  choice: string;
}

/** Tally a set of responses into choiceId → count. One row per identity already
 *  guarantees one vote per identity; this just buckets by choice. */
export function tally(responses: readonly OverlayResponseRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of responses) out[r.choice] = (out[r.choice] ?? 0) + 1;
  return out;
}

/** Sum of all tallies (the response total). */
export function totalVotes(tallies: Record<string, number>): number {
  let n = 0;
  for (const k in tallies) n += tallies[k];
  return n;
}

/** Percentage (0..100, rounded) of `count` out of `total`. */
export function pct(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

/** Fold a not-yet-acknowledged local vote into server tallies for an optimistic
 *  view. `serverAlreadyCountsMe` true ⇒ the server tally already includes this
 *  identity (don't double count). Pure — returns a new object. */
export function withOptimisticVote(
  serverTallies: Record<string, number>,
  myChoice: string | undefined,
  serverAlreadyCountsMe: boolean,
): Record<string, number> {
  if (!myChoice || serverAlreadyCountsMe) return { ...serverTallies };
  const out = { ...serverTallies };
  out[myChoice] = (out[myChoice] ?? 0) + 1;
  return out;
}

/** Build the results message the bot broadcasts from persisted rows. Centralizing
 *  it here keeps the server's broadcast shape identical to what clients expect. */
export function buildResultsMsg(
  roomName: string,
  overlay: Pick<OverlayInstance, 'id' | 'gen'> & { phase: OverlayResultsMsg['phase'] },
  responses: readonly OverlayResponseRow[],
): OverlayResultsMsg {
  const tallies = tally(responses);
  return {
    t: 'overlay.results',
    v: OVERLAY_WIRE_VERSION,
    roomName,
    overlayId: overlay.id,
    gen: overlay.gen,
    phase: overlay.phase,
    tallies,
    total: totalVotes(tallies),
  };
}

// ── identity helpers ─────────────────────────────────────────────────────────
// The streaming service stamps LiveKit identities as `userID::kind::room::nonce`
// (see streaming sessionIdentity). For "vote once, stays voted across reload", a
// vote must be keyed on the STABLE user portion, not the per-session identity.

/** Recover the stable vote-identity from a LiveKit participant identity. A seeded
 *  user's identity is `<uuid>::view::<room>::<nonce>` → `<uuid>`; a guest is
 *  `guest-xxxx::view::...` → `guest-xxxx`; a bare id passes through unchanged. So
 *  every session of the same logged-in user collapses to one stable key. */
export function stableVoteIdentity(livekitIdentity: string): string {
  const i = livekitIdentity.indexOf('::');
  return i === -1 ? livekitIdentity : livekitIdentity.slice(0, i);
}

/** Re-export kind for callers building control messages without importing types. */
export type { OverlayKind };
