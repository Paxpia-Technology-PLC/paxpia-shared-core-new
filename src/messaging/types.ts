// MESSAGING — the DM / group-chat wire model (messaging service), lifted into
// @paxpia/core so web + mobile share ONE source of truth for the thread/message
// shapes, the 8 message kinds, and the WS-frame envelope (2026-06-28, Stream 1).
//
// This is the messaging analog of the social/comments lift: PURE types + logic
// here, the rn-web views in @paxpia/ui/messaging, and the fetch/WebSocket impl per
// platform behind `MessagingApi` + `MessagingSocketFactory`. The shapes mirror the
// messaging proto (paxpia-shared/proto/paxpia/v1/messaging.proto) and the existing
// hand-maintained `services/messaging/internal/wire/types.go` field-for-field, so
// the shared type IS the over-the-wire shape and neither client has to remap.
//
// Transport: REST through the gateway (`/api/v1/messaging/...`) + a WebSocket at
// `/api/v1/messaging/ws?token=<jwt>`. See ./client.ts for the seams.

/** The 8 message kinds the renderer dispatches on (proto `MessageKind`, snake on
 *  the JSON wire). Append-only — never reorder, never recycle a value. */
export type MessageKind =
  | 'text'
  | 'image'
  | 'video'
  | 'voice'
  | 'video_share'
  | 'room_invite'
  | 'call_log'
  | 'system';

/** The thread shapes:
 *   • 'dm'      — 1:1 direct message (exactly two participants; everyone posts).
 *   • 'group'   — many-participant chat; EVERYONE posts (owner/admin can moderate).
 *   • 'channel' — broadcast thread: only `owner`/`admin` may POST, `member` reads +
 *                 reacts. (Telegram-style.) Append-only union — never recycle. */
export type ThreadKind = 'dm' | 'group' | 'channel';

/** A participant's authority WITHIN a thread (distinct from the external staff
 *  `moderator` grant, which is not a participant role — see ./permissions.ts):
 *   • 'owner'  — the thread creator; the single un-demotable authority.
 *   • 'admin'  — a promoted participant (Telegram-style); can post in channels,
 *                delete any message, promote/demote members (not the owner).
 *   • 'member' — a regular participant; posts in dm/group, reads + reacts in a
 *                channel, deletes only their OWN messages (≤24h everyone-scope). */
export type ParticipantRole = 'owner' | 'admin' | 'member';

/** The 8-emoji reaction palette the backend enforces (wire.AllowedReactions). */
export const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉'] as const;
export type Reaction = (typeof ALLOWED_REACTIONS)[number];

export interface MediaMeta {
  width?: number;
  height?: number;
  duration_ms?: number;
  mime?: string;
  size_bytes?: number;
  thumb_url?: string;
  /** Voice-note waveform: 30–60 amplitude samples in [0,1]. Empty for non-voice. */
  waveform?: number[];
}

/** A shared feed-video card embedded in a `video_share` message (denormalised at
 *  send time so the card renders even if the underlying video is later deleted). */
export interface VideoShare {
  video_id: string;
  title?: string;
  thumb_url?: string;
  owner_user_id?: string;
  owner_display_name?: string;
  duration_ms?: number;
}

/** A "join live room" card embedded in a `room_invite` message. Denormalised
 *  fields are point-in-time; the renderer should re-check live status before
 *  showing a join button. */
export interface RoomInvite {
  room_id: string;
  room_kind?: 'room' | 'livestream' | 'call' | string;
  title?: string;
  host_user_id?: string;
  host_display_name?: string;
  host_avatar_url?: string;
  started_at_unix?: number;
  expected_participant_count?: number;
  cover_url?: string;
}

/** Summary of a voice/video call rendered as a centered chip (`call_log` kind). */
export interface CallLog {
  id: string;
  thread_id: string;
  initiator_id: string;
  kind: 'voice' | 'video' | string;
  sfu_room_id?: string;
  started_at_unix: number;
  ended_at_unix?: number;
  status: 'ringing' | 'missed' | 'declined' | 'ongoing' | 'completed' | 'failed' | string;
  duration_ms?: number;
}

export interface ReactionSummary {
  reaction: string;
  count: number;
  viewer_reacted: boolean;
}

/** A message exactly as the messaging service returns it on the wire. */
export interface Message {
  id: string;
  thread_id: string;
  sender_id: string;
  kind: MessageKind;
  body_text?: string;
  media_url?: string;
  media_meta?: MediaMeta;
  reply_to_id?: string;
  reply_to?: Message;
  video_share?: VideoShare;
  room_invite?: RoomInvite;
  call_log?: CallLog;
  created_at_unix: number;
  edited_at_unix?: number;
  deleted_for_everyone?: boolean;
  reactions_summary?: ReactionSummary[];
  idempotency_key?: string;
  /** Pinned to the top of the thread by an owner/admin (or the poster, per policy).
   *  Snake wire field: `pinned`. */
  pinned?: boolean;
  /** Moderation lifecycle, server-authoritative (mirrors messaging DB
   *  `moderation_status`): 'visible' (default), 'blocked' (a `moderator` override-
   *  deleted it — kept as a tombstone, hidden from non-staff), or 'flagged'
   *  (reported, pending review). Absent ⇒ treat as 'visible'. */
  moderation_status?: 'visible' | 'blocked' | 'flagged' | string;
  /** CLIENT-ONLY delivery state for an optimistic row (never sent to the server):
   *  'sending' while in flight, 'failed' once queued to the offline outbox. Absent
   *  on any server-returned row (which is, by definition, delivered). The UI renders
   *  this as the receipt tick / a retry affordance. */
  send_status?: 'sending' | 'failed';
}

