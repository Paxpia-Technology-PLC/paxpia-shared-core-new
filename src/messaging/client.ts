// MESSAGING TRANSPORT SEAMS — the REST contract (`MessagingApi`) + the realtime
// WebSocket client, both platform-free. Core declares the CONTRACT; each platform
// binds it (web → an axios/fetch impl + the browser `WebSocket`; mobile → its
// `messagingApi.ts` + RN `WebSocket`), exactly like `MaterialsClient` /
// `CommentsApi`. Auth lives in the impl (it holds the token + base URL), so the
// interface is token-free.

import { timers, type TimerHandle } from './timers';
import type { DeleteScope } from './permissions';
import type {
  ClientFrame,
  ListMessagesResponse,
  ListThreadsResponse,
  Message,
  ParticipantRole,
  SendMessagePayload,
  ServerFrame,
  SubscribeCursor,
  Thread,
} from './types';

/** Read-side options carried on list/get. `asModerator` requests the STEALTH read
 *  path (plan §1a/§1d): a staff `moderator` reads any dm/group/channel WITHOUT being
 *  a participant and WITHOUT emitting read-receipt / presence side-effects. The impl
 *  forwards this to the server (which honors it only when the caller actually holds
 *  the `moderator` grant); a non-staff caller passing it gets a normal 403/empty. */
export interface ReadOptions {
  asModerator?: boolean;
}

/** Options for a delete: the `scope` ('me' vs 'everyone') and whether an everyone-
 *  scope delete CASCADES to replies (soft-deletes messages whose `reply_to_id` == the
 *  deleted id). Cascade defaults ON for everyone-scope server-side; pass `cascade:
 *  false` to opt out where the contract allows. */
export interface DeleteMessageOptions {
  scope: DeleteScope;
  /** Cascade the soft-delete to replies (everyone-scope only). Default: true. */
  cascade?: boolean;
}

/** The REST surface the messaging service exposes through the gateway under
 *  `/api/v1/messaging/...`. All methods are async + may reject; the UI handles
 *  optimistic rollback. Returns mirror the wire shapes in ./types.ts. */
export interface MessagingApi {
  /** List the caller's conversations (cursor-paginated; 25/page default). Pass
   *  `read.asModerator` for the staff stealth read (all threads, no side-effects). */
  listThreads(
    opts?: { limit?: number; cursor?: string; includeArchived?: boolean },
    read?: ReadOptions,
  ): Promise<ListThreadsResponse>;
  /** Fetch one thread (incl. participants). `read.asModerator` bypasses the
   *  participant gate for staff (stealth). */
  getThread(threadId: string, read?: ReadOptions): Promise<Thread>;
  /** Create (or return the existing) DM thread with a peer user. */
  createDM(peerUserId: string): Promise<Thread>;
  /** Create a group thread (creator row = `role='owner'`; everyone posts). */
  createGroup(participantIds: string[], title?: string, avatarUrl?: string): Promise<Thread>;
  /** Create a broadcast CHANNEL (creator = `owner`; only owner/admin post). Same
   *  wire endpoint as createGroup with `kind:'channel'` — see plan §1b. */
  createChannel(participantIds: string[], title?: string, avatarUrl?: string): Promise<Thread>;
  /** Page a thread's messages (newest first when cursor empty). `read.asModerator`
   *  bypasses the participant gate + suppresses read-receipt writes (stealth). */
  listMessages(
    threadId: string,
    opts?: { limit?: number; cursor?: string },
    read?: ReadOptions,
  ): Promise<ListMessagesResponse>;
  /** Send a message of any kind. Returns the created server row. */
  sendMessage(threadId: string, payload: SendMessagePayload): Promise<Message>;
  /** Edit a text message's body. */
  editMessage(messageId: string, bodyText: string): Promise<Message>;
  /** Delete a message (idempotent). `opts.scope` = 'me' | 'everyone'; an
   *  everyone-scope delete CASCADES to replies unless `opts.cascade === false`.
   *  Authority is server-enforced per plan §1a (poster ≤24h / owner|admin / moderator). */
  deleteMessage(messageId: string, opts: DeleteMessageOptions): Promise<void>;
  /** Add a reaction (one of the 8 allowed). */
  reactTo(messageId: string, reaction: string): Promise<void>;
  /** Remove a reaction. */
  unreactTo(messageId: string, reaction: string): Promise<void>;
  /** Mark a thread read up to a message id. */
  markRead(threadId: string, upToMessageId: string): Promise<void>;
  /** Add a participant to a group/channel (owner/admin only, server-enforced). */
  addParticipant?(threadId: string, userId: string): Promise<void>;
  /** Remove/kick a participant (owner/admin only). */
  removeParticipant?(threadId: string, userId: string): Promise<void>;
  /** Promote/demote a participant's role. Caller must be owner/admin; the owner is
   *  un-demotable (plan §1b). Emits a `system` message ("X promoted Y"). */
  setParticipantRole?(threadId: string, userId: string, role: ParticipantRole): Promise<void>;
  /** Mute/unmute thread notifications. */
  muteThread?(threadId: string, value: boolean): Promise<void>;
  /** Archive/unarchive a thread. */
  archiveThread?(threadId: string, value: boolean): Promise<void>;
  /** Leave a (group/channel) thread. */
  leaveThread?(threadId: string): Promise<void>;
}

