// MESSAGING STORE — the PURE conversation-state reducers (no React, no platform).
// Web + mobile fold WS frames + REST replies through the SAME convergence: ordered
// message lists per thread, dedup by id (+ idempotency_key for the optimistic→real
// swap), reaction toggle arithmetic, read-receipt zeroing, and last-message thread
// reorder. This is the messaging analog of the overlay viewer reducers + the
// social/comments optimistic reducers — lifted out of Paxpia-frontend's
// `store/messaging.ts` + mobile's `query/messaging.ts` so neither client owns the
// merge logic privately.
//
// The platform keeps a thin store wrapper (zustand on web, react-query/zustand on
// mobile) that delegates each transition here; the hooks in ./hooks.ts give a
// ready-to-use React binding for the common case.

import type { Message, ReactionSummary, ServerFrame, Thread } from './types';

/** The whole converged messaging state a client holds. Value type — fold it with
 *  the reducers below; never mutate in place. */
export interface MessagingState {
  /** Conversations, newest-activity first (sorted by `last_message_at_unix`). */
  threads: Thread[];
  /** Messages per thread, OLDEST-first (chronological display order). */
  messagesByThread: Record<string, Message[]>;
  /** Older-history pagination cursor per thread ('' / undefined ⇒ no more). */
  cursorByThread: Record<string, string | undefined>;
  /** Whether the realtime socket is currently connected. */
  connected: boolean;
}

export function emptyMessagingState(): MessagingState {
  return { threads: [], messagesByThread: {}, cursorByThread: {}, connected: false };
}

/** Sort threads newest-activity first. Pure; returns a new array. */
export function sortThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => b.last_message_at_unix - a.last_message_at_unix);
}

/** Replace the whole thread list (e.g. after `listThreads`), sorted. */
export function setThreads(state: MessagingState, threads: Thread[]): MessagingState {
  return { ...state, threads: sortThreads(threads) };
}

/** Upsert a thread (full or partial). A partial for an UNKNOWN thread is dropped
 *  (no baseline to merge against — a `listThreads` refresh pulls it in). Reorders
 *  by last-activity. Mirrors the web store's `upsertThread`. */
export function upsertThread(
  state: MessagingState,
  patch: Partial<Thread> & { id: string },
): MessagingState {
  const idx = state.threads.findIndex((t) => t.id === patch.id);
  let next: Thread[];
  if (idx === -1) {
    if (!patch.kind || patch.created_at_unix === undefined) return state;
    next = [patch as Thread, ...state.threads];
  } else {
    next = state.threads.slice();
    next[idx] = { ...next[idx], ...patch };
  }
  return { ...state, threads: sortThreads(next) };
}

/** Replace the message list for a thread (e.g. first page load), keeping it
 *  oldest-first. `messages` may arrive newest- or oldest-first; we sort by
 *  `created_at_unix` so callers needn't care. */
export function setMessages(
  state: MessagingState,
  threadId: string,
  messages: Message[],
  cursor?: string,
): MessagingState {
  return {
    ...state,
    messagesByThread: { ...state.messagesByThread, [threadId]: sortMessages(messages) },
    cursorByThread: { ...state.cursorByThread, [threadId]: cursor },
  };
}

/** Prepend a page of OLDER messages to a thread (history scroll-up). */
export function prependMessages(
  state: MessagingState,
  threadId: string,
  older: Message[],
  cursor?: string,
): MessagingState {
  const existing = state.messagesByThread[threadId] ?? [];
  const merged = dedupById([...older, ...existing]);
  return {
    ...state,
    messagesByThread: { ...state.messagesByThread, [threadId]: sortMessages(merged) },
    cursorByThread: { ...state.cursorByThread, [threadId]: cursor },
  };
}

/** Insert / update one message in its thread, deduping by id AND by
 *  idempotency_key (so an optimistic row is replaced by the server row, and a WS
 *  fanout that races the REST reply doesn't double-insert). Bumps the thread's
 *  last-message + reorders. Idempotent + monotonic by created_at. */
export function upsertMessage(state: MessagingState, m: Message): MessagingState {
  const list = state.messagesByThread[m.thread_id] ?? [];
  // Match an existing row by id, or by a shared idempotency_key (optimistic swap).
  const idx = list.findIndex(
    (x) =>
      x.id === m.id ||
      (!!m.idempotency_key && x.idempotency_key === m.idempotency_key) ||
      (x.id.startsWith('optimistic-') && !!m.idempotency_key && x.idempotency_key === m.idempotency_key),
  );
  let next: Message[];
  if (idx === -1) next = [...list, m];
  else {
    next = list.slice();
    next[idx] = m;
  }
  const withMsgs: MessagingState = {
    ...state,
    messagesByThread: { ...state.messagesByThread, [m.thread_id]: sortMessages(next) },
  };
  // Reflect the new last message on the thread row (only if it's newer).
  const t = withMsgs.threads.find((x) => x.id === m.thread_id);
  if (t && m.created_at_unix >= t.last_message_at_unix) {
    return upsertThread(withMsgs, {
      id: m.thread_id,
      last_message: m,
      last_message_at_unix: m.created_at_unix,
    });
  }
  return withMsgs;
}

/** Remove an optimistic (or any) message by id from its thread (send rollback). */
export function removeMessage(state: MessagingState, threadId: string, id: string): MessagingState {
  const list = state.messagesByThread[threadId];
  if (!list) return state;
  return {
    ...state,
    messagesByThread: { ...state.messagesByThread, [threadId]: list.filter((m) => m.id !== id) },
  };
}

