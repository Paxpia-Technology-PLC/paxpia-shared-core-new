// MESSAGING HOOKS — the ONE headless React binding over { api, socket }, returning
// the converged MessagingState + the action callbacks the shared @paxpia/ui views
// consume. React-only (no zustand/DOM/RN), so it runs identically under Vite +
// Metro — the analog of `useOverlaySession`. A platform that already has its own
// store (mobile's react-query screens) can keep it and use the pure reducers in
// ./store.ts directly; web mounts this hook.

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { MessagingApi, MessagingSocket, OutboxItem, OutboxStore } from './client';
import { createMemoryOutboxStore, genIdempotencyKey } from './client';
import {
  applyServerFrame,
  emptyMessagingState,
  markThreadRead,
  prependMessages,
  removeMessage,
  setConnected,
  setMessages,
  setThreads,
  toggleReactionSummary,
  upsertMessage,
  type MessagingState,
} from './store';
import type { Message, MessageKind, ParticipantRole, SendMessagePayload, ServerFrame, Thread } from './types';

// A reducer over the pure store transitions — every action is a typed dispatch so
// the React binding stays a thin shell around ./store.ts.
type Action =
  | { t: 'setThreads'; threads: Thread[] }
  | { t: 'setMessages'; threadId: string; messages: Message[]; cursor?: string }
  | { t: 'prepend'; threadId: string; messages: Message[]; cursor?: string }
  | { t: 'upsertMessage'; message: Message }
  | { t: 'removeMessage'; threadId: string; id: string }
  | { t: 'markSendFailed'; threadId: string; id: string }
  | { t: 'frame'; frame: ServerFrame; selfId?: string }
  | { t: 'read'; threadId: string }
  | { t: 'connected'; value: boolean }
  | { t: 'reactLocal'; threadId: string; messageId: string; reaction: string; add: boolean };

function reducer(state: MessagingState, a: Action): MessagingState {
  switch (a.t) {
    case 'setThreads':
      return setThreads(state, a.threads);
    case 'setMessages':
      return setMessages(state, a.threadId, a.messages, a.cursor);
    case 'prepend':
      return prependMessages(state, a.threadId, a.messages, a.cursor);
    case 'upsertMessage':
      return upsertMessage(state, a.message);
    case 'removeMessage':
      return removeMessage(state, a.threadId, a.id);
    case 'markSendFailed': {
      const list = state.messagesByThread[a.threadId];
      if (!list) return state;
      return {
        ...state,
        messagesByThread: {
          ...state.messagesByThread,
          [a.threadId]: list.map((m) => (m.id === a.id ? { ...m, send_status: 'failed' as const } : m)),
        },
      };
    }
    case 'frame':
      return applyServerFrame(state, a.frame, a.selfId);
    case 'read':
      return markThreadRead(state, a.threadId);
    case 'connected':
      return setConnected(state, a.value);
    case 'reactLocal': {
      const list = state.messagesByThread[a.threadId];
      if (!list) return state;
      return {
        ...state,
        messagesByThread: {
          ...state.messagesByThread,
          [a.threadId]: list.map((m) =>
            m.id === a.messageId
              ? { ...m, reactions_summary: toggleReactionSummary(m.reactions_summary, a.reaction, true, a.add) }
              : m,
          ),
        },
      };
    }
    default:
      return state;
  }
}

export interface UseMessagingArgs {
  api: MessagingApi;
  /** A factory that builds a `MessagingSocket` given an `onFrame` sink (so the
   *  hook can route inbound frames into its reducer) + an `onConnected` flag sink.
   *  The platform wires the auth'd url + `makeSocket` inside the factory; the hook
   *  owns start/stop with the surface lifecycle. Omit for a REST-only binding.
   *
   *  Example (web):
   *    socketFactory={(onFrame, onConnected) => new MessagingSocket({
   *      url: messagingWsUrl(API_BASE, token), makeSocket: (u) => new WebSocket(u),
   *      onFrame, onConnected,
   *    })}
   */
  socketFactory?: (onFrame: (f: ServerFrame) => void, onConnected: (v: boolean) => void) => MessagingSocket;
  /** The signed-in user's id (drives `mine` rendering + read attribution). */
  selfId?: string;
  /** Auto-load the thread list on mount when true (default true). */
  autoLoadThreads?: boolean;
  /** Durable offline outbox for failed sends (flushed on reconnect with the SAME
   *  idempotency_key → no dup). The platform injects a KV-backed store; omitted ⇒ an
   *  in-memory store (fine for web/session + tests). */
  outbox?: OutboxStore;
}

