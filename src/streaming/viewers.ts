// Shared LIVE-VIEWERS model — the pure brain behind the "who's watching" list the
// streamer dashboard renders (and that future viewer-side surfaces can reuse).
//
// ── What a viewer is, and where it comes from ────────────────────────────────
// A LiveViewer is derived from a LiveKit Room PARTICIPANT. The participant's
// `identity` is the streaming-service token `<uuid>::view::<room>::<nonce>` — so
// the STABLE user id is the first `::`-delimited segment. The participant carries
// no handle/name/avatar of its own (the token is opaque), so a fresh viewer starts
// as a NEUTRAL guest (a "Guest" label + no avatar) and is ENRICHED the moment they
// reveal their profile — which they do by sending a chat comment (chat.ts stamps
// the author profile inline). enrichFromComment() folds that profile back onto the
// matching viewer. A guest who never speaks stays a neutral label — NEVER a raw UUID.
//
// ── Ordering (the dashboard contract) ────────────────────────────────────────
// orderViewers(): newest-joined first, with recent GIFTERS pinned to the very top
// (a deposit/gift sets lastGiftTs; the pin lasts as long as that timestamp is the
// freshest signal). This is the single ordering both render skins use.
//
// RN PORTABILITY: serializable model + pure functions only. The per-platform layer
// just subscribes to ParticipantConnected/Disconnected and maps the participant's
// identity/metadata through participantToViewer().

/** A person watching the live stream, derived from a room participant + enriched
 *  from their chat profile. `id` is the STABLE user id (UUID), never shown raw. */
export interface LiveViewer {
  /** Stable user id (UUID) parsed from the participant identity. Render/link key. */
  id: string;
  /** Public @handle (no UUID). Empty until enriched (guest who hasn't spoken). */
  handle: string;
  /** Human display name. Falls back to @handle then a neutral guest label. */
  displayName: string;
  /** CDN avatar; empty → render an initial/placeholder, never a UUID. */
  avatarUrl: string;
  /** Author clock (ms) when we first saw this viewer (newest-first ordering). */
  joinedAt: number;
  /** True when we have NO public profile for them yet (neutral label/avatar). */
  isGuest: boolean;
  /** Set by the most recent gift/deposit from this viewer — pins them to the top
   *  of the ordered list (P1.5). Absent until they gift. */
  lastGiftTs?: number;

  // ── P1.6 SCAFFOLD (types only; no UI is built against these yet) ───────────
  /** The viewer has raised their hand (wants to be invited to the stage). */
  raisedHand?: boolean;
  /** The streamer has invited this viewer up to the stage. */
  invited?: boolean;
  /** The viewer has opted in to publish an audio/video track (on stage). */
  stageOptIn?: boolean;
}

/** The label to show as a viewer's NAME: displayName → @handle → neutral. Never a
 *  UUID. A guest with no profile gets the supplied neutral fallback. */
export function viewerLabel(v: Pick<LiveViewer, 'displayName' | 'handle'>, fallback = 'Guest'): string {
  return v.displayName || (v.handle ? `@${v.handle}` : fallback);
}

/** Extract the STABLE user id from a participant identity. The streaming service
 *  mints `<uuid>::view::<room>::<nonce>` for viewers; the publisher's identity has
 *  no `::view::`. Either way the user id is the first `::` segment. Falls back to
 *  the whole identity when there's no separator. */
export function viewerIdFromIdentity(identity: string): string {
  const i = identity.indexOf('::');
  return i === -1 ? identity : identity.slice(0, i);
}

/** The minimal participant shape viewers.ts needs — a structural subset of a
 *  LiveKit RemoteParticipant, so the core has NO livekit-client dependency. */
export interface ParticipantLike {
  identity: string;
  /** Optional LiveKit display name (rarely set by our tokens). */
  name?: string;
  /** Optional JSON metadata blob (if the streaming service ever stamps a profile
   *  onto the token, we parse {username,displayName,avatarUrl} from it). */
  metadata?: string;
}

/** Parse an OPTIONAL profile from a participant's metadata blob (if our backend
 *  ever stamps one). Tolerant: bad/empty JSON → no enrichment. */
