// PRE-JOIN ENTRY PREP — the platform-agnostic, CLOCKLESS state machine a viewer
// runs BEFORE it connects a live room, driven by the room-listing MANIFEST (v1).
//
// ── Why a SEPARATE machine from entry.ts ─────────────────────────────────────
// `entry.ts`'s EntryState gates on the IN-ROOM manifest broadcast (the streamer's
// live.sync, learned only AFTER connecting) and a BYTE-progress preload. It can't
// run before connect because a guest has no other manifest source there.
//
// This backend now stamps a SMALL v1 manifest onto the ROOM-LISTING payload
// (GET /api/v1/live/rooms → room.manifest), refreshed by the streamer on go-live
// and every scene change. That gives a viewer a manifest BEFORE it ever opens a
// PeerConnection — so we can run a DELIBERATE loading phase that:
//   1. RELEASES background media (pause+unload the feed's <video> decoders) so the
//      hardware decoders are free when the room allocates its own, and
//   2. PRELOADS the room's docs (warm the PDF/image bytes) + warms overlays, then
//   3. SETTLES for a MIN-FLOOR — a "yield beat" that lets the runtime reclaim the
//      freed decoders/GC before we connect (we can't force GC; we drop refs, yield,
//      and HOLD the floor so the reclaim has a window).
//
//   idle → fetchedManifest → releasingMedia → preloading → settling → ready
//                                                                       │
//                            (empty/absent manifest) ──────────────────┘
//
// The room connection hangs on `isPrepReady(state)`. Empty/absent manifest ⇒ jump
// straight to `ready` (a normal feed is never delayed). The manifest is a prep
// HINT, not the source of truth: after connect, the existing reliable full-replace
// scene sync (scene.ts / viewer.ts) reconciles whatever actually changed during prep.
//
// ── Pure + clockless ─────────────────────────────────────────────────────────
// This file holds ZERO IO and ZERO timers. It computes WHAT to do at each step
// (which docs to preload, "release background media now") and accepts COMPLETION
// signals; the PLATFORM performs the side effects (DOM pause/unload on web; the RN
// media seam on mobile) and a clock reports the min-floor elapsed. So web + mobile
// drive the identical ordering from the same brain — only the effects differ.

/** A doc the prep should warm before connecting. Mirrors the listing manifest's
 *  doc entries (id + render kind + URL + optional page count). */
export interface RoomManifestDoc {
  id: string;
  /** 'pdf' rasterizes per-page; 'image' is a single page. */
  kind: 'pdf' | 'image';
  /** The fetch/preload URL (presigned or public). Absent ⇒ nothing to warm. */
  url?: string;
  /** PDF page count when known (drives a render estimate); absent for images. */
  pages?: number;
}

/** An overlay the room is currently showing (type + id), so the viewer can warm
 *  the overlay renderer ahead of connect. Carried verbatim from the listing. */
export interface RoomManifestOverlay {
  type: string;
  id: string;
}

/** The room-listing MANIFEST (v1) — a SMALL hint the streaming service stamps on
 *  each room in GET /api/v1/live/rooms, refreshed on go-live + every scene change.
 *  `empty:true` (or an absent manifest) ⇒ a plain feed with nothing to prep. */
export interface RoomManifest {
  v: 1;
  /** True ⇒ skip prep entirely (no docs/overlays/scene worth pre-warming). */
  empty: boolean;
  /** The producer's scene nonce at publish time (advisory — lets a viewer notice
   *  the listing manifest is stale vs. the in-room snapshot it later receives). */
  sceneNonce: number;
  /** Count of camera+screen items in the current scene (how many decoders the room
   *  will allocate — used to size the background-media release). */
  videoSources: number;
  /** True if the room publishes audio. */
  audio: boolean;
  /** Overlays currently placed (poll/quiz/doc-slot/etc.). */
  overlays: RoomManifestOverlay[];
  /** Docs currently in scene slots, with their preload URLs. */
  docs: RoomManifestDoc[];
}

/** The canonical EMPTY manifest — the value an absent/empty listing resolves to.
 *  `createEntryPrep` jumps straight to `ready` for this. */