export interface MessagingSession {
  state: MessagingState;
  /** Reload the conversation list. */
  loadThreads: () => Promise<void>;
  /** Load (replace) the first page of a thread's messages + open it. */
  openThread: (threadId: string) => Promise<void>;
  /** Load older history for a thread (scroll-up). No-op when no cursor. */
  loadOlder: (threadId: string) => Promise<void>;
  /** Send a text message (optimistic insert → server swap → rollback on error). */
  sendText: (threadId: string, bodyText: string, replyToId?: string) => Promise<void>;
  /** Send any non-text kind (caller supplies the payload sans idempotency_key). */
  send: (threadId: string, payload: Omit<SendMessagePayload, 'idempotency_key'>) => Promise<void>;
  /** Toggle a reaction (optimistic; reconciled by the WS fanout). */
  toggleReaction: (threadId: string, messageId: string, reaction: string, currentlyReacted: boolean) => Promise<void>;
  /** Mark a thread read up to a message id. */
  markRead: (threadId: string, upToMessageId: string) => Promise<void>;
  /** Delete a message (optimistic tombstone; scope 'me'|'everyone', cascade on
   *  everyone-scope by default). Authority is server-enforced (plan §1a). */
  deleteMessage: (
    threadId: string,
    messageId: string,
    opts?: { scope?: 'me' | 'everyone'; cascade?: boolean },
  ) => Promise<void>;
  /** Create (or return the existing) 1:1 DM thread with a peer user. Prepends +
   *  returns it (idempotent server-side — a repeat call yields the same thread). */
  createDM: (peerUserId: string) => Promise<Thread>;
  /** Create a group thread (creator = owner; everyone posts). Prepends + returns it. */
  createGroup: (participantIds: string[], title?: string, avatarUrl?: string) => Promise<Thread>;
  /** Create a broadcast channel (creator = owner; only owner/admin post). */
  createChannel: (participantIds: string[], title?: string, avatarUrl?: string) => Promise<Thread>;
  /** Edit an own text message's body (author only; server-enforced). Swaps the row
   *  in place (upsert by id) so the edited text + `edited_at` render immediately. */
  editMessage: (threadId: string, messageId: string, bodyText: string) => Promise<void>;
  /** Add a participant to a group/channel (owner/admin only). Refreshes the thread. */
  addMember: (threadId: string, userId: string) => Promise<void>;
  /** Remove/kick a participant (owner/admin only). Refreshes the thread. */
  removeMember: (threadId: string, userId: string) => Promise<void>;
  /** Promote a member → admin (owner/admin only). Refreshes the thread. */
  promote: (threadId: string, userId: string) => Promise<void>;
  /** Demote an admin → member (owner/admin only; owner is un-demotable server-side). */
  demote: (threadId: string, userId: string) => Promise<void>;
  /** Flush the offline outbox (queued failed sends). Called on reconnect; also
   *  exposed for a manual retry affordance. Returns the count actually sent. */
  flushOutbox: () => Promise<number>;
  /** True when the realtime socket is connected. */
  connected: boolean;
}

/**
 * useMessaging — drives a full DM/chat surface from a `MessagingApi` (+ optional
 * realtime `MessagingSocket`). Owns the converged state via the pure reducers and
 * exposes optimistic send/react/read actions. The shared @paxpia/ui ThreadList /
 * ThreadView / Composer are pure props-driven views over this session.
 */