/** Toggle a reaction in a message's summary (add/remove + count arithmetic).
 *  `byViewer` marks the change as the current viewer's own (sets/clears
 *  `viewer_reacted`); a WS fanout from another user passes `byViewer=false`.
 *  Centralised so optimistic + fanout paths stay consistent (mirrors mobile's
 *  `toggleReactionInSummary`). PURE. */
export function toggleReactionSummary(
  summary: ReactionSummary[] | undefined,
  reaction: string,
  byViewer: boolean,
  add: boolean,
): ReactionSummary[] {
  const next = [...(summary ?? [])];
  const idx = next.findIndex((r) => r.reaction === reaction);
  if (add) {
    if (idx >= 0) {
      const wasMine = next[idx].viewer_reacted;
      next[idx] = {
        ...next[idx],
        count: next[idx].count + (byViewer && wasMine ? 0 : 1),
        viewer_reacted: byViewer ? true : next[idx].viewer_reacted,
      };
    } else {
      next.push({ reaction, count: 1, viewer_reacted: byViewer });
    }
  } else if (idx >= 0) {
    const count = Math.max(0, next[idx].count - 1);
    if (count === 0) next.splice(idx, 1);
    else next[idx] = { ...next[idx], count, viewer_reacted: byViewer ? false : next[idx].viewer_reacted };
  }
  return next;
}

/** Apply a reaction event (own or remote) to whichever thread holds the message. */
export function applyReaction(
  state: MessagingState,
  messageId: string,
  reaction: string,
  added: boolean,
  byViewer = false,
): MessagingState {
  const updated: Record<string, Message[]> = {};
  let touched = false;
  for (const [tid, list] of Object.entries(state.messagesByThread)) {
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx === -1) {
      updated[tid] = list;
      continue;
    }
    touched = true;
    const nl = list.slice();
    nl[idx] = { ...nl[idx], reactions_summary: toggleReactionSummary(nl[idx].reactions_summary, reaction, byViewer, added) };
    updated[tid] = nl;
  }
  return touched ? { ...state, messagesByThread: updated } : state;
}

/** Mark a message tombstoned (deleted-for-everyone) in its thread. */
export function applyDelete(state: MessagingState, threadId: string, messageId: string): MessagingState {
  const list = state.messagesByThread[threadId];
  if (!list) return state;
  return {
    ...state,
    messagesByThread: {
      ...state.messagesByThread,
      [threadId]: list.map((m) => (m.id === messageId ? { ...m, deleted_for_everyone: true, body_text: '' } : m)),
    },
  };
}

/** Zero a thread's unread count (after the viewer reads up to the latest). */
export function markThreadRead(state: MessagingState, threadId: string): MessagingState {
  const idx = state.threads.findIndex((t) => t.id === threadId);
  if (idx === -1) return state;
  const next = state.threads.slice();
  next[idx] = { ...next[idx], unread_count: 0 };
  return { ...state, threads: next };
}

/** Fold ONE inbound `ServerFrame` into the converged state. The single ingest the
 *  socket layer calls — idempotent, so a duplicate frame is a no-op. `selfId` lets
 *  a reaction/read from the current user be attributed as the viewer's own. */
export function applyServerFrame(state: MessagingState, frame: ServerFrame, selfId?: string): MessagingState {
  switch (frame.type) {
    case 'message': {
      if (!frame.message) return state;
      let next = upsertMessage(state, frame.message);
      // Bump the thread even when it isn't loaded yet (partial upsert is dropped
      // safely by upsertThread; a listThreads refresh will baseline it).
      next = upsertThread(next, {
        id: frame.message.thread_id,
        last_message: frame.message,
        last_message_at_unix: frame.message.created_at_unix,
      });
      return next;
    }
    case 'reaction':
      if (!frame.reaction) return state;
      return applyReaction(
        state,
        frame.reaction.message_id,
        frame.reaction.reaction,
        frame.reaction.added,
        !!selfId && frame.reaction.user_id === selfId,
      );
    case 'read':
      // A read receipt for OUR own up-to clears our unread; others' are presence
      // niceties we don't surface yet.
      if (frame.read && (!selfId || frame.read.user_id === selfId)) {
        return markThreadRead(state, frame.read.thread_id);
      }
      return state;
    case 'thread_update':
      return frame.thread ? upsertThread(state, frame.thread) : state;
    case 'presence': {
      // Flip a peer's online marker across every thread they're in. Typing is
      // surfaced by the socket layer per open thread, not the converged store.
      if (!frame.presence) return state;
      const pr = frame.presence;
      let touched = false;
      const next = state.threads.map(t => {
        if (!t.participants?.some(p => p.user_id === pr.user_id)) return t;
        touched = true;
        return {
          ...t,
          participants: t.participants.map(p =>
            p.user_id === pr.user_id
              ? { ...p, is_online: pr.state === 'online', last_seen_at_unix: pr.last_seen_at_unix ?? p.last_seen_at_unix }
              : p,
          ),
        };
      });
      return touched ? { ...state, threads: next } : state;
    }
    case 'heartbeat':
    case 'typing':
    default:
      return state;
  }
}

/** Set the socket-connected flag. */
export function setConnected(state: MessagingState, connected: boolean): MessagingState {
  return state.connected === connected ? state : { ...state, connected };
}

// ─── internal helpers ────────────────────────────────────────────────────────

function sortMessages(messages: Message[]): Message[] {
  return dedupById(messages).sort((a, b) => a.created_at_unix - b.created_at_unix);
}

function dedupById(messages: Message[]): Message[] {
  const seen = new Set<string>();
  const out: Message[] = [];
  // Keep the LAST occurrence of each id (later folds win), so iterate in reverse.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out.reverse();
}
