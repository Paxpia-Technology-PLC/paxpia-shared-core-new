// WATCH FEED TRANSPORT SEAM (`FeedApi`). Core declares the CONTRACT against
// `services/feed`; the platform binds the fetch impl (web fetch + CDN base, mobile
// `feedApi.ts`). All methods return normalized `WatchPost[]` (the impl runs the raw
// rows through `mapFeedVideo`), so neither client remaps. Auth lives in the impl.

import type { FeedPage, WatchPost } from './types';

/** Which feed surface to fetch. Mirrors the proto `FeedType` + the explore tabs. */
export type FeedKind = 'for_you' | 'trending' | 'following';

/** A normalized page: posts + the next cursor + whether more remain. */
export interface WatchFeedPage {
  posts: WatchPost[];
  cursor?: number | string;
  hasMore: boolean;
}

/** The feed service surface (proxied at the gateway under `/api/v1/feed`). */
export interface FeedApi {
  /** Fetch a feed page (for-you / trending / following). `cursor` continues. */
  getFeed(kind: FeedKind, opts?: { cursor?: number | string; mediaType?: 'video' | 'image' }): Promise<WatchFeedPage>;
  /** A user's own posts (profile grid). */
  getUserVideos(userId: string, opts?: { limit?: number }): Promise<WatchPost[]>;
  /** Fetch specific posts by id (liked/saved grids). */
  getVideosByIds(ids: string[]): Promise<WatchPost[]>;
  /** The caller's liked posts grid (paginated). Optional — not every platform. */
  getLiked?(opts?: { cursor?: string; limit?: number }): Promise<WatchFeedPage>;
  /** The caller's saved posts grid (paginated). Optional. */
  getSaved?(opts?: { cursor?: string; limit?: number }): Promise<WatchFeedPage>;
}

/** A page with no more results. */
export function emptyWatchFeedPage(): WatchFeedPage {
  return { posts: [], hasMore: false };
}

/** Read the cursor from a raw feed page in either of the service's two shapes
 *  (integer timeline cursor or opaque string). '' / 0 / absent ⇒ end of feed. */
export function nextCursorOf(page: FeedPage): number | string | undefined {
  return page.cursor;
}