export function emptyRoomManifest(): RoomManifest {
  return { v: 1, empty: true, sceneNonce: 0, videoSources: 0, audio: false, overlays: [], docs: [] };
}

function asInt(v: unknown, dflt = 0): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

/** Parse/normalize a raw listing `manifest` field into a RoomManifest, tolerating
 *  anything missing or malformed (→ empty). The wire is the compact snake-ish v1
 *  shape `{v,empty,scene_nonce,video_sources,audio,overlays,docs}`; both camelCase
 *  and snake_case keys are accepted so the same parser works against either the
 *  Go JSON or an already-camelCased object. A null/undefined/non-object input,
 *  `empty:true`, or a wrong/absent version all resolve to the empty manifest. */
export function parseRoomManifest(raw: unknown): RoomManifest {
  if (!raw || typeof raw !== 'object') return emptyRoomManifest();
  const o = raw as Record<string, unknown>;
  // A manifest with no v1 marker is treated as absent (we never guess at a shape).
  if (asInt(o.v, 0) !== 1) return emptyRoomManifest();
  if (o.empty === true) return emptyRoomManifest();

  const overlaysRaw = Array.isArray(o.overlays) ? o.overlays : [];
  const overlays: RoomManifestOverlay[] = [];
  for (const x of overlaysRaw) {
    if (!x || typeof x !== 'object') continue;
    const ox = x as Record<string, unknown>;
    const type = typeof ox.type === 'string' ? ox.type : '';
    const id = typeof ox.id === 'string' ? ox.id : '';
    if (type || id) overlays.push({ type, id });
  }

  const docsRaw = Array.isArray(o.docs) ? o.docs : [];
  const docs: RoomManifestDoc[] = [];
  for (const x of docsRaw) {
    if (!x || typeof x !== 'object') continue;
    const dx = x as Record<string, unknown>;
    const id = typeof dx.id === 'string' ? dx.id : '';
    if (!id) continue;
    const kind = dx.kind === 'image' ? 'image' : 'pdf';
    const url = typeof dx.url === 'string' ? dx.url : undefined;
    const pages = dx.pages != null ? asInt(dx.pages) : undefined;
    docs.push({ id, kind, url, ...(pages != null ? { pages } : {}) });
  }

  const m: RoomManifest = {
    v: 1,
    empty: false,
    sceneNonce: asInt(o.sceneNonce ?? o.scene_nonce),
    videoSources: asInt(o.videoSources ?? o.video_sources),
    audio: o.audio === true,
    overlays,
    docs,
  };
  // A "non-empty" manifest with nothing actually worth prepping is normalized to
  // empty so the viewer skips prep (no docs, no overlays, no video to free).
  if (m.docs.length === 0 && m.overlays.length === 0 && m.videoSources === 0) {
    return emptyRoomManifest();
  }
  return m;
}

/** True if a manifest carries anything worth a prep phase (docs to preload,
 *  overlays to warm, or video sources whose decoders we want to free for). */
export function manifestNeedsPrep(m: RoomManifest): boolean {
  return !m.empty && (m.docs.length > 0 || m.overlays.length > 0 || m.videoSources > 0);
}

// ── deriveManifest — PRODUCER side: build the v1 manifest from the rendered scene ─

/** The minimal scene shape `deriveManifest` reads: layout items typed by what they
 *  show. Satisfied by the producer's LiveScene / layout Scene (both expose
 *  `items: {type, ...}`). Doc/overlay items optionally carry the live instance id
 *  + URL so the manifest can list real preload targets. */
export interface DeriveSceneItem {
  type: 'camera' | 'screen' | 'overlay' | 'doc';
  /** The live overlay/doc instance id occupying this slot (for overlays + docs). */
  instanceId?: string;
  /** For a doc slot: its preload URL + kind/pages, when a doc is live in it. */
  docUrl?: string;
  docKind?: 'pdf' | 'image';
  docPages?: number;
  /** For an overlay slot: the overlay kind (poll/quiz/vote-button/…) when filled. */
  overlayType?: string;
}
export interface DeriveScene {
  items: DeriveSceneItem[];
}