/** Generate a send idempotency key (the server dedupes on `(sender_id, key)`, so a
 *  retry after a flaky network never double-posts). Shared so web + mobile agree. */
export function genIdempotencyKey(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Offline outbox (platform-free persistence seam) ─────────────────────────
//
// A send that fails while offline is queued here and flushed on reconnect. The
// SAME idempotency_key rides the retry, so a message that actually landed (but whose
// ACK we lost) is de-duped server-side — never double-posted. Persistence is the
// platform's concern (mobile: MMKV/AsyncStorage; web: localStorage; tests: memory),
// so core takes an injectable store and ships an in-memory default. Platform-free.

/** One queued send awaiting a flush. Mirrors mobile's `OutboxItem`. */
export interface OutboxItem {
  threadId: string;
  kind: SendMessagePayload['kind'];
  bodyText?: string;
  replyToId?: string;
  idempotencyKey: string;
  createdAtUnix: number;
}

/** The persistence seam for the offline outbox. Synchronous (a small JSON blob), so
 *  the flush loop stays simple. The platform binds a durable KV; core defaults to
 *  {@link createMemoryOutboxStore} (fine for web/session + tests). */
export interface OutboxStore {
  load(): OutboxItem[];
  save(items: OutboxItem[]): void;
}

/** An in-memory {@link OutboxStore} (default). No durability across reloads — the
 *  platform swaps in a KV-backed store for that. Pure + dependency-free. */
export function createMemoryOutboxStore(): OutboxStore {
  let items: OutboxItem[] = [];
  return {
    load: () => items.slice(),
    save: (next) => {
      items = next.slice();
    },
  };
}

// ─── Realtime WebSocket client (platform-agnostic) ───────────────────────────
//
// The browser `WebSocket` and React Native's `WebSocket` share the same minimal
// surface; we depend ONLY on that surface (an injected factory builds one from a
// url) so this client runs identically under Vite + Metro. The platform supplies
// `makeSocket(url)` (usually `(u) => new WebSocket(u)`) and the auth'd `wsUrl`
// (which carries `?token=`). This is the messaging analog of the OverlayTransport
// seam: core owns the protocol (subscribe/heartbeat/presence + frame decode +
// backoff reconnect), the platform owns only the socket construction.

/** The minimal WebSocket surface this client needs (browser + RN both satisfy). The
 *  handler slots accept an optional event arg so assigning a browser `WebSocket`
 *  (whose handlers receive an `Event`) is type-compatible — we just ignore the arg. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  readyState: number;
}

export type MessagingSocketFactory = (url: string) => SocketLike;

const WS_OPEN = 1; // WebSocket.OPEN
const WS_CONNECTING = 0; // WebSocket.CONNECTING

export interface MessagingSocketOptions {
  /** The full auth'd ws(s):// URL (already carrying `?token=`). */
  url: string;
  /** Build a socket from a url (`(u) => new WebSocket(u)` on both platforms). */
  makeSocket: MessagingSocketFactory;
  /** Notified for every content frame (heartbeats are swallowed internally). */
  onFrame: (frame: ServerFrame) => void;
  /** Optional connection-state callback. */
  onConnected?: (connected: boolean) => void;
  /** Heartbeat cadence (server drops after ~90s silence; 25s keeps it warm). */
  heartbeatMs?: number;
  /** Max reconnect backoff. */
  maxBackoffMs?: number;
}

