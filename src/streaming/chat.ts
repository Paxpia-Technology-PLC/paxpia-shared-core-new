// Shared LIVE-CHAT model — the pure brain behind ephemeral livestream commenting.
//
// ── Why this lives in core (one source of truth, two render skins) ────────────
// The streamer DASHBOARD (web GoLive) and EVERY viewer surface (web StreamView,
// and — later — mobile) must show the SAME live comment stream and agree on its
// shape, its cap, and its wire encoding. So the model + reducer + encode/decode
// live here; web and RN are thin render layers that import the identical pieces.
//
// ── Transport (fan-out over a reliable data track) ───────────────────────────
// A comment fans out over the SAME LiveKit Room as the video, on a dedicated
// reliable data topic (CHAT_TOPIC). A VIEWER publishes a `chat.msg`; EVERYONE in
// the room (the streamer's dashboard AND all other viewers) receives it. There is
// NO backend — this chat is ephemeral; nothing is persisted. The author stamps
// their own public profile (handle/displayName/avatar) INLINE on the comment,
// because the LiveKit participant identity is only a `<uuid>::view::…` token and
// carries no name/avatar. That inline profile is also what lets the viewers model
// (viewers.ts) enrich a participant the moment they speak.
//
// RN PORTABILITY: everything here is a serializable model + pure functions (no DOM,
// no LiveKit). The transport binding (publishData / DataReceived) is per-platform.

/** Author-supplied taxonomy of a live comment row. `comment` is a normal chat
 *  line; `gift` is a deposit/gift event (rendered specially AND used to bump the
 *  sender to the top of the viewers list — see viewers.ts applyGift); `system` is
 *  a synthetic notice (joins/announcements) with no real author. */
export type LiveCommentKind = 'comment' | 'gift' | 'system';

/** One ephemeral live comment. FLAT (no nested user object) so the wire is tiny
 *  and the reducer/cap are trivial. The author profile is stamped INLINE by the
 *  publisher (the only client that knows its own handle/name/avatar):
 *   • `authorId`   stable user id (UUID) — profile-link + viewer enrichment key.
 *   • `handle`     public @handle (no UUID). Empty for a guest with no profile.
 *   • `displayName`human name. Falls back to handle, then a neutral guest label.
 *   • `avatarUrl`  CDN avatar; empty → render an initial/placeholder.
 *   • `ts`         author clock (ms). Used for ordering + the gift-bump timestamp.
 *  A `gift` row additionally carries `giftLabel` (what was sent) for rendering. */
export interface LiveComment {
  id: string;
  authorId: string;
  handle: string;
  displayName: string;
  avatarUrl: string;
  text: string;
  ts: number;
  kind: LiveCommentKind;
  /** gift only: a short label for the deposit/gift (e.g. "Rose", "500 coins"). */
  giftLabel?: string;
}

/** The display label for a comment author: displayName → @handle → neutral. Never
 *  surfaces a raw UUID (matches the streamer-identity rule in identity.ts). */
export function commentAuthorLabel(c: Pick<LiveComment, 'displayName' | 'handle'>): string {
  return c.displayName || (c.handle ? `@${c.handle}` : 'Guest');
}

// ── Ring-buffered chat log (cap the last N) ──────────────────────────────────
// Live chat is unbounded in principle; we keep only the last N rows so a long
// stream can't grow memory without bound and the list stays cheap to render.

/** How many comments to retain by default (the visible tail). */
export const CHAT_CAP = 200;

/** The chat log: the retained tail of comments, oldest→newest (append order). */
export interface ChatLog {
  comments: LiveComment[];
  cap: number;
}

/** A fresh, empty chat log (optionally with a custom cap). */
export function emptyChatLog(cap: number = CHAT_CAP): ChatLog {
  return { comments: [], cap: Math.max(1, cap) };
}

/** Append a comment, ring-buffering to the last `cap`. Idempotent on id — a
 *  re-delivered packet (same id already present) is dropped, so an at-least-once
 *  data track can't double a row. Pure — returns a new ChatLog (or `log` unchanged
 *  when the id is a duplicate). */
export function appendComment(log: ChatLog, c: LiveComment): ChatLog {
  if (log.comments.some((x) => x.id === c.id)) return log;
  const next = log.comments.length >= log.cap
    ? [...log.comments.slice(log.comments.length - log.cap + 1), c]
    : [...log.comments, c];
  return { comments: next, cap: log.cap };
}