export function useMessaging({
  api,
  socketFactory,
  selfId,
  autoLoadThreads = true,
  outbox,
}: UseMessagingArgs): MessagingSession {
  const [state, dispatch] = useReducer(reducer, undefined, emptyMessagingState);
  const socketRef = useRef<MessagingSocket | null>(null);
  // A stable outbox store for the lifetime of the surface (memory default).
  const outboxRef = useRef<OutboxStore | null>(null);
  if (outboxRef.current === null) outboxRef.current = outbox ?? createMemoryOutboxStore();
  // Keep selfId current for the frame sink without re-creating the socket.
  const selfIdRef = useRef(selfId);
  selfIdRef.current = selfId;

  // Flush the offline outbox: retry each queued send with its ORIGINAL
  // idempotency_key so a message that actually landed (lost ACK) is de-duped
  // server-side. Successes swap the optimistic row via upsertMessage (idempotency_key
  // match); still-offline items stay queued for the next reconnect. Pure over the
  // store — no throw escapes.
  const flushOutbox = useCallback(async (): Promise<number> => {
    const store = outboxRef.current!;
    const queue = store.load();
    if (queue.length === 0) return 0;
    const remaining: OutboxItem[] = [];
    let sent = 0;
    for (const item of queue) {
      try {
        const saved = await api.sendMessage(item.threadId, {
          kind: item.kind,
          body_text: item.bodyText,
          reply_to_id: item.replyToId,
          idempotency_key: item.idempotencyKey,
        });
        dispatch({ t: 'upsertMessage', message: { ...saved, idempotency_key: item.idempotencyKey } });
        sent += 1;
      } catch {
        remaining.push(item); // still offline — keep for the next reconnect
      }
    }
    store.save(remaining);
    return sent;
  }, [api]);
  const flushOutboxRef = useRef(flushOutbox);
  flushOutboxRef.current = flushOutbox;

  // Realtime: build/start the socket with a frame sink that folds into the reducer,
  // re-subscribe to the loaded threads, flush the outbox on (re)connect, and tear
  // down on unmount.
  useEffect(() => {
    if (!socketFactory) return;
    const s = socketFactory(
      (f) => dispatch({ t: 'frame', frame: f, selfId: selfIdRef.current }),
      (v) => {
        dispatch({ t: 'connected', value: v });
        // On (re)connect, drain any queued offline sends (same idempotency_key → no dup).
        if (v) void flushOutboxRef.current();
      },
    );
    socketRef.current = s;
    s.start();
    return () => {
      s.stop();
      socketRef.current = null;
    };
    // The factory is stable per surface mount; we intentionally start once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadThreads = useCallback(async () => {
    const res = await api.listThreads();
    dispatch({ t: 'setThreads', threads: res.threads ?? [] });
    // (Re)subscribe the socket to the loaded threads so fanouts arrive.
    socketRef.current?.subscribeThreads(
      (res.threads ?? []).map((th) => ({ thread_id: th.id, last_seen_message_id: th.last_message?.id })),
    );
  }, [api]);

  useEffect(() => {
    if (autoLoadThreads) void loadThreads();
  }, [autoLoadThreads, loadThreads]);

  const openThread = useCallback(
    async (threadId: string) => {
      const res = await api.listMessages(threadId, { limit: 50 });
      dispatch({ t: 'setMessages', threadId, messages: res.messages ?? [], cursor: res.next_cursor });
    },
    [api],
  );

  const loadOlder = useCallback(
    async (threadId: string) => {
      const cursor = state.cursorByThread[threadId];
      if (!cursor) return;
      const res = await api.listMessages(threadId, { limit: 50, cursor });
      dispatch({ t: 'prepend', threadId, messages: res.messages ?? [], cursor: res.next_cursor });
    },
    [api, state.cursorByThread],
  );

  const send = useCallback(
    async (threadId: string, payload: Omit<SendMessagePayload, 'idempotency_key'>) => {
      const idempotency_key = genIdempotencyKey();
      const tempId = `optimistic-${idempotency_key}`;
      const optimistic: Message = {
        id: tempId,
        thread_id: threadId,
        sender_id: selfId ?? '',
        kind: payload.kind,
        body_text: payload.body_text,
        media_meta: payload.media_meta,
        reply_to_id: payload.reply_to_id,
        video_share: payload.video_share,
        room_invite: payload.room_invite,
        created_at_unix: Math.floor(Date.now() / 1000),
        idempotency_key,
        send_status: 'sending',
      };
      dispatch({ t: 'upsertMessage', message: optimistic });
      try {
        const saved = await api.sendMessage(threadId, { ...payload, idempotency_key });
        // upsertMessage dedups by idempotency_key, swapping the optimistic row.
        dispatch({ t: 'upsertMessage', message: { ...saved, idempotency_key } });
      } catch (e) {
        // A plain TEXT send is queued to the durable outbox and retried on reconnect
        // with the SAME idempotency_key (no dup). We KEEP the optimistic row and mark
        // it 'failed' (retry affordance) rather than dropping the user's text. Media/
        // rich kinds carry an upload id we can't durably re-queue, so those roll back.
        const retryable = payload.kind === 'text';
        if (retryable) {
          const store = outboxRef.current!;
          const q = store.load();
          if (!q.some((x) => x.idempotencyKey === idempotency_key)) {
            q.push({
              threadId,
              kind: 'text',
              bodyText: payload.body_text,
              replyToId: payload.reply_to_id,
              idempotencyKey: idempotency_key,
              createdAtUnix: Math.floor(Date.now() / 1000),
            });
            store.save(q);
          }
          dispatch({ t: 'markSendFailed', threadId, id: tempId });
        } else {
          dispatch({ t: 'removeMessage', threadId, id: tempId });
        }
        throw e;
      }
    },
    [api, selfId],
  );

  const sendText = useCallback(
    (threadId: string, bodyText: string, replyToId?: string) =>
      send(threadId, { kind: 'text' as MessageKind, body_text: bodyText, reply_to_id: replyToId }),
    [send],
  );

  const toggleReaction = useCallback(
    async (threadId: string, messageId: string, reaction: string, currentlyReacted: boolean) => {
      const add = !currentlyReacted;
      dispatch({ t: 'reactLocal', threadId, messageId, reaction, add });
      try {
        if (add) await api.reactTo(messageId, reaction);
        else await api.unreactTo(messageId, reaction);
      } catch {
        // Revert on failure; a WS fanout reconciles if it actually succeeded.
        dispatch({ t: 'reactLocal', threadId, messageId, reaction, add: !add });
      }
    },
    [api],
  );

  const markRead = useCallback(
    async (threadId: string, upToMessageId: string) => {
      dispatch({ t: 'read', threadId });
      try {
        await api.markRead(threadId, upToMessageId);
      } catch {
        /* idempotent; a later read retries */
      }
    },
    [api],
  );

  const deleteMessage = useCallback(
    async (
      threadId: string,
      messageId: string,
      opts?: { scope?: 'me' | 'everyone'; cascade?: boolean },
    ) => {
      const scope = opts?.scope ?? 'everyone';
      await api.deleteMessage(messageId, { scope, cascade: opts?.cascade });
      if (scope === 'everyone') {
        // Cache-inclusive cascade (plan §1a): an everyone-scope delete may have
        // soft-deleted REPLIES too (reply_to_id == the deleted id). We can't know the
        // reply set client-side, so we INVALIDATE the thread's cache and re-page to
        // pull the tombstones — never leave a stale reply visible.
        const res = await api.listMessages(threadId, { limit: 50 });
        dispatch({ t: 'setMessages', threadId, messages: res.messages ?? [], cursor: res.next_cursor });
      } else {
        // 'me' scope only hides the row for the caller.
        dispatch({ t: 'removeMessage', threadId, id: messageId });
      }
    },
    [api],
  );

  const editMessage = useCallback(
    async (_threadId: string, messageId: string, bodyText: string) => {
      // Server returns the updated row (same id) → upsertMessage replaces it in place
      // (store dedups by id) so the new body + `edited_at` render immediately; a WS
      // fanout that races reconciles to the same row. threadId is accepted for a
      // symmetric signature with the other actions (the id alone locates the row).
      const saved = await api.editMessage(messageId, bodyText);
      dispatch({ t: 'upsertMessage', message: saved });
    },
    [api],
  );

  // Insert a freshly-created thread into state + subscribe the socket to it (so its
  // fanouts arrive). `thread_update` upserts a full thread; upsertThread reorders it
  // by last-activity. The socket subscription is best-effort (null when REST-only).
  const registerThread = useCallback((t: Thread) => {
    dispatch({ t: 'frame', frame: { type: 'thread_update', thread: t }, selfId: selfIdRef.current });
    socketRef.current?.subscribeThreads([{ thread_id: t.id, last_seen_message_id: t.last_message?.id }]);
  }, []);

  const createDM = useCallback(
    async (peerUserId: string) => {
      const t = await api.createDM(peerUserId);
      registerThread(t);
      return t;
    },
    [api, registerThread],
  );

  const createGroup = useCallback(
    async (participantIds: string[], title?: string, avatarUrl?: string) => {
      const t = await api.createGroup(participantIds, title, avatarUrl);
      registerThread(t);
      return t;
    },
    [api, registerThread],
  );

  const createChannel = useCallback(
    async (participantIds: string[], title?: string, avatarUrl?: string) => {
      const t = await api.createChannel(participantIds, title, avatarUrl);
      registerThread(t);
      return t;
    },
    [api, registerThread],
  );

  // Re-fetch a thread after a membership/role change so participants + roles refresh.
  const refreshThread = useCallback(
    async (threadId: string) => {
      const t = await api.getThread(threadId);
      dispatch({ t: 'frame', frame: { type: 'thread_update', thread: t }, selfId: selfIdRef.current });
    },
    [api],
  );

  const addMember = useCallback(
    async (threadId: string, userId: string) => {
      if (!api.addParticipant) throw new Error('addParticipant not supported by this MessagingApi');
      await api.addParticipant(threadId, userId);
      await refreshThread(threadId);
    },
    [api, refreshThread],
  );

  const removeMember = useCallback(
    async (threadId: string, userId: string) => {
      if (!api.removeParticipant) throw new Error('removeParticipant not supported by this MessagingApi');
      await api.removeParticipant(threadId, userId);
      await refreshThread(threadId);
    },
    [api, refreshThread],
  );

  const setRole = useCallback(
    async (threadId: string, userId: string, role: ParticipantRole) => {
      if (!api.setParticipantRole) throw new Error('setParticipantRole not supported by this MessagingApi');
      await api.setParticipantRole(threadId, userId, role);
      await refreshThread(threadId);
    },
    [api, refreshThread],
  );

  const promote = useCallback((threadId: string, userId: string) => setRole(threadId, userId, 'admin'), [setRole]);
  const demote = useCallback((threadId: string, userId: string) => setRole(threadId, userId, 'member'), [setRole]);

  const connected = state.connected;

  return useMemo<MessagingSession>(
    () => ({
      state,
      loadThreads,
      openThread,
      loadOlder,
      sendText,
      send,
      toggleReaction,
      markRead,
      deleteMessage,
      editMessage,
      createDM,
      createGroup,
      createChannel,
      addMember,
      removeMember,
      promote,
      demote,
      flushOutbox,
      connected,
    }),
    [
      state,
      loadThreads,
      openThread,
      loadOlder,
      sendText,
      send,
      toggleReaction,
      markRead,
      deleteMessage,
      editMessage,
      createDM,
      createGroup,
      createChannel,
      addMember,
      removeMember,
      promote,
      demote,
      flushOutbox,
      connected,
    ],
  );
}

/** Derive the chronologically-ordered messages for a thread (safe when unloaded). */
export function threadMessages(state: MessagingState, threadId: string | undefined): Message[] {
  return (threadId && state.messagesByThread[threadId]) || [];
}
