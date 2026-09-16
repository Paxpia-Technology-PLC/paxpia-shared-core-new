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

  | 'reset' // STREAM G3: authoritative FULL-ROOM round reset — bump gen, CLEAR all
  //          persisted rows for the prior round (Redis/in-memory), re-open at the new gen,
  //          and re-broadcast overlay.changed + an empty overlay.results so EVERY viewer +
  //          the streamer converge to a fresh tally. Distinct from `activate` (which the
  //          web lane overloaded for reset) so a backend bot can implement reset as a
  //          single authoritative transaction (`DEL room:overlay:gen rows`), not a re-create.

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
 *
 *  Keyed by (overlayId, gen, stable identity) — ONE row per identity per round, so
 *  a response never adds a second vote for someone who already answered.
 *
 *  LAST-CHOICE-WINS on a re-vote: re-sending a DIFFERENT choice in the same
 *  generation moves the vote (the new choice replaces the committed one; the total
 *  is unchanged). Re-sending the SAME choice is a no-op.
 *
 *  This doc used to say the opposite — "does NOT change the committed vote
 *  (vote-once)" — while `VoteSnapshot` below said last-choice-wins and
 *  `foldOptimisticTally` implemented the move. Three statements of one rule, two of
 *  them agreeing and one not; the vote-once reading was the stale one and is gone.
 *  PROVISIONAL until services/overlays confirms the bot does the same — the client
 *  now assumes the move, so a vote-once bot would disagree with every client's
 *  optimistic bar until the viewer's next authoritative tick corrected it.
 *
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
  phase: OverlayPhase;
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

/** The optimistic tally + total a voter should SEE, folding an un-acked local
 *  vote (first-vote OR re-vote/change-answer) into the server tallies. This is the
 *  ONE place the fold lives so web + mobile (and the streamer preview) compute the
 *  identical bar before the server's authoritative tick lands.
 *
 *  • No optimistic vote, or it equals the committed server choice → server tallies
 *    unchanged.
 *  • FIRST vote (no committed server choice yet) → +1 on the optimistic choice;
 *    total +1.
 *  • RE-VOTE (server already counts me on `myChoice`) → MOVE one from the old bar
 *    to the new bar (old−1, new+1); total unchanged — NEVER both-zero. The clamp
 *    guards a stale/short server tally so the old bar can't go negative.
 *
 *  Pure — returns fresh objects. `serverTotal` defaults to the sum of the tallies. */
export function foldOptimisticTally(
  serverTallies: Record<string, number>,
  myChoice: string | undefined,
  optimisticChoice: string | undefined,
  serverTotal?: number,
): { tallies: Record<string, number>; total: number } {
  const tallies = { ...serverTallies };
  let total = serverTotal ?? totalVotes(serverTallies);
  if (optimisticChoice && optimisticChoice !== myChoice) {
    if (myChoice != null) {
      // Re-vote: move one vote from the old choice to the new (net total unchanged).
      tallies[myChoice] = Math.max(0, (tallies[myChoice] ?? 0) - 1);
      tallies[optimisticChoice] = (tallies[optimisticChoice] ?? 0) + 1;
    } else {
      // First vote not yet server-counted: net +1.
      tallies[optimisticChoice] = (tallies[optimisticChoice] ?? 0) + 1;
      total += 1;
    }
  }
  return { tallies, total };
}

/** Does a results tick belong to the overlay a client currently shows? The bot is
 *  authoritative for `gen`; a client that minted a LOCAL gen (e.g. the streamer's
 *  monotonic activate counter) can lag the bot's per-id gen for a beat, which used
 *  to make the streamer dashboard DISCARD every valid tally (gens never matched →
 *  "nothing reaches the streamer"). So we match on overlay id and accept any tick
 *  whose gen is ≥ the locally-known gen (the bot only moves gen forward per id);
 *  a tick for a strictly OLDER round is still ignored. Pure. */
export function resultsMatchOverlay(
  overlay: Pick<OverlayInstance, 'id' | 'gen'> | null | undefined,
  results: Pick<OverlayResultsMsg, 'overlayId' | 'gen'> | null | undefined,
): boolean {
  if (!overlay || !results) return false;
  return results.overlayId === overlay.id && results.gen >= overlay.gen;
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


// ── Durable vote snapshot (Stream G3 — the Redis-backed authoritative tally) ──────
// The web lane self-aggregates in the streamer's TAB (an in-memory `votesByRound` Map),
// so a streamer reload / scene rebuild lost the tally and the dash desynced. The durable
// design moves the authoritative tally to a backend overlays/vote service keyed by
// `room + overlayId + gen`. This is the persisted shape that service stores (Redis hash
// `votes:{room}:{overlayId}:{gen}` = stableIdentity → choice) and REPLAYS to a (re)joining
// client — so the dash + every viewer share ONE truth that survives scene changes /
// reconnects / a streamer reload. The CLIENT contract is here so the service mirrors it
// field-for-field; the client folds a replayed snapshot exactly like a live results tick.

/** The authoritative, persistable state of ONE participation round — the value a backend
 *  vote service stores (Redis) under `room+overlayId+gen` and replays on join/reconnect.
 *  `rows` is one entry per stable identity (vote-once; last-choice-wins on re-vote), so the
 *  service can rebuild `tally(rows)` AND answer a per-identity `mine` from the SAME record.
 *  A RESET deletes the prior gen's record and writes a fresh empty one at gen+1. */

export interface VoteSnapshot {
  roomName: string;
  overlayId: string;
  gen: number;

  /** One committed vote per stable identity (the dedup key). */
  rows: OverlayResponseRow[];
}

/** A fresh, empty snapshot for a round (what a RESET writes at the new gen). Pure. */
export function emptyVoteSnapshot(roomName: string, overlayId: string, gen: number): VoteSnapshot {
  return { roomName, overlayId, gen, rows: [] };
}

/** Project a durable `VoteSnapshot` into the `overlay.results` tick clients fold — so a
 *  replayed snapshot (from Redis) and a live aggregated tick are byte-identical to the
 *  viewer's `applyVoteResults` / module `applyRemote`. The service calls this to answer a
 *  `request_state`; the in-tab web aggregator builds the same shape from `votesByRound`.
 *  Pure. */
export function resultsFromSnapshot(snap: VoteSnapshot): OverlayResultsMsg {
  const tallies = tally(snap.rows);
  return {
    t: 'overlay.results',
    v: OVERLAY_WIRE_VERSION,
    roomName: snap.roomName,
    overlayId: snap.overlayId,
    gen: snap.gen,
    phase: 'active',
    tallies,
    total: totalVotes(tallies),
  };
}

/** Recover a stable identity's committed choice from a durable snapshot (the per-viewer
 *  `mine` a targeted replay carries, so "you voted" survives a reload). Pure. */
export function mineFromSnapshot(snap: VoteSnapshot, stableIdentity: string): string | undefined {
  return snap.rows.find((r) => r.identity === stableIdentity)?.choice;

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