/** Track config the producer is publishing — whether audio is live + the scene
 *  nonce at publish time (so the listing manifest carries the producer's current
 *  generation). `videoSources` is derived from the scene's camera+screen items. */
export interface DeriveTrackConfig {
  audio: boolean;
  sceneNonce: number;
}

/** Build the v1 RoomManifest the producer PUBLISHES (PUT …/manifest) from its
 *  current rendered scene + track config. PURE.
 *   • video_sources = count of camera+screen items in the scene.
 *   • audio         = trackConfig.audio.
 *   • overlays      = one entry per FILLED overlay slot ({type,id}).
 *   • docs          = one entry per FILLED doc slot ({id,kind,url,pages?}).
 *  A scene with no media + no filled doc/overlay slots derives the EMPTY manifest
 *  (so viewers skip prep). The streamer calls this on go-live + every scene change
 *  and PUTs the result alongside the existing reliable scene broadcast. */
export function deriveManifest(scene: DeriveScene | null, track: DeriveTrackConfig): RoomManifest {
  const items = scene?.items ?? [];
  const videoSources = items.filter((it) => it.type === 'camera' || it.type === 'screen').length;
  const overlays: RoomManifestOverlay[] = [];
  const docs: RoomManifestDoc[] = [];
  for (const it of items) {
    if (it.type === 'overlay' && it.instanceId) {
      overlays.push({ type: it.overlayType || 'overlay', id: it.instanceId });
    } else if (it.type === 'doc' && it.instanceId) {
      docs.push({
        id: it.instanceId,
        kind: it.docKind === 'image' ? 'image' : 'pdf',
        ...(it.docUrl ? { url: it.docUrl } : {}),
        ...(it.docPages != null ? { pages: it.docPages } : {}),
      });
    }
  }
  if (videoSources === 0 && overlays.length === 0 && docs.length === 0) {
    return { ...emptyRoomManifest(), sceneNonce: track.sceneNonce, audio: track.audio };
  }
  return {
    v: 1,
    empty: false,
    sceneNonce: track.sceneNonce,
    videoSources,
    audio: track.audio,
    overlays,
    docs,
  };
}

/** Serialize a RoomManifest to the compact v1 WIRE shape the PUT endpoint expects
 *  (snake_case keys, matching the backend contract). */
export function roomManifestToWire(m: RoomManifest): {
  v: 1;
  empty: boolean;
  scene_nonce: number;
  video_sources: number;
  audio: boolean;
  overlays: RoomManifestOverlay[];
  docs: RoomManifestDoc[];
} {
  return {
    v: 1,
    empty: m.empty,
    scene_nonce: m.sceneNonce,
    video_sources: m.videoSources,
    audio: m.audio,
    overlays: m.overlays,
    docs: m.docs,
  };
}

// ── createEntryPrep — the clockless prep state machine ───────────────────────

/** The pre-join prep phase. Strictly forward (the platform only signals
 *  completion; the machine never moves backward except a fresh construction):
 *   'idle'            — constructed; nothing done (a tick will advance it).
 *   'fetchedManifest' — manifest in hand; about to release background media.
 *   'releasingMedia'  — the platform is pausing+unloading all background <video>
 *                       (the feed) so their decoders free.
 *   'settling'        — the YIELD BEAT right after releasing: drop refs + yield so
 *                       the runtime can reclaim before the room allocates decoders.
 *                       Also the home of the MIN-FLOOR (the loading screen holds).
 *   'preloading'      — warming the manifest's docs (PDF rasterize / image fetch).
 *   'ready'           — docs warmed (or timed out) AND min-floor elapsed → CONNECT. */
export type PrepPhase =
  | 'idle'
  | 'fetchedManifest'
  | 'releasingMedia'
  | 'settling'
  | 'preloading'
  | 'ready';

/** The default minimum settle floor (ms) — the loading screen is held AT LEAST
 *  this long once we begin settling, so the freed decoders/GC have a real window
 *  to reclaim before the room connects. ~900ms feels deliberate without dragging. */
export const PREP_MIN_FLOOR_MS = 900;

