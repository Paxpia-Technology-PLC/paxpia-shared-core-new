// Deterministic avatar URL resolution (shared web + mobile).
//
// Avatars are self-hosted in the `videos` bucket at the CONVENTION key
// `avatars/<userId>.<ext>` (the standing "never hotlink — write avatars to our
// own MinIO/CDN" rule) and served at `<bucketBase>/avatars/<userId>.<ext>`.
//
// WHY THIS EXISTS: the backend read-model SHOULD stamp that URL onto every
// profile's `avatar_url`, but in practice it ships it EMPTY for most users (a
// reseed clears the column even though the image object still exists in the
// bucket — verified: the object 200s at `…/videos/avatars/<id>.png` while the
// feed/profile API returns `avatar_url: ""`). Web's personas already worked
// around this by building `${CDN_BASE}/avatars/<id>.png` directly
// (Paxpia-web/src/data/personas.ts). This lifts that into ONE shared resolver so
// web AND mobile fall back to the deterministic object path instead of rendering
// an empty initial circle. When the backend column IS populated, the explicit
// value always wins, so this is purely additive.

export interface AvatarIdentity {
  /** Stable user id (UUID). The avatar object key is `avatars/<userId>.<ext>`. */
  userId?: string | null;
  /** The explicit `avatar_url` from the backend, if any. Wins when non-empty. */
  avatarUrl?: string | null;
}

// Observed extensions in the bucket (mostly png, some jpg). Ordered by frequency
// so the first deterministic guess is the most likely to hit (png).
export const AVATAR_EXTS = ['png', 'jpg'] as const;

function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/** Make a stored avatar value absolute. The DB now persists a HOST-LESS object
 *  path (`avatars/<id>.png`) — the standing rule "never store an absolute CDN URL"
 *  — so the client supplies the host here by prefixing the CDN bucket base. An
 *  already-absolute value (legacy rows, external URLs, data:/blob:) is returned
 *  untouched, so this is backward-compatible during the relative migration. */
function absolutizeAvatar(value: string, bucketBase: string): string {
  if (/^(https?:)?\/\//i.test(value) || value.startsWith('data:') || value.startsWith('blob:')) return value;
  if (!bucketBase) return value;
  return `${trimBase(bucketBase)}/${value.replace(/^\/+/, '')}`;
}

/** The conventional object URL for a user's avatar at a given extension. */
export function avatarObjectUrl(bucketBase: string, userId: string, ext: string = 'png'): string {
  return `${trimBase(bucketBase)}/avatars/${userId}.${ext}`;
}

/**
 * Resolve the best avatar URL for an identity:
 *   1. the explicit `avatarUrl` when present (already absolute), else
 *   2. the deterministic `<bucketBase>/avatars/<userId>.png` when a userId + base
 *      are available, else
 *   3. '' (the caller renders an initial / placeholder).
 * `bucketBase` is the origin under which `videos`-bucket keys resolve — the web
 * `CDN_BASE` (`…/videos`) or the mobile `${STORAGE_BASE_URL}/videos`.
 */
export function resolveAvatarUrl(id: AvatarIdentity, bucketBase: string): string {
  const explicit = (id.avatarUrl ?? '').trim();
  if (explicit) return absolutizeAvatar(explicit, bucketBase);
  const uid = (id.userId ?? '').trim();
  if (uid && bucketBase) return avatarObjectUrl(bucketBase, uid, 'png');
  return '';
}

/**
 * The ordered candidate URLs to try for an avatar (explicit first, then the
 * deterministic png → jpg object paths), for an `<Image>`/`<img>` onError
 * extension-fallback chain. Empty when there is neither an explicit url nor a
 * userId+base. Deduped so an explicit url that equals a candidate isn't retried.
 */
export function avatarUrlCandidates(id: AvatarIdentity, bucketBase: string): string[] {
  const explicit = (id.avatarUrl ?? '').trim();
  const uid = (id.userId ?? '').trim();
  const out: string[] = [];
  if (explicit) out.push(absolutizeAvatar(explicit, bucketBase));
  if (uid && bucketBase) {
    for (const e of AVATAR_EXTS) {
      const u = avatarObjectUrl(bucketBase, uid, e);
      if (!out.includes(u)) out.push(u);
    }
  }
  return out;
}
