// PUBLIC streamer identity — the guest-readable name/handle/avatar a live-room or
// feed tile renders. This is the SHARED shape web + mobile map the streaming
// service's rooms payload onto, so both clients render a streamer the same way
// (and tap through to the same profile) without re-deriving it.
//
// Why a shared type: the un-mocked live grid + "For you" feed were rendering the
// streamer's raw UUID because the only client-side name lookup
// (GET /api/v1/social/profiles/{id}) is gateway-gated and 401s for guests. The
// fix is server-side — the streaming service now stamps username/display_name/
// avatar onto the PUBLIC rooms payload (see services/streaming ListActiveRooms)
// — and this type is the client-side contract for those fields. No auth needed.

export interface PublicStreamerIdentity {
  /** The streamer's stable user id (UUID). Used for profile navigation + keying.
   *  NEVER shown as the display label. */
  id: string;
  /** Public handle (no UUID). May be empty if the backend hasn't resolved it yet
   *  (e.g. a brand-new streamer with no social profile) — callers fall back to a
   *  neutral label, never the UUID. */
  username?: string;
  /** Human display name. Falls back to `username` then a neutral label. */
  displayName?: string;
  /** Public avatar URL (CDN). Absent → render an initial/placeholder. */
  avatarUrl?: string;
  /** Blue-check / approved badge. */
  isVerified?: boolean;
}

/** The raw PUBLIC identity fields as they arrive on the streaming rooms payload
 *  (snake_case, all strings — Redis-hash origin). Both web + mobile map this. */
export interface RoomStreamerFields {
  streamer?: string;
  streamer_username?: string;
  streamer_display_name?: string;
  streamer_avatar_url?: string;
  /** "true" when set; absent otherwise. */
  streamer_verified?: string;
}

/** Normalize the raw rooms-payload streamer fields into a PublicStreamerIdentity.
 *  Pure — shared by web + mobile so the mapping can't drift. */
export function streamerIdentityFromRoom(r: RoomStreamerFields): PublicStreamerIdentity {
  return {
    id: r.streamer ?? '',
    username: r.streamer_username || undefined,
    displayName: r.streamer_display_name || undefined,
    avatarUrl: r.streamer_avatar_url || undefined,
    isVerified: r.streamer_verified === 'true',
  };
}

/** The label to show as the streamer's NAME: display name → @handle → fallback.
 *  Guarantees we never surface a UUID as the visible name. */
export function streamerDisplayLabel(
  s: Pick<PublicStreamerIdentity, 'displayName' | 'username'>,
  fallback = 'Live channel',
): string {
  return s.displayName || s.username || fallback;
}

/** True when we actually have a public handle/name to render (vs. only a UUID).
 *  Surfaces use this to decide whether to show "@handle" + link to a profile. */
export function hasPublicIdentity(s: PublicStreamerIdentity): boolean {
  return !!(s.username || s.displayName);
}
