// SEARCH — the unified search domain (accounts + content + DMs), lifted into
// @paxpia/core so web + mobile share ONE result model + transport seam (2026-06-28,
// Stream 1). The backend `services/search` (OpenSearch) covers ACCOUNTS (users) and
// CONTENT (videos) via `GET /api/v1/search?q=&type=user|video` + a `/suggest`
// autocomplete; DMs/threads are searched CLIENT-SIDE over the loaded messaging
// state (no backend message-search endpoint — see ./client.ts and the
// STREAM1-BACKEND-GAPS note). The shapes mirror `services/search/internal/indexer`.

/** The category a search result belongs to. The search bar can scope to one or
 *  show all three interleaved (accounts → DMs → content), like the mockup. */
export type SearchResultKind = 'account' | 'content' | 'dm';

/** indexer.UserDoc — the user document the search service indexes/returns. */
export interface SearchUserDoc {
  id: string;
  username: string;
  avatar_url: string;
  bio: string;
}

/** indexer.VideoDoc (the fields a result row reads). */
export interface SearchVideoDoc {
  id: string;
  user_id: string;
  title: string;
  thumbnail_key: string;
  hls_key: string;
  like_count?: number;
  view_count?: number;
  created_at?: string;
}

/** A raw hit straight off `GET /api/v1/search`: a typed doc + relevance score. */
export interface SearchHit {
  type: 'video' | 'user';
  score: number;
  doc: SearchUserDoc | SearchVideoDoc;
}

interface RawSearchResponse {
  results?: SearchHit[];
  page?: number;
}

/** A NORMALIZED account result row the shared UI renders (never a raw UUID name).
 *  `avatarUrl` may be empty — the platform applies `resolveAvatarUrl` at the edge. */
export interface AccountResult {
  kind: 'account';
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  bio: string;
  isVerified: boolean;
  score: number;
}

/** A NORMALIZED content (video) result row. `thumbnailUrl`/`videoUrl` are built by
 *  the platform from the bare keys + its CDN base (kept out of core so the host
 *  origin stays a platform config), so core carries the keys. */
export interface ContentResult {
  kind: 'content';
  videoId: string;
  ownerUserId: string;
  title: string;
  thumbnailKey: string;
  hlsKey: string;
  likeCount: number;
  viewCount: number;
  score: number;
}

/** A NORMALIZED DM/thread result row (matched client-side over messaging state). */
export interface DmResult {
  kind: 'dm';
  threadId: string;
  title: string;
  /** A short preview of the matching message / last message. */
  preview: string;
  avatarUrl?: string;
  /** The message id that matched (when the match is a message body, not the title). */
  matchedMessageId?: string;
}

export type SearchResult = AccountResult | ContentResult | DmResult;

/** A grouped result set the search UI can render section-by-section. */
export interface SearchResults {
  accounts: AccountResult[];
  content: ContentResult[];
  dms: DmResult[];
}

export function emptySearchResults(): SearchResults {
  return { accounts: [], content: [], dms: [] };
}

/** Map a raw `SearchHit` to a normalized result row, or null if its type is
 *  unexpected. The search index carries only id/username/avatar/bio for users —
 *  display name + verification aren't indexed, so they fall back to neutral
 *  defaults (displayName ← username so a row never renders blank). */
export function normalizeHit(hit: SearchHit): SearchResult | null {
  if (hit.type === 'user') {
    const d = hit.doc as SearchUserDoc;
    return {
      kind: 'account',
      userId: d.id,
      username: d.username,
      displayName: d.username || `@${(d.id || '').slice(0, 8)}`,
      avatarUrl: d.avatar_url || '',
      bio: d.bio || '',
      isVerified: false,
      score: hit.score,
    };
  }
  if (hit.type === 'video') {
    const d = hit.doc as SearchVideoDoc;
    return {
      kind: 'content',
      videoId: d.id,
      ownerUserId: d.user_id,
      title: d.title || 'Untitled',
      thumbnailKey: d.thumbnail_key || '',
      hlsKey: d.hls_key || '',
      likeCount: d.like_count ?? 0,
      viewCount: d.view_count ?? 0,
      score: hit.score,
    };
  }
  return null;
}

/** Group + sort raw hits into the section'd result set the UI renders. Accounts +
 *  content sort by descending score. PURE. */
export function groupHits(hits: SearchHit[]): { accounts: AccountResult[]; content: ContentResult[] } {
  const accounts: AccountResult[] = [];
  const content: ContentResult[] = [];
  for (const h of hits) {
    const r = normalizeHit(h);
    if (r?.kind === 'account') accounts.push(r);
    else if (r?.kind === 'content') content.push(r);
  }
  accounts.sort((a, b) => b.score - a.score);
  content.sort((a, b) => b.score - a.score);
  return { accounts, content };
}

/** Parse the search service's `{results, page}` body into grouped rows. Tolerant
 *  of a null/absent `results` array (guest 401 → empty). */
export function parseSearchResponse(body: unknown): { accounts: AccountResult[]; content: ContentResult[] } {
  const b = (body ?? {}) as RawSearchResponse;
  return groupHits(b.results ?? []);
}
