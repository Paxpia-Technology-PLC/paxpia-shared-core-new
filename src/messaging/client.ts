// MESSAGING TRANSPORT SEAMS — the REST contract (`MessagingApi`) + the realtime
// WebSocket client, both platform-free. Core declares the CONTRACT; each platform
// binds it (web → an axios/fetch impl + the browser `WebSocket`; mobile → its
// `messagingApi.ts` + RN `WebSocket`), exactly like `MaterialsClient` /
// `CommentsApi`. Auth lives in the impl (it holds the token + base URL), so the
// interface is token-free.

import { timers, type TimerHandle } from './timers';
import type {
  ClientFrame,
  ListMessagesResponse,
  ListThreadsResponse,
  Message,
  SendMessagePayload,
  ServerFrame,
  SubscribeCursor,
  Thread,
} from './types';

/** The REST surface the messaging service exposes through the gateway under
 *  `/api/v1/messaging/...`. All methods are async + may reject; the UI handles
 *  optimistic rollback. Returns mirror the wire shapes in ./types.ts. */
export interface MessagingApi {
  /** List the caller's conversations (cursor-paginated; 25/page default). */
  listThreads(opts?: { limit?: number; cursor?: string; includeArchived?: boolean }): Promise<ListThreadsResponse>;
  /** Fetch one thread (incl. participants). */
  getThread(threadId: string): Promise<Thread>;
  /** Create (or return the existing) DM thread with a peer user. */
  createDM(peerUserId: string): Promise<Thread>;
  /** Create a group thread. */
  createGroup(participantIds: string[], title?: string, avatarUrl?: string): Promise<Thread>;
  /** Page a thread's messages (newest first when cursor empty). */
  listMessages(threadId: string, opts?: { limit?: number; cursor?: string }): Promise<ListMessagesResponse>;
  /** Send a message of any kind. Returns the created server row. */
  sendMessage(threadId: string, payload: SendMessagePayload): Promise<Message>;
  /** Edit a text message's body. */
  editMessage(messageId: string, bodyText: string): Promise<Message>;
  /** Delete a message ("me" or "everyone"; idempotent). */
  deleteMessage(messageId: string, scope: 'me' | 'everyone'): Promise<void>;
  /** Add a reaction (one of the 8 allowed). */
  reactTo(messageId: string, reaction: string): Promise<void>;
  /** Remove a reaction. */
  unreactTo(messageId: string, reaction: string): Promise<void>;
  /** Mark a thread read up to a message id. */
  markRead(threadId: string, upToMessageId: string): Promise<void>;
  /** Mute/unmute thread notifications. */
  muteThread?(threadId: string, value: boolean): Promise<void>;
  /** Archive/unarchive a thread. */
  archiveThread?(threadId: string, value: boolean): Promise<void>;
  /** Leave a (group) thread. */
  leaveThread?(threadId: string): Promise<void>;
}

/** Generate a send idempotency key (the server dedupes on `(sender_id, key)`, so a
 *  retry after a flaky network never double-posts). Shared so web + mobile agree. */
export function genIdempotencyKey(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
