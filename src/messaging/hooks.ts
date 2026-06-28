// MESSAGING HOOKS — the ONE headless React binding over { api, socket }, returning
// the converged MessagingState + the action callbacks the shared @paxpia/ui views
// consume. React-only (no zustand/DOM/RN), so it runs identically under Vite +
// Metro — the analog of `useOverlaySession`. A platform that already has its own
// store (mobile's react-query screens) can keep it and use the pure reducers in
// ./store.ts directly; web mounts this hook.

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { MessagingApi, MessagingSocket } from './client';
import { genIdempotencyKey } from './client';
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
import type { Message, MessageKind, SendMessagePayload, ServerFrame, Thread } from './types';

// A reducer over the pure store transitions — every action is a typed dispatch so
// the React binding stays a thin shell around ./store.ts.
type Action =
  | { t: 'setThreads'; threads: Thread[] }
  | { t: 'setMessages'; threadId: string; messages: Message[]; cursor?: string }
  | { t: 'prepend'; threadId: string; messages: Message[]; cursor?: string }
  | { t: 'upsertMessage'; message: Message }
  | { t: 'removeMessage'; threadId: string; id: string }
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
  /** True when the realtime socket is connected. */
  connected: boolean;
}

/**
 * useMessaging — drives a full DM/chat surface from a `MessagingApi` (+ optional
 * realtime `MessagingSocket`). Owns the converged state via the pure reducers and
 * exposes optimistic send/react/read actions. The shared @paxpia/ui ThreadList /
 * ThreadView / Composer are pure props-driven views over this session.
 */
export function useMessaging({ api, socketFactory, selfId, autoLoadThreads = true }: UseMessagingArgs): MessagingSession {
  const [state, dispatch] = useReducer(reducer, undefined, emptyMessagingState);
  const socketRef = useRef<MessagingSocket | null>(null);
  // Keep selfId current for the frame sink without re-creating the socket.
  const selfIdRef = useRef(selfId);
  selfIdRef.current = selfId;

  // Realtime: build/start the socket with a frame sink that folds into the reducer,
  // re-subscribe to the loaded threads, and tear down on unmount.
  useEffect(() => {
    if (!socketFactory) return;
    const s = socketFactory(
      (f) => dispatch({ t: 'frame', frame: f, selfId: selfIdRef.current }),
      (v) => dispatch({ t: 'connected', value: v }),
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
      };
      dispatch({ t: 'upsertMessage', message: optimistic });
      try {
        const saved = await api.sendMessage(threadId, { ...payload, idempotency_key });
        // upsertMessage dedups by idempotency_key, swapping the optimistic row.
        dispatch({ t: 'upsertMessage', message: { ...saved, idempotency_key } });
      } catch (e) {
        dispatch({ t: 'removeMessage', threadId, id: tempId });
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

  const connected = state.connected;

  return useMemo<MessagingSession>(
    () => ({ state, loadThreads, openThread, loadOlder, sendText, send, toggleReaction, markRead, connected }),
    [state, loadThreads, openThread, loadOlder, sendText, send, toggleReaction, markRead, connected],
  );
}

/** Derive the chronologically-ordered messages for a thread (safe when unloaded). */
export function threadMessages(state: MessagingState, threadId: string | undefined): Message[] {
  return (threadId && state.messagesByThread[threadId]) || [];
}
