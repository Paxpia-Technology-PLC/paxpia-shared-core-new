// WATCH FEED (VOD / short-form) — the feed-service post model, lifted into
// @paxpia/core so web (which today has ONLY live streams) and mobile (which already
// has a feed) share ONE post shape + mapper + author identity (2026-06-28, Stream
// 1). The shapes mirror `services/feed/internal/models/video.go` (the JSON the feed
// service serves) + the embedded public author (`authors.go`). The platform binds
// the fetch impl behind `FeedApi` (./client.ts); the rn-web video grid + feed UI
// live in @paxpia/ui/feed.
//
// Naming: `WatchPost` (not `Video`) so it never collides with the streaming
// `Video`/`Scene` names already at the @paxpia/core barrel.

/** The PUBLIC author identity the feed service embeds on every item (resolved
 *  server-to-server from the social read-model, so it's present even for guests). */
export interface FeedAuthor {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  is_verified: boolean;
}

/** One feed item exactly as `services/feed` serves it (snake_case wire fields). */
export interface FeedVideoDoc {
  id: string;
  user_id: string;
  title?: string;
  caption?: string;
  /** "image" → still-image post (render an <Image>, never the player); "video"/""
   *  → HLS video (empty treated as video for back-compat). */
  media_type?: string;
  author?: FeedAuthor;
  /** Absolute URLs resolved server-side against the runtime CDN host. Preferred. */
  video_url?: string;
  thumbnail_url?: string;
  image_url?: string;
  /** Bare object keys (host-agnostic) — fallback when the server didn't resolve. */
  hls_key?: string;
  thumbnail_key?: string;
  image_key?: string;
  duration_seconds?: number;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  created_at?: string;
  tags?: string[] | string;
  sound_id?: string;
}

/** A page of feed items + an opaque cursor ('' / 0 ⇒ end). The feed service uses
 *  an integer cursor for the personalized timeline + a string cursor for
 *  liked/saved; we carry both shapes as `cursor`. */
export interface FeedPage {
  videos: FeedVideoDoc[];
  cursor?: number | string;
  hasMore?: boolean;
}

/** A NORMALIZED post the shared UI renders — platform-resolved media URLs + a
 *  neutral author identity (never a raw UUID as a name). The mapper keeps the bare
 *  keys so the platform can build a CDN URL when the server didn't resolve one. */
export interface WatchPost {
  id: string;
  authorId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  isVerified: boolean;
  caption: string;
  /** Resolved playable URL (HLS) for a video post; '' for an image post. */
  videoUrl: string;
  /** Resolved still URL for an image post; '' for a video post. */
  imageUrl: string;
  /** Grid cover (video poster frame OR the image itself). */
  thumbnailUrl: string;
  /** Bare keys, for a platform that resolves URLs itself. */
  videoKey: string;
  thumbnailKey: string;
  imageKey: string;
  isImage: boolean;
  durationSecs: number;
  likeCount: number;
  commentCount: number;
  viewCount: number;
  tags: string[];
  createdAt: string;
}

/** Build a CDN/storage URL from a bare object key + a bucket base. Empty key → ''.
 *  `bucketBase` is the origin under which `videos`-bucket keys resolve (web
 *  `CDN_BASE` `…/videos`, or `${STORAGE_BASE}/videos` on mobile). */
export function feedMediaUrl(bucketBase: string, key: string | undefined): string {
  if (!key) return '';
  const base = bucketBase.replace(/\/+$/, '');
  return `${base}/${key.replace(/^\/+/, '')}`;
}

function readTags(t: FeedVideoDoc['tags']): string[] {
  if (Array.isArray(t)) return t;
  if (typeof t === 'string' && t.trim()) {
    try {
      const parsed = JSON.parse(t);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Map a raw `FeedVideoDoc` → a normalized `WatchPost`. PURE — web + mobile derive
 * the SAME post from the same wire row. `bucketBase` resolves bare keys when the
 * server didn't ship absolute URLs; an `avatarFallback` (usually
 * `resolveAvatarUrl`) fills an empty author avatar deterministically.
 *
 * Image vs video: an `image` post renders as an <Image> and NEVER gets a videoUrl
 * (so a media-type-blind renderer can't feed it to the HLS player), exactly like
 * mobile's `videoToPost`.
 */
export function mapFeedVideo(
  v: FeedVideoDoc,
  bucketBase: string,
  avatarFallback?: (id: { userId?: string | null; avatarUrl?: string | null }) => string,
): WatchPost {
  const isImage = v.media_type === 'image';
  const a = v.author;
  const authorId = a?.user_id || v.user_id;

  const thumbnailUrl = v.thumbnail_url
    ? v.thumbnail_url
    : v.thumbnail_key
      ? feedMediaUrl(bucketBase, v.thumbnail_key)
      : '';

  const imageUrl = isImage
    ? v.image_url
      ? v.image_url
      : v.image_key
        ? feedMediaUrl(bucketBase, v.image_key)
        : thumbnailUrl
    : '';

  const videoUrl = isImage
    ? ''
    : v.video_url
      ? v.video_url
      : v.hls_key
        ? feedMediaUrl(bucketBase, v.hls_key)
        : '';

  const avatarUrl = avatarFallback
    ? avatarFallback({ userId: authorId, avatarUrl: a?.avatar_url })
    : a?.avatar_url || '';

  return {
    id: v.id,
    authorId,
    username: a?.username || '',
    displayName: a?.display_name || a?.username || '',
    avatarUrl,
    isVerified: a?.is_verified ?? false,
    caption: v.caption || v.title || '',
    videoUrl,
    imageUrl,
    thumbnailUrl,
    videoKey: v.hls_key || '',
    thumbnailKey: v.thumbnail_key || '',
    imageKey: v.image_key || '',
    isImage,
    durationSecs: v.duration_seconds ?? 0,
    likeCount: v.like_count ?? 0,
    commentCount: v.comment_count ?? 0,
    viewCount: v.view_count ?? 0,
    tags: readTags(v.tags),
    createdAt: v.created_at || '',
  };
}

/** Format a large count (e.g. likes) compactly: 20300 → "20.3K", 1_200_000 → "1.2M". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