function profileFromMetadata(meta: string | undefined): { handle?: string; displayName?: string; avatarUrl?: string } | null {
  if (!meta) return null;
  try {
    const o = JSON.parse(meta) as Record<string, unknown>;
    const handle = (o.username ?? o.handle) as string | undefined;
    const displayName = (o.displayName ?? o.display_name) as string | undefined;
    const avatarUrl = (o.avatarUrl ?? o.avatar_url) as string | undefined;
    if (!handle && !displayName && !avatarUrl) return null;
    return { handle, displayName, avatarUrl };
  } catch {
    return null;
  }
}

/** Map a room participant to a LiveViewer. Uses metadata-stamped profile when
 *  present, else a NEUTRAL guest (empty handle/name/avatar → the label helpers
 *  render "Guest", never the UUID). `joinedAt` defaults to now. Pure given a clock. */
export function participantToViewer(p: ParticipantLike, joinedAt: number = Date.now()): LiveViewer {
  const id = viewerIdFromIdentity(p.identity);
  const prof = profileFromMetadata(p.metadata);
  const handle = prof?.handle ?? '';
  const displayName = prof?.displayName ?? p.name ?? '';
  const avatarUrl = prof?.avatarUrl ?? '';
  return {
    id,
    handle,
    displayName,
    avatarUrl,
    joinedAt,
    isGuest: !handle && !displayName,
  };
}

/** Only participants that are VIEWERS (have a `::view::` identity) belong in the
 *  list — the publisher (streamer) themselves is excluded. Mirrors join.ts's
 *  isViewerIdentity (kept inline so this module has no runtime cross-import). */
export function isWatcher(p: ParticipantLike): boolean {
  return p.identity.includes('::view::');
}

// ── The viewers map (id → LiveViewer) + pure folds ───────────────────────────
// Keyed by stable user id so a reconnect under a fresh `::nonce` identity collapses
// to the same person (their profile/gift state survives a blip).

/** The viewers collection: a map from stable user id → viewer. */
export type ViewerMap = Record<string, LiveViewer>;

/** Add/replace a viewer on connect. If we already know this user (reconnect), keep
 *  the EARLIER joinedAt + any enrichment/gift state rather than resetting them. */
export function addViewer(map: ViewerMap, v: LiveViewer): ViewerMap {
  const prev = map[v.id];
  if (!prev) return { ...map, [v.id]: v };
  return {
    ...map,
    [v.id]: {
      ...prev,
      // adopt any newly-available profile, keep the original join time + gift state
      handle: v.handle || prev.handle,
      displayName: v.displayName || prev.displayName,
      avatarUrl: v.avatarUrl || prev.avatarUrl,
      isGuest: prev.isGuest && v.isGuest,
      joinedAt: Math.min(prev.joinedAt, v.joinedAt),
    },
  };
}