/**
 * MessagingSocket — the ONE realtime client web + mobile share. Opens the socket,
 * re-subscribes + re-announces presence on (re)connect, swallows heartbeats,
 * decodes frames to the shared `ServerFrame`, and reconnects with capped
 * exponential backoff. Lifted from mobile's `realtime/messagingSocket.ts` + web's
 * `useMessagingSocket.ts` so the protocol lives once.
 */
export class MessagingSocket {
  private ws: SocketLike | null = null;
  private backoffMs = 1000;
  private reconnectTimer: TimerHandle | null = null;
  private heartbeatTimer: TimerHandle | null = null;
  private cursors: SubscribeCursor[] = [];
  private wantOpen = false;
  private readonly heartbeatMs: number;
  private readonly maxBackoffMs: number;

  constructor(private readonly opts: MessagingSocketOptions) {
    this.heartbeatMs = opts.heartbeatMs ?? 25_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  }

  /** Open the socket (idempotent). Call when entering the Messages surface. */
  start(): void {
    this.wantOpen = true;
    if (this.ws && (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CONNECTING)) return;
    const ws = this.opts.makeSocket(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 1000;
      this.opts.onConnected?.(true);
      if (this.cursors.length > 0) this.send({ type: 'subscribe', cursors: this.cursors });
      this.send({ type: 'presence', state: 'online' });
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === 'heartbeat') return;
      this.opts.onFrame(frame);
    };
    ws.onclose = () => {
      this.stopHeartbeat();
      this.opts.onConnected?.(false);
      if (this.wantOpen) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows; backoff handled there */
    };
  }

  /** Close + stop reconnecting. Call when leaving the Messages surface. */
  stop(): void {
    this.wantOpen = false;
    if (this.reconnectTimer) {
      timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  /** Subscribe to threads so the hub knows which fanouts to deliver. */
  subscribeThreads(cursors: SubscribeCursor[]): void {
    this.cursors = cursors;
    this.send({ type: 'subscribe', cursors });
  }

  /** Send a typing indicator. */
  setTyping(threadId: string, typing: boolean): void {
    this.send({ type: 'typing', thread_id: threadId, typing });
  }

  /** Announce presence. */
  setPresence(state: 'online' | 'away' | 'offline'): void {
    this.send({ type: 'presence', state });
  }

  private send(frame: ClientFrame): void {
    if (this.ws && this.ws.readyState === WS_OPEN) this.ws.send(JSON.stringify(frame));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = timers.setInterval(() => {
      this.send({ type: 'heartbeat', ts: Math.floor(Date.now() / 1000) });
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      timers.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantOpen) this.start();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }
}

/** Build the messaging WS URL from an http(s) API base + a JWT. Shared so web +
 *  mobile derive the same `ws(s)://…/api/v1/messaging/ws?token=` endpoint. */
export function messagingWsUrl(httpBase: string, token?: string): string {
  const ws = httpBase.replace(/^http/i, 'ws').replace(/\/+$/, '');
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${ws}/api/v1/messaging/ws${q}`;
}