export interface Participant {
  user_id: string;
  display_name?: string;
  avatar_url?: string;
  joined_at_unix: number;
  /** Authority within the thread. `owner` is the creator; `admin` is promoted.
   *  Widened from `admin|member` — old rows without an owner are backfilled
   *  server-side (migration 002). */
  role: ParticipantRole | string;
  last_read_message_id?: string;
  is_online?: boolean;
  last_seen_at_unix?: number;
}

export interface Thread {
  id: string;
  kind: ThreadKind;
  created_at_unix: number;
  last_message_at_unix: number;
  last_message?: Message;
  title?: string;
  avatar_url?: string;
  participants?: Participant[];
  unread_count: number;
  notification_muted?: boolean;
  is_archived?: boolean;
}

export interface ListThreadsResponse {
  threads: Thread[];
  next_cursor?: string;
}

export interface ListMessagesResponse {
  messages: Message[];
  next_cursor?: string;
}

/** The body of a send: every kind's optional fields plus a required idempotency
 *  key (the server dedupes on `(sender_id, idempotency_key)`). */
export interface SendMessagePayload {
  kind: MessageKind;
  body_text?: string;
  media_upload_id?: string;
  media_meta?: MediaMeta;
  reply_to_id?: string;
  video_share?: VideoShare;
  room_invite?: RoomInvite;
  idempotency_key: string;
}

// ─── WS frame envelopes (carried over /api/v1/messaging/ws) ──────────────────

export interface ReactionEvent {
  message_id: string;
  user_id: string;
  reaction: string;
  added: boolean;
}

export interface ReadEvent {
  thread_id: string;
  user_id: string;
  up_to_message_id: string;
}

export interface TypingEvent {
  thread_id: string;
  user_id: string;
  typing: boolean;
}

export interface PresenceEvent {
  user_id: string;
  state: string;
  last_seen_at_unix?: number;
}

/** What the server emits. `type` discriminates which optional field is set. */
export interface ServerFrame {
  type:
    | 'message'
    | 'reaction'
    | 'read'
    | 'typing'
    | 'presence'
    | 'thread_update'
    | 'call_ringing'
    | 'call_ended'
    | 'system'
    | 'heartbeat'
    | string;
  ts?: number;
  message?: Message;
  reaction?: ReactionEvent;
  read?: ReadEvent;
  typing?: TypingEvent;
  presence?: PresenceEvent;
  thread?: Thread;
  call?: CallLog;
  system_kind?: string;
}

export interface SubscribeCursor {
  thread_id: string;
  last_seen_message_id?: string;
}

/** What the client sends. */
export interface ClientFrame {
  type: 'heartbeat' | 'typing' | 'presence' | 'subscribe' | string;
  ts?: number;
  thread_id?: string;
  typing?: boolean;
  state?: string;
  cursors?: SubscribeCursor[];
}

// ─── Display helpers (pure; web + mobile share) ──────────────────────────────

/** A short one-line preview of a message for a thread row / reply pill. Pure +
 *  kind-aware; never shows a raw url. Mirrors mobile's `replyPreviewText`. */
export function messagePreview(m: Message | undefined): string {
  if (!m) return '';
  if (m.deleted_for_everyone) return 'Message deleted';
  if (m.moderation_status === 'blocked') return 'Message removed';
  switch (m.kind) {
    case 'text':
    case 'system':
      return m.body_text ?? '';
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎬 Video';
    case 'voice':
      return '🎙 Voice note';
    case 'video_share':
      return `▶︎ ${m.video_share?.title ?? 'Shared video'}`;
    case 'room_invite':
      return `🎤 ${m.room_invite?.title ?? 'Room invite'}`;
    case 'call_log':
      return '📞 Call';
    default:
      return m.body_text ?? '';
  }
}

/** The display title for a thread row: the explicit title, else the first non-self
 *  participant's display name / @handle, else a neutral fallback. `selfId` lets a
 *  DM omit the viewer from the label. Never returns a raw UUID as the name. */
export function threadTitle(t: Thread, selfId?: string): string {
  if (t.title && t.title.trim()) return t.title.trim();
  const others = (t.participants ?? []).filter((p) => p.user_id !== selfId);
  const named = others.find((p) => (p.display_name ?? '').trim());
  if (named?.display_name) return named.display_name.trim();
  const handled = others.find((p) => (p.user_id ?? '').trim());
  // Fall back to a short id slice, NEVER the full UUID as a name.
  if (handled) return `@${handled.user_id.slice(0, 8)}`;
  if (t.kind === 'group') return 'Group';
  if (t.kind === 'channel') return 'Channel';
  return 'Direct message';
}

/** The other participant in a DM (the one that isn't `selfId`), if resolvable. */
export function dmPeer(t: Thread, selfId?: string): Participant | undefined {
  if (t.kind !== 'dm') return undefined;
  return (t.participants ?? []).find((p) => p.user_id !== selfId);
}