/** Remove a viewer on disconnect (by stable user id). */
export function removeViewer(map: ViewerMap, id: string): ViewerMap {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

/** Enrich a viewer from a chat comment's inline author profile (chat.ts stamps it).
 *  This is how a guest gets a real name/@handle/avatar — the moment they speak. If
 *  the author isn't a known participant yet (comment beat the connect event), the
 *  viewer is created. Pure. */
export function enrichFromComment(
  map: ViewerMap,
  author: { authorId: string; handle: string; displayName: string; avatarUrl: string; ts: number },
): ViewerMap {
  const prev = map[author.authorId];
  const hasProfile = !!(author.handle || author.displayName);
  if (!prev) {
    return {
      ...map,
      [author.authorId]: {
        id: author.authorId,
        handle: author.handle,
        displayName: author.displayName,
        avatarUrl: author.avatarUrl,
        joinedAt: author.ts,
        isGuest: !hasProfile,
      },
    };
  }
  return {
    ...map,
    [author.authorId]: {
      ...prev,
      handle: author.handle || prev.handle,
      displayName: author.displayName || prev.displayName,
      avatarUrl: author.avatarUrl || prev.avatarUrl,
      isGuest: prev.isGuest && !hasProfile,
    },
  };
}

/** DEPOSIT/GIFT BUMP (P1.5): record a gift from a viewer, setting lastGiftTs so the
 *  ordering helper pins them to the top. Also enriches their profile from the gift
 *  author (a gift reveals the same inline profile a comment does). Pure. */
export function applyGift(
  map: ViewerMap,
  gift: { authorId: string; handle: string; displayName: string; avatarUrl: string; ts: number },
): ViewerMap {
  const enriched = enrichFromComment(map, gift);
  const v = enriched[gift.authorId];
  return { ...enriched, [gift.authorId]: { ...v, lastGiftTs: Math.max(gift.ts, v.lastGiftTs ?? 0) } };
}

/** ORDERING (the dashboard contract): recent GIFTERS pinned to the very top (by
 *  most-recent gift), then everyone else NEWEST-JOINED first. Pure — returns a new
 *  sorted array; never mutates the map. */
export function orderViewers(map: ViewerMap): LiveViewer[] {
  return Object.values(map).sort((a, b) => {
    const ag = a.lastGiftTs ?? 0;
    const bg = b.lastGiftTs ?? 0;
    if (ag !== bg) return bg - ag; // gifters first, most-recent gift on top
    return b.joinedAt - a.joinedAt; // then newest-joined first
  });
}

// ── P1.6 SCAFFOLD: future stage-interactivity events (types + topic + no-op) ──
// Hand-raise / invite-to-stream / opt-in audio-video / paid-promotion all flow as
// a single additive `stage.request` message on its OWN reliable topic. We DEFINE
// the wire + a thin no-op handler so the future work has a home; NO UI is built.

/** The dedicated reliable data topic future stage-interactivity rides on. */
export const STAGE_TOPIC = 'stage';

/** Wire version for the stage envelope. */
export const STAGE_WIRE_VERSION = 1;

/** What a stage request is asking for:
 *   • raise_hand / lower_hand  — viewer ⇄ streamer: I'd like to come up / never mind.
 *   • invite                   — streamer → viewer: come up to the stage.
 *   • accept / decline         — viewer → streamer: response to an invite.
 *   • opt_in_av                — viewer: I'm publishing my audio/video now.
 *   • promote                  — paid-promotion: pin/boost this viewer (future). */
export type StageAction =
  | 'raise_hand'
  | 'lower_hand'
  | 'invite'
  | 'accept'
  | 'decline'
  | 'opt_in_av'
  | 'promote';

/** A stage-interactivity event. `viewerId` is the stable user id the request is
 *  about; `by` is who sent it (streamer for invite/promote, the viewer otherwise).
 *  Additive — an unknown `t` decodes to null and is ignored by other decoders. */
export interface StageRequest {
  t: 'stage.request';
  v: number;
  action: StageAction;
  viewerId: string;
  by: string;
  ts: number;
  /** promote only: a short reason/label for a paid promotion (future). */
  label?: string;
}

/** True if a decoded object is a stage envelope. */
export function isStageRequest(obj: unknown): obj is StageRequest {
  return !!obj && typeof obj === 'object' && (obj as { t?: unknown }).t === 'stage.request';
}

/** Fold a stage request onto the viewers map. Pure. Today only the FLAG-setting
 *  paths are wired (raise/lower/invite/opt-in) so the scaffold flags on LiveViewer
 *  have a producer; `promote` is a no-op placeholder. No UI consumes these yet —
 *  this is the "thin no-op handler path" so the future work has a home. */
export function applyStageRequest(map: ViewerMap, req: StageRequest): ViewerMap {
  const v = map[req.viewerId];
  if (!v) return map; // request about an unknown viewer → ignore (no-op)
  switch (req.action) {
    case 'raise_hand':
      return { ...map, [req.viewerId]: { ...v, raisedHand: true } };
    case 'lower_hand':
    case 'decline':
      return { ...map, [req.viewerId]: { ...v, raisedHand: false, invited: false } };
    case 'invite':
      return { ...map, [req.viewerId]: { ...v, invited: true } };
    case 'accept':
    case 'opt_in_av':
      return { ...map, [req.viewerId]: { ...v, stageOptIn: true } };
    case 'promote':
    default:
      return map; // paid-promotion: defined, intentionally a no-op for now
  }
}
