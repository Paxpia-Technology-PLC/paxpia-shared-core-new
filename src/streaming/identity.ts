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

// ── STREAM-BY-USERNAME (client-side resolution) ──────────────────────────────
// "Open/watch a live stream by @username." The active-rooms listing already carries
// `streamer_username` per room (GET /api/v1/live/rooms), so we resolve a handle to a
// live room ENTIRELY on the client — no backend `?streamer_username=` filter needed
// for the MVP (that's a future scale optimization; see the docs / GAPS). Pure, so
// web (LiveRoom) + mobile (LiveRoomVM) feed it whatever username accessor matches
// their already-mapped room shape.

/** Strip a single leading `@` and lower-case + trim, so `@Alice`, `alice ` and
 *  `ALICE` all compare equal. Empty/whitespace-only normalizes to ''. */
export function normalizeUsername(username: string | null | undefined): string {
  if (!username) return '';
  return username.trim().replace(/^@+/, '').trim().toLowerCase();
}

/** Resolve a `@username` to its currently-active room from an in-hand rooms list.
 *
 *  GENERIC over the room shape: the caller supplies a `usernameOf` accessor that
 *  reads the room's streamer handle (web `r.identity.username`, mobile
 *  `r.streamerUsername`, or a raw payload's `streamer_username`). Case-insensitive,
 *  tolerant of a leading `@`. Returns the FIRST matching room, or `null` when the
 *  user isn't live (or the handle is blank).
 *
 *  Pure + platform-free: no fetch, no navigation — the platform decides what to do
 *  with the resolved room (open the viewer) or its absence (show "not live"). */
export function findActiveRoomByUsername<R>(
  rooms: readonly R[],
  username: string | null | undefined,
  usernameOf: (room: R) => string | null | undefined,
): R | null {
  const target = normalizeUsername(username);
  if (!target) return null;
  for (const room of rooms) {
    if (normalizeUsername(usernameOf(room)) === target) return room;
  }
  return null;
}

// ── CANONICAL ROOM IDENTITY (entity-derived, persistent) ──────────────────────
// The LiveKit room name has historically been ephemeral —
// `fmt.Sprintf("live-%s-%d", userID, unixMillis)` — so it changes every go-live and a
// viewer routed to yesterday's room name finds nothing. The fix (plan §1g/§1h) is a
// STABLE, entity-derived room key: `live:{entityId}`. "entity" is whatever the room
// is anchored to — a creator's user id, a class id, a scheduled-event id — so the
// same entity re-uses the same room name across sessions and a viewer can be routed by
// id/username/slug and re-subscribe when a NEW session starts under the same key.

/** The canonical `live:` room-name prefix. Kept here so web + mobile + the (future)
 *  backend derive the identical string and can't drift. */
export const LIVE_ROOM_PREFIX = 'live:';

/** Build the canonical, persistent LiveKit room name for an entity: `live:{entityId}`.
 *  Stable across go-lives (unlike the legacy `live-{uid}-{ms}`), so routing + rejoin
 *  key off the ENTITY, not a per-session timestamp. Trims + guards an empty id
 *  (returns '' so callers can treat it as "no room" rather than `live:`). PURE. */
export function roomNameForEntity(entityId: string | null | undefined): string {
  const id = (entityId ?? '').trim();
  return id ? `${LIVE_ROOM_PREFIX}${id}` : '';
}

/** True iff `roomName` is a canonical entity-derived room name (`live:{...}`), vs a
 *  legacy ephemeral `live-{uid}-{ms}` name. Lets a consumer tell the two apart. */
export function isCanonicalRoomName(roomName: string | null | undefined): boolean {
  return !!roomName && roomName.startsWith(LIVE_ROOM_PREFIX) && roomName.length > LIVE_ROOM_PREFIX.length;
}

/** Extract the entity id from a canonical `live:{entityId}` room name (or '' when the
 *  name isn't canonical). Inverse of {@link roomNameForEntity}. PURE. */
export function entityIdFromRoomName(roomName: string | null | undefined): string {
  if (!isCanonicalRoomName(roomName)) return '';
  return roomName!.slice(LIVE_ROOM_PREFIX.length);
}

/** The ways a live room can be addressed from a route: by the entity `id`, by the
 *  streamer's `username`, or by a URL `slug`. At least one should be set; `id` wins
 *  when several are (it's the most direct). Mirrors the web routes
 *  `/live/:id | /live/:username | /live/:username/:slug` (plan §1j). */
export interface RoomAlias {
  id?: string | null;
  username?: string | null;
  slug?: string | null;
}

/** The resolved lookup KEY for a {@link RoomAlias}, telling the caller HOW to find the
 *  room:
 *   • kind 'entity'   → `key` is a canonical `live:{id}` room name; connect directly.
 *   • kind 'username' → `key` is a normalized handle; resolve via the active-rooms
 *                       listing (`findActiveRoomByUsername`) or the social profile.
 *   • kind 'slug'     → `key` is the raw slug; resolve via the backend alias endpoint.
 *   • kind 'none'     → nothing addressable was supplied.
 *  `key` is always trimmed/normalized so it's a stable map key. */
export interface ResolvedRoomAlias {
  kind: 'entity' | 'username' | 'slug' | 'none';
  key: string;
}

/** Map any of id / username / slug to a single room lookup key + strategy. PURE — no
 *  fetch; the caller performs the actual lookup per `kind`. Precedence: id (direct,
 *  canonical) → username (listing/profile resolve) → slug (backend alias). This is the
 *  ONE place the route params collapse into a lookup, so web + mobile resolve
 *  `/live/:id | /live/:username | /live/:username/:slug` the same way.
 *
 *  Note: when BOTH username + slug are present (the `/live/:username/:slug` route),
 *  `id` still wins if also given; otherwise the slug is the more specific key, so it
 *  takes precedence over the bare username. */
export function resolveRoomAlias(alias: RoomAlias): ResolvedRoomAlias {
  const id = (alias.id ?? '').trim();
  if (id) return { kind: 'entity', key: roomNameForEntity(id) };
  const slug = (alias.slug ?? '').trim();
  if (slug) return { kind: 'slug', key: slug };
  const username = normalizeUsername(alias.username);
  if (username) return { kind: 'username', key: username };
  return { kind: 'none', key: '' };
}
