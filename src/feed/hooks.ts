// WATCH FEED HOOKS — headless React bindings over a `FeedApi`: an infinite watch
// feed (for-you / trending / following) and a profile/user video grid. React-only,
// so web + mobile share them; the rn-web VideoGrid / WatchFeed views in
// @paxpia/ui/feed are pure props-driven views over these.

import { useCallback, useEffect, useState } from 'react';
import type { FeedApi, FeedKind } from './client';
import type { WatchPost } from './types';

export interface UseWatchFeedArgs {
  api: FeedApi;
  kind?: FeedKind;
  mediaType?: 'video' | 'image';
  /** Auto-load the first page on mount (default true). */
  autoLoad?: boolean;
}

export interface WatchFeedSession {
  posts: WatchPost[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  /** Load the next page (append). No-op while loading or at the end. */
  loadMore: () => Promise<void>;
  /** Reload from the first page (clears the list). */
  refresh: () => Promise<void>;
}

/** useWatchFeed — an append-only paginated feed. The shared WatchFeed view calls
 *  `loadMore` near the end; `refresh` re-pulls page one. */
export function useWatchFeed({ api, kind = 'for_you', mediaType, autoLoad = true }: UseWatchFeedArgs): WatchFeedSession {
  const [posts, setPosts] = useState<WatchPost[]>([]);
  const [cursor, setCursor] = useState<number | string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (reset: boolean) => {
      if (loading) return;
      setLoading(true);
      setError(null);
      try {
        const page = await api.getFeed(kind, { cursor: reset ? undefined : cursor, mediaType });
        setPosts((prev) => {
          if (reset) return page.posts;
          // Dedup by id so an overlapping page never double-renders a post.
          const seen = new Set(prev.map((p) => p.id));
          return [...prev, ...page.posts.filter((p) => !seen.has(p.id))];
        });
        setCursor(page.cursor);
        setHasMore(page.hasMore && page.posts.length > 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [api, kind, cursor, mediaType, loading],
  );

  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    await fetchPage(false);
  }, [hasMore, loading, fetchPage]);

  const refresh = useCallback(async () => {
    setCursor(undefined);
    setHasMore(true);
    await fetchPage(true);
  }, [fetchPage]);

  useEffect(() => {
    if (autoLoad) void fetchPage(true);
    // Reset + load when the feed kind / mediaType changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, mediaType]);

  return { posts, loading, error, hasMore, loadMore, refresh };
}

export interface UseUserVideosArgs {
  api: FeedApi;
  userId: string | undefined;
  limit?: number;
}

/** useUserVideos — a user's own posts for the profile grid. */
export function useUserVideos({ api, userId, limit = 30 }: UseUserVideosArgs): {
  posts: WatchPost[];
  loading: boolean;
  error: string | null;
} {
  const [posts, setPosts] = useState<WatchPost[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!userId) {
      setPosts([]);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .getUserVideos(userId, { limit })
      .then((p) => {
        if (active) setPosts(p);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, userId, limit]);

  return { posts, loading, error };
}