/** The work the platform must perform for the CURRENT phase, returned by `step()`
 *  / the signal handlers so the driver knows what to do next. Exactly one action
 *  is in flight at a time. */
export type PrepWork =
  | { do: 'none' }
  /** Release ALL background media NOW (pause + unload every app <video>). The
   *  platform calls `onMediaReleased()` when done. `videoSources` hints how many
   *  decoders the room will need. */
  | { do: 'releaseMedia'; videoSources: number }
  /** Begin the settle/yield beat: drop refs + yield. The platform starts the
   *  min-floor clock and calls `onSettleFloorElapsed()` once `minFloorMs` passed. */
  | { do: 'settle'; minFloorMs: number }
  /** Preload these docs (warm bytes / rasterize). The platform calls
   *  `onDocsPreloaded()` when done OR when its own preload timeout fires. */
  | { do: 'preload'; docs: RoomManifestDoc[] }
  /** Prep is finished — the driver may connect the room. */
  | { do: 'connect' };

/** The serializable prep state. A driver holds exactly this and derives its loading
 *  UI + the connect gate from it. */
export interface PrepState {
  phase: PrepPhase;
  manifest: RoomManifest;
  /** Min settle floor for this run (defaults to PREP_MIN_FLOOR_MS). */
  minFloorMs: number;
  /** Completion latches the driver sets via the signal handlers. `ready` requires
   *  docs done (or skipped) AND the min-floor elapsed. */
  mediaReleased: boolean;
  settleFloorElapsed: boolean;
  docsPreloaded: boolean;
}

export interface CreateEntryPrepOptions {
  /** Override the min settle floor (ms). Defaults to PREP_MIN_FLOOR_MS. */
  minFloorMs?: number;
}

/** Construct the prep machine for a manifest. An EMPTY (or absent) manifest skips
 *  every step and lands directly in `ready` — a normal feed connects with no delay.
 *  A manifest needing prep starts in `fetchedManifest`; the driver then calls
 *  `step(state)` to learn the work for the phase and feeds completion signals back.
 *
 *  The returned object is the INITIAL state; all transitions are the pure functions
 *  below (so it stays serializable + testable). `step` is the single "what now?".
 */
export function createEntryPrep(manifest: RoomManifest, opts: CreateEntryPrepOptions = {}): PrepState {
  const minFloorMs = opts.minFloorMs ?? PREP_MIN_FLOOR_MS;
  if (!manifestNeedsPrep(manifest)) {
    // Empty-skip: no media to free, no docs to warm → ready immediately. All
    // latches are set so the gate is open and the driver connects at once.
    return {
      phase: 'ready',
      manifest,
      minFloorMs,
      mediaReleased: true,
      settleFloorElapsed: true,
      docsPreloaded: true,
    };
  }
  return {
    phase: 'fetchedManifest',
    manifest,
    minFloorMs,
    mediaReleased: false,
    settleFloorElapsed: false,
    // No docs to warm ⇒ the doc latch is already satisfied (the driver never gets a
    // `preload` work item, so it would never call onDocsPreloaded otherwise). The
    // gate then hangs only on the media release + the min-floor.
    docsPreloaded: manifest.docs.length === 0,
  };
}

/** Should the machine advance to `ready`? Gated on BOTH: docs preloaded (or no
 *  docs) AND the min-floor elapsed. Media release must also be done (it precedes
 *  the settle floor, so it's implied, but we check it for safety). */
function canBeReady(s: PrepState): boolean {
  return s.mediaReleased && s.docsPreloaded && s.settleFloorElapsed;
}

/** The WORK the driver should perform for the current state — the single
 *  "what now?". The ORDER is enforced here:
 *    fetchedManifest → releaseMedia
 *    releasingMedia  → (when released) settle           ← yield beat AFTER release
 *    settling        → preload (docs warm DURING the floor) ‖ wait for the floor
 *    preloading      → (when docs done AND floor done) connect
 *    ready           → connect
 *  Preloading runs CONCURRENTLY with the min-floor wait: the floor is a FLOOR, not
 *  a ceiling — if docs take longer than the floor, we wait for them; if the floor
 *  is longer, we hold for it. `connect` is returned only once both have completed. */
