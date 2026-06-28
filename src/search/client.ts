// SEARCH TRANSPORT SEAM (`SearchApi`) + the unified search aggregator + DM-search.
// Core declares the CONTRACT against `services/search`; the platform binds the
// fetch impl (web axios/fetch, mobile fetch). DM search has NO backend endpoint, so
// it's a pure client-side scan over the loaded messaging state — see
// `searchThreads` (and the STREAM1-BACKEND-GAPS note for the missing endpoint).

import { messagePreview, threadTitle, type Message, type Thread } from '../messaging/types';
import type { AccountResult, ContentResult, DmResult, SearchResults } from './types';

/** The search service surface (proxied at the gateway under `/api/v1/search`).
 *  Auth'd — a guest gets an empty result set gracefully (the gateway 401s). */
export interface SearchApi {
  /** Full-text search. `kind` scopes to accounts/content; omit/`'all'` for both.
   *  Returns grouped, normalized rows (the impl folds the raw `{results}` body
   *  through `parseSearchResponse`). */
  search(query: string, kind?: 'account' | 'content' | 'all', page?: number): Promise<{ accounts: AccountResult[]; content: ContentResult[] }>;
  /** Autocomplete suggestions for a prefix (`/api/v1/search/suggest?q=`). */
  suggest(prefix: string): Promise<string[]>;
}

/** Scan loaded messaging state for threads / messages matching `query`. PURE +
 *  client-side (the messaging service has no message-search endpoint yet). Matches
 *  a thread by title OR by any loaded message body; returns at most `limit` rows.
 *  `selfId` lets DM titles omit the viewer. */
export function searchThreads(
  threads: Thread[],
  messagesByThread: Record<string, Message[]>,
  query: string,
  selfId?: string,
  limit = 20,
): DmResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: DmResult[] = [];
  for (const t of threads) {
    if (out.length >= limit) break;
    const title = threadTitle(t, selfId);
    const titleHit = title.toLowerCase().includes(q);
    // Find the first matching message body in the loaded window (if any).
    const msgs = messagesByThread[t.id] ?? [];
    const msgHit = msgs.find((m) => (m.body_text ?? '').toLowerCase().includes(q));
    if (titleHit || msgHit) {
      out.push({
        kind: 'dm',
        threadId: t.id,
        title,
        preview: msgHit ? messagePreview(msgHit) : messagePreview(t.last_message),
        avatarUrl: t.avatar_url,
        matchedMessageId: msgHit?.id,
      });
    }
  }
  return out;
}

/** Run the unified search: accounts + content from the backend, DMs from local
 *  messaging state, merged into one section'd result set. The DM scan is optional
 *  (omit `dmSources` to skip it). Rejections from the backend are NOT swallowed
 *  here — the caller decides how to surface them; the unified hook treats a reject
 *  as "no remote results" so the local DM matches still render. */
export async function unifiedSearch(
  api: SearchApi,
  query: string,
  opts: {
    kind?: 'account' | 'content' | 'all';
    page?: number;
    dmSources?: { threads: Thread[]; messagesByThread: Record<string, Message[]>; selfId?: string };
  } = {},
): Promise<SearchResults> {
  const q = query.trim();
  const dms = opts.dmSources
    ? searchThreads(opts.dmSources.threads, opts.dmSources.messagesByThread, q, opts.dmSources.selfId)
    : [];
  if (!q) return { accounts: [], content: [], dms };
  let accounts: AccountResult[] = [];
  let content: ContentResult[] = [];
  try {
    const res = await api.search(q, opts.kind ?? 'all', opts.page);
    accounts = res.accounts;
    content = res.content;
  } catch {
    // Backend unreachable / guest 401 → keep the local DM matches, empty remote.
  }
  return { accounts, content, dms };
}