// ── Wire message: a single ephemeral comment (reliable data track) ───────────
// Rides its OWN topic (CHAT_TOPIC), distinct from the overlay/scene topic, so the
// overlay bot never sees chat and chat decoders never see overlay control. The
// envelope mirrors the additive-`t` convention used by live-sync/scene-sync: an
// unknown `t` decodes to null and is ignored.

/** Wire version for the chat envelope. */
export const CHAT_WIRE_VERSION = 1;

/** The dedicated reliable data topic live comments fan out on. */
export const CHAT_TOPIC = 'chat';

/** A single-comment broadcast. The author publishes one per send; everyone folds
 *  it through appendComment. RELIABLE so a comment isn't silently dropped. */
export interface ChatMsg {
  t: 'chat.msg';
  v: number;
  comment: LiveComment;
}

/** True if a decoded object is a chat envelope. */
export function isChatMsg(obj: unknown): obj is ChatMsg {
  return !!obj && typeof obj === 'object' && (obj as { t?: unknown }).t === 'chat.msg';
}

// TextEncoder/TextDecoder feature-detection — same contract as scene.ts/live.ts so
// this runs on web + RN/Hermes without pulling lib.dom into the shared core.
function te(): { encode(s: string): Uint8Array } | null {
  const g = globalThis as unknown as { TextEncoder?: new () => { encode(s: string): Uint8Array } };
  return g.TextEncoder ? new g.TextEncoder() : null;
}
function td(): { decode(b: Uint8Array): string } | null {
  const g = globalThis as unknown as { TextDecoder?: new () => { decode(b: Uint8Array): string } };
  return g.TextDecoder ? new g.TextDecoder() : null;
}

/** Encode a chat message to UTF-8 JSON bytes for the (reliable) data channel.
 *  Returns a freshly-allocated (non-shared) Uint8Array, matching the publish-cast
 *  contract the web channels rely on. */
export function encodeChatMsg(msg: ChatMsg): Uint8Array {
  const withV = { ...msg, v: msg.v ?? CHAT_WIRE_VERSION };
  const json = JSON.stringify(withV);
  const enc = te();
  if (enc) return enc.encode(json);
  const out = new Uint8Array(json.length);
  for (let i = 0; i < json.length; i++) out[i] = json.charCodeAt(i) & 0xff;
  return out;
}

/** Decode bytes into a chat message, or null if they aren't one (so an overlay/
 *  scene/foreign payload that lands on this topic is ignored). */
export function decodeChatMsg(bytes: Uint8Array): ChatMsg | null {
  const dec = td();
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
  return isChatMsg(obj) ? (obj as ChatMsg) : null;
}

// ── Author helpers (mint a comment from the local user's own profile) ────────

/** The minimal local-author profile a publisher stamps onto its comments. A guest
 *  may have an empty handle/name/avatar — the label helpers degrade to "Guest". */
export interface ChatAuthor {
  id: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
}

let chatSeq = 0;
/** Mint a unique comment id (author-local; the id only needs to be unique enough
 *  to dedupe re-delivery within one session). */
function nextCommentId(authorId: string): string {
  chatSeq = (chatSeq + 1) % 1e6;
  return `c_${authorId.slice(0, 8)}_${Date.now().toString(36)}_${chatSeq.toString(36)}`;
}

/** Build a `comment` LiveComment from the local author + text. Pure-ish (uses the
 *  clock + a monotonic seq for the id). Trims text; returns null for an empty body
 *  so the caller never publishes a blank line. */
export function makeComment(author: ChatAuthor, text: string): LiveComment | null {
  const body = text.trim();
  if (!body) return null;
  return {
    id: nextCommentId(author.id),
    authorId: author.id,
    handle: author.handle ?? '',
    displayName: author.displayName ?? '',
    avatarUrl: author.avatarUrl ?? '',
    text: body,
    ts: Date.now(),
    kind: 'comment',
  };
}

/** Build a `gift` LiveComment (a deposit/gift event). Published over the SAME chat
 *  track; on receipt it appears in Comments AND bumps the sender to the top of the
 *  viewers list (viewers.ts applyGift keys off authorId + ts). `text` is the human
 *  line ("sent Rose"); `giftLabel` is the short token used for the bump rendering. */
export function makeGift(author: ChatAuthor, giftLabel: string, text?: string): LiveComment {
  return {
    id: nextCommentId(author.id),
    authorId: author.id,
    handle: author.handle ?? '',
    displayName: author.displayName ?? '',
    avatarUrl: author.avatarUrl ?? '',
    text: text ?? `sent ${giftLabel}`,
    ts: Date.now(),
    kind: 'gift',
    giftLabel,
  };
}