export function prepWork(s: PrepState): PrepWork {
  switch (s.phase) {
    case 'fetchedManifest':
      return { do: 'releaseMedia', videoSources: s.manifest.videoSources };
    case 'releasingMedia':
      return { do: 'releaseMedia', videoSources: s.manifest.videoSources };
    case 'settling':
      // The settle floor is running; warm the docs in parallel so they're ready by
      // the time the floor lifts. No docs ⇒ just hold the floor (none work).
      return s.manifest.docs.length > 0 ? { do: 'preload', docs: s.manifest.docs } : { do: 'none' };
    case 'preloading':
      return canBeReady(s) ? { do: 'connect' } : { do: 'none' };
    case 'ready':
      return { do: 'connect' };
    case 'idle':
    default:
      return { do: 'none' };
  }
}

/** Begin prep: idle/fetchedManifest → releasingMedia. The driver calls this once it
 *  has the state from createEntryPrep and is ready to start the side effects. Pure;
 *  idempotent once past fetchedManifest. */
export function beginPrep(s: PrepState): PrepState {
  if (s.phase === 'idle' || s.phase === 'fetchedManifest') {
    return { ...s, phase: 'releasingMedia' };
  }
  return s;
}

/** The platform finished releasing background media → enter the settle/yield beat.
 *  Sets the released latch and moves to `settling` (the min-floor + doc preload run
 *  here). Idempotent. */
export function onMediaReleased(s: PrepState): PrepState {
  if (s.mediaReleased && s.phase !== 'releasingMedia') return s;
  const next: PrepState = { ...s, mediaReleased: true };
  if (s.phase === 'releasingMedia' || s.phase === 'fetchedManifest' || s.phase === 'idle') {
    next.phase = 'settling';
  }
  return advance(next);
}

/** The min settle floor elapsed (the platform's clock fired). Sets the latch and,
 *  once docs are also done, lifts to `ready`. While docs are still warming the
 *  machine moves to `preloading` to reflect "floor done, waiting on docs". */
export function onSettleFloorElapsed(s: PrepState): PrepState {
  return advance({ ...s, settleFloorElapsed: true });
}

/** The platform finished preloading the manifest's docs (or its preload timeout
 *  fired — either way the doc latch is set so prep can't hang on a slow/broken
 *  doc). Once the floor is also done, lifts to `ready`. */
export function onDocsPreloaded(s: PrepState): PrepState {
  return advance({ ...s, docsPreloaded: true });
}

/** Internal: recompute the phase from the latches. Drives settling → preloading →
 *  ready, never backward. Once both the floor + docs are done, the phase is `ready`.
 *  While settling, if the floor has elapsed but docs are still warming, surface
 *  `preloading` (the loading screen says "loading contents" rather than "settling").
 */
function advance(s: PrepState): PrepState {
  if (s.phase === 'ready') return s;
  if (canBeReady(s)) return { ...s, phase: 'ready' };
  // Past the settle beat: if the floor lifted first we're explicitly waiting on docs.
  if (s.phase === 'settling' && s.settleFloorElapsed && !s.docsPreloaded) {
    return { ...s, phase: 'preloading' };
  }
  return s;
}

/** THE GATE the room connection hangs on. True ⇒ the driver may connect LiveKit. */
export function isPrepReady(s: PrepState): boolean {
  return s.phase === 'ready';
}

/** True while prep is COVERING the screen with a loading phase (not yet ready).
 *  The driver shows the LOADING UI for these phases and withholds the connect. */
export function isPrepping(s: PrepState): boolean {
  return s.phase !== 'ready' && s.phase !== 'idle';
}

/** A short, user-facing label for the current prep phase (web + RN share the copy).
 *  '' once ready (nothing to show). */
export function prepStatusLabel(s: PrepState): string {
  switch (s.phase) {
    case 'fetchedManifest':
    case 'releasingMedia':
      return 'Preparing…';
    case 'settling':
      return 'Loading stream…';
    case 'preloading':
      return 'Loading stream contents…';
    default:
      return '';
  }
}
