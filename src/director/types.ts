// @paxpia/core/director — the PRODUCER-DIRECTION brain seams (audit step 2.1).
//
// This file holds the platform-binding SEAMS the headless `createDirectorSession`
// (session.ts) orchestrates over — the producer counterpart to the viewer's
// `OverlayTransport`/`LeafAdapter`/`Compositor` seams. Lifted out of
// `Paxpia-web/src/store/live.ts` (~925 lines) so the SAME producer lifecycle web
// drives can be driven by the mobile creator studio (Wave 3) — neither re-forks
// `goLive`/`serve`/`broadcastScene`/`broadcastLiveSync`/`publishManifest`/
// vote-aggregation.
//
// ── Why these are interfaces, not impls ──────────────────────────────────────
// A producer is irreducibly platform-edged: it opens a LiveKit room, captures a
// camera/screen, composites a canvas, grants presigned material URLs and fetches
// bytes. What is COMMON is the DIRECTION LOGIC — which slot a pushable routes to,
// when to re-broadcast a full scene, how to fold a viewer vote, how the doc
// page/presenter sync — all of which is identical web ↔ mobile. The seams below
// confine the platform edge:
//   • `DirectorTransport` — the producer signal fan-out (live.sync / scene.sync /
//     overlay control / vote-aggregator), wrapping the web `OverlayChannel`.
//   • `DirectorMedia`     — room create/connect + camera/screen/mic publish, wrapping
//     web's `Room` + `studio/media` + the room CRUD fetch.
//   • `Compositor`        — the §1.4 paint-scene-to-one-track seam (re-used verbatim).
//   • `MaterialsClient`   — the §1.1 grant/freshness path (re-used verbatim).
//   • `StoreHandle`s      — the §1.2/§1.3 scenes/scheduling state the brain reads.
//
// PURE: type-only module. No DOM/RN/livekit-client. Media handles cross the seams
// as OPAQUE `unknown` tokens exactly like `transport.ts`/`compositor.ts`.

import type { DocPresenterState, DocViewMode, LiveManifest, LiveScene } from '../streaming/live';
import type { DocAnnotationState } from '../overlays/annotation';
import type { WhiteboardItemSettings } from './logic';
import type { DocPayload, OverlayInstance } from '../overlays/types';
import type { RenderedScene } from '../streaming/scene';
import type { RoomManifest } from '../streaming/prep';
import type { AuthoredKind, AuthoredPayload } from '../scheduling/types';
import type { ScenesState } from '../studio/types';
import type { StoreHandle, StudioSchedulingState } from '../studio/sync';
import type { CompositorFactory, MediaSourceHandle } from '../compositor/types';
import type { MaterialsClient } from '../materials/grant';

// Re-export the consumed seams so a platform binding can import the whole producer
// contract from one place (the barrel re-surfaces them too).
export type { Compositor, CompositorFactory, MediaSourceHandle } from '../compositor/types';
export type { MaterialsClient } from '../materials/grant';
export type { StoreHandle } from '../studio/sync';

/** Two top-level visibility values the producer offers (mirrors web's `Visibility`). */
export type DirectorVisibility = 'public' | 'private';

/** The producer lifecycle phase the platform store mirrors. */
export type DirectorStatus = 'idle' | 'connecting' | 'live';

// ── The producer signal-fanout transport (wraps the web OverlayChannel) ──────

/** A live tally for the participation overlay slot, surfaced to the producer's
 *  results panel. The brain reads ONLY `overlayId`/`gen` (the results-gen adopt
 *  decision); the rest of the platform's results message (tallies/total/phase) rides
 *  along opaquely and is mirrored back to the platform store as-is. Kept to the
 *  minimal read shape so a platform's concrete results type (web `OverlayResultsMsg`)
 *  is structurally assignable without an index-signature mismatch. */
export interface DirectorResultsMsg {
  overlayId: string;
  gen: number;
}

/** The active-overlay echo the bot/aggregator surfaces back to the producer (the
 *  web `OverlayChangedEvent`). `overlay` null = the participation slot is cleared. */
export interface DirectorOverlayChange {
  overlay: OverlayInstance | null;
}

/** THE PRODUCER TRANSPORT — the four signal channels `store/live.ts` fans out over
 *  its `OverlayChannel`, plus the vote-aggregator hook + the inbound producer
 *  subscriptions the direction logic reconciles. A platform binds this to the
 *  LiveKit room's `overlay` data channel (web: `createOverlayChannel(room)`).
 *
 *  Symmetry with `OverlayTransport` (the viewer seam): the viewer transport carries
 *  respond/requestState/publish/onEvent; THIS producer transport carries the higher
 *  -level producer verbs (publishLiveSync/publishSceneSync + overlay control) the
 *  direction brain emits, so the brain never touches wire encoders. */
export interface DirectorTransport {
  // ── Broadcast (producer → room) ────────────────────────────────────────────
  /** Broadcast the doc-slot + selected-scene + manifest live-sync snapshot
   *  (web `publishLiveSync`). RELIABLE. `doc:null, scene:null` is the end-live wipe. */
  publishLiveSync(msg: DirectorLiveSync): void;
  /** Broadcast the COMPLETE full-replace overlay set for the current scene
   *  (web `publishSceneSync`). RELIABLE + ordered. */
  publishScene(scene: RenderedScene): void;
  /** PUT the pre-join PREP manifest to the room listing (web `putRoomManifest`).
   *  Best-effort / fire-and-forget — a failure must never disrupt the stream. */
  publishManifest(roomName: string, manifest: RoomManifest): void;

  // ── Participation-overlay control (bot-owned slot) ──────────────────────────
  /** Stage + open a participation overlay in one shot (web `createAndActivate`). */
  createAndActivate(overlay: OverlayInstance): void;
  /** Close the participation overlay by id (web `close`). */
  closeOverlay(overlayId: string): void;
  /** Reveal the participation overlay's results by id (web `reveal`). */
  revealOverlay(overlayId: string): void;
  /** RESET a participation overlay round (bump gen, clear votes); returns the new
   *  gen, or null when the channel has never seen that id (web `refresh`). */
  refreshOverlay(overlayId: string): number | null;

  // ── Vote aggregator (web-only: the streamer's room is authoritative) ────────
  /** Turn this transport into the room's vote aggregator (web `enableAggregator`),
   *  folding viewer `overlay.response` packets into a per-round tally and
   *  rebroadcasting `overlay.results`. `getActive` replays the live overlay + tally
   *  to a late joiner's request_state. Returns a disable fn. */
  enableAggregator(getActive: () => OverlayInstance | null): () => void;

  // ── Inbound producer subscriptions (room → producer) ────────────────────────
  /** Subscribe to the bot/aggregator's active-overlay echo (web `onChanged`). */
  onOverlayChanged(cb: (e: DirectorOverlayChange) => void): () => void;
  /** Subscribe to the authoritative live tallies (web `onResults`). */
  onResults(cb: (r: DirectorResultsMsg) => void): () => void;
  /** Subscribe to NEW participant connections so the producer replays its full
   *  live state (web `onParticipantConnected`). */
  onParticipantConnected(cb: () => void): () => void;

  /** Detach all listeners + drop the channel (web `dispose`). */
  dispose(): void;
}

/** The live-sync snapshot the producer broadcasts — the doc slot + selected scene
 *  (id + layout) + presenter transform + material manifest. Mirrors the web
 *  `LiveSyncMsg` exactly so the platform binding can publish it verbatim. */
export interface DirectorLiveSync {
  t: 'live.sync';
  v: 1;
  sceneId: string | null;
  scene: LiveScene | null;
  doc: OverlayInstance | null;
  docPresenter?: DocPresenterState | null;
  manifest?: LiveManifest | null;
  /** WHITEBOARD-ON-DOC ANNOTATION presence (Message D item 2) — the streamer's active
   *  annotation descriptor for the live doc, carried on every doc/scene broadcast +
   *  participant-join replay so a (re)joining viewer learns whether the layer is on +
   *  which `wbann:…` board to paint. Absent ⇒ unchanged; null ⇒ no active annotation. */
  docAnn?: DocAnnotationState | null;
}

// ── The media seam (room create/connect + capture + publish) ─────────────────

/** A platform handle to a CONNECTED producer room (the LiveKit `Room` web wraps in
 *  a `Room` object). Opaque to core — only the platform media impl decodes it. */
export type DirectorRoomHandle = unknown;

/** The result of opening + connecting a producer room. The brain hands `roomName`
 *  to the materials grant + manifest PUT, and `room` back to the media seam for
 *  publish/teardown; both are otherwise opaque. */
export interface DirectorRoomOpen {
  /** The server-assigned room name (web `room_name`) — the grant + manifest scope. */
  roomName: string;
  /** The connected platform room handle (opaque). */
  room: DirectorRoomHandle;
}

/** THE PRODUCER MEDIA SEAM — room lifecycle + capture + publish, wrapping web's
 *  room-CRUD fetch + `Room` connect + `studio/media` capture. The direction brain
 *  drives this; the platform owns getUserMedia/getDisplayMedia + the LiveKit SDK.
 *
 *  ── Lifecycle (mirrors `store/live.ts goLive`) ──────────────────────────────
 *  The brain calls `provisionScene(sceneId)` to acquire any not-yet-live
 *  camera/screen inputs (returns whether ≥1 input is live, so a media scene with no
 *  live input is blocked), then `openRoom(title, visibility)` to create + connect
 *  the room, then `publishVideoTrack` (the compositor output) + `publishMic`. On a
 *  scene hot-swap it re-provisions. On end it calls `closeRoom`. */
export interface DirectorMedia {
  /** Acquire any not-yet-live camera/screen streams for the scene's media items,
   *  bound to each item id (so the compositor + preview read them by id). Returns
   *  TRUE when the scene ends up with ≥1 live media input (false = no media items,
   *  or a scene with media items but none acquired = would be a black screen — the
   *  brain blocks go-live on that). `onStatus` surfaces "Starting camera…" to the
   *  UI. THROWS if a device is denied. Web: getUserMedia / getDisplayMedia. */
  provisionScene(sceneId: string, onStatus: (s: string | null) => void): Promise<boolean>;
  /** Whether the scene has ≥1 camera/screen item (so the brain knows a media scene
   *  with no live input is a black-screen failure, distinct from an audio-only one). */
  sceneHasMedia(sceneId: string): boolean;
  /** Create the live room (server POST) and connect to the SFU. THROWS a
   *  human-readable Error on a 401/409/other (the brain surfaces `.message`). */
  openRoom(title: string, visibility: DirectorVisibility): Promise<DirectorRoomOpen>;
  /** The opaque platform media SOURCE handle bound to a scene item by item id (web:
   *  the item's `MediaStream` from the media registry; RN: a LiveKit local track),
   *  or undefined when no source is live for it yet. The brain forwards this to the
   *  compositor's `upsertItem(item, source)` so the compositor paints it. */
  mediaSourceFor(itemId: string): MediaSourceHandle | undefined;
  /** Publish the composited 9:16 video OUTPUT track (the compositor's
   *  `getOutputTrack()`) to the room. No-op in audio-only (no track). */
  publishVideoTrack(room: DirectorRoomHandle, track: unknown): Promise<void>;
  /** RE-PUBLISH the video OUTPUT track after a scene HOT-SWAP — only meaningful on a
   *  platform whose compositor output track CHANGES across scenes (RN's single-source
   *  passthrough: a different scene ⇒ a different camera track). The platform should swap
   *  the new track onto the EXISTING publication's sender in place (LiveKit
   *  `LocalTrack.replaceTrack` / `RTCRtpSender.replaceTrack`) — NO unpublish-then-publish
   *  black window, the SFU keeps the same publication and renegotiates the track. Web's
   *  canvas output track is STABLE across scene switches (the same track is already
   *  published every frame reflects the new scene), so web OMITS this — the brain calls it
   *  via optional-chaining, so an absent impl is a correct no-op. `track` null ⇒ the new
   *  scene has no video (drop to no-video); the platform decides whether to mute/unpublish.
   *  OPTIONAL — only RN-style passthrough compositors implement it. */
  republishVideoTrack?(room: DirectorRoomHandle, track: unknown): Promise<void>;
  /** Register a SAFETY-NET callback the platform invokes when the PUBLISHED video track is
   *  lost unexpectedly (track `ended`/`mute`, transceiver gone, or the output track became
   *  null) — so the brain can re-provision the active scene + re-publish a live camera track
   *  back to the SFU rather than leaving viewers on a frozen/black feed. The platform owns
   *  the detection (it holds the LiveKit publication + RTCRtpSender); the brain owns the
   *  RECOVERY (re-provision active scene → grab the fresh compositor output → republish).
   *  Returns an unsubscribe. OPTIONAL — web's stable canvas track never ends mid-stream, so
   *  web OMITS it; the brain wires it via optional-chaining. */
  onVideoTrackLost?(cb: () => void): () => void;
  /** Publish the mic. Best-effort in video mode (a denied mic leaves a video-only
   *  stream); REQUIRED in audio-only (THROWS when absent — it's the whole stream). */
  publishMic(room: DirectorRoomHandle, audioOnly: boolean): Promise<void>;
  /** Build the producer transport over THIS room's `overlay` data channel
   *  (web `createOverlayChannel(room)`). */
  buildTransport(room: DirectorRoomHandle): DirectorTransport;
  /** Disconnect the room, DELETE it server-side, and RELEASE capture (unless local
   *  preview still needs it). Best-effort throughout (web `endLive` teardown). */
  closeRoom(room: DirectorRoomHandle, roomName: string | null): Promise<void>;
}

// ── The materials runtime seam (byte-fetch + render, over the §1.1 grant path) ─

/** The web-only DocPayload render + preload-cache runtime the core deliberately
 *  excludes (pdf.js / RN native render). The grant/freshness LOGIC is shared
 *  (`MaterialsClient` + `buildManifestEntries`); THIS is the platform render that
 *  consumes a granted URL. Mirrors web's `materialsApi` render half. */
export interface DirectorMaterialsRuntime {
  /** Build a live-pushable DocPayload from a (renderable) material, scoped to a
   *  room (grant + render). Web: `buildDocPayloadFromMaterial`. */
  buildDocPayload(material: DirectorMaterial, roomName: string): Promise<DocPayload>;
  /** Warm an entire material manifest into the in-memory preload cache, reporting
   *  cumulative loaded bytes for a progress bar. Web: `warmManifest`. */
  warmManifest(
    manifest: LiveManifest,
    cache: DirectorPreloadCache,
    onProgress?: (loadedBytes: number) => void,
  ): Promise<void>;
}

/** The minimal material shape the director runtime needs — id + size + kind. A
 *  superset (web `MaterialMeta` / a timeline material) is structurally assignable. */
export interface DirectorMaterial {
  id: string;
  sizeBytes: number;
  kind: string;
}

/** The in-memory preload cache the brain reads a pre-warmed DocPayload from (the
 *  §preload `PreloadCache`). Structural so the platform passes its instance. */
export interface DirectorPreloadCache {
  has(id: string): boolean;
  get(id: string): { id: string; doc: DocPayload; bytes: number } | undefined;
  set(id: string, entry: { id: string; doc: DocPayload; bytes: number }): void;
}

// ── The store handles the brain reads (the §1.2/§1.3 stores) ─────────────────

/** The scenes store the brain reads (the §1.2 `ScenesState` store). The brain
 *  reads the active scene + its items, and subscribes to detect a hot-swap. */
export type DirectorScenesStore = StoreHandle<ScenesState>;

/** The scheduling store the brain reads (the §1.3 `StudioSchedulingState` store),
 *  to find the running class's renderable materials. */
export type DirectorSchedulingStore = StoreHandle<StudioSchedulingState> & {
  /** Stop running the class timeline (web `setActiveStream(null)` on end-live).
   *  Optional — a platform without a scheduling runner can omit it. */
  setActiveStream?(streamId: string | null): void;
};

// ── A pushable overlay (the minimal draft both a timeline item + a doc satisfy) ─

/** A pushable overlay — the minimal shape both an authored timeline overlay item
 *  (`{kind,title,payload}`) and a built `doc` payload satisfy (web `PushableOverlay`).
 *  The session assigns the live id/gen; the caller provides kind + payload (+ an
 *  optional stable id so re-pushing the same item keeps a stable overlay id). */
export interface PushableOverlay {
  id?: string;
  kind: AuthoredKind;
  title?: string;
  payload: AuthoredPayload;
}

// ── The dependency bag handed to createDirectorSession ───────────────────────

/** Everything the director session binds to (DI), so the brain imports no platform
 *  module. Mirrors how `createStudioSync` takes its store/auth/client deps. */
export interface DirectorDeps {
  /** The producer media seam (room + capture + publish + transport build). */
  media: DirectorMedia;
  /** The platform compositor factory (§1.4) — one fresh `Compositor` per go-live. */
  compositorFactory: CompositorFactory;
  /** The §1.1 materials grant client (fresh presigned URLs) + the platform render
   *  runtime that consumes a granted URL (pdf.js / RN). */
  materials: MaterialsClient;
  materialsRuntime: DirectorMaterialsRuntime;
  /** A fresh, empty in-memory preload cache factory (web `newPreloadCache`). */
  newPreloadCache: () => DirectorPreloadCache;
  /** The §1.2 scenes store the brain reads (active scene + items + hot-swap). */
  scenes: DirectorScenesStore;
  /** The §1.3 scheduling store the brain reads (running class materials). */
  scheduling: DirectorSchedulingStore;
  /** Whether a usable auth token exists right now (web `isAuthed`). Go-live is
   *  blocked when false. */
  isAuthed(): boolean;
  /** Scrub the session on a 401 (web `clearAuthOnUnauthorized`). Optional. */
  onUnauthorized?(): void;
  /** Read the selected mic device the producer picked, threaded to `publishMic` via
   *  the media seam — kept here only if the platform's media seam needs it
   *  surfaced; web reads it inside `publishMic`. Optional. */
}

// ── The reactive state the session exposes (mirrors web's LiveState slots) ───

/** The producer session STATE a platform store mirrors. Mirrors the reactive slots
 *  of web's `LiveState` (minus the action methods, which are the session API). */
export interface DirectorState {
  status: DirectorStatus;
  roomName: string | null;
  visibility: DirectorVisibility;
  /** True when the current stream is mic-only (no scene/video track). */
  audioOnly: boolean;
  error: string | null;
  /** Set while acquiring a scene's camera/screen inputs before publishing. */
  provisioning: string | null;
  /** The connected room handle (opaque), or null. */
  room: DirectorRoomHandle | null;
  /** The live DOC (image/PDF/EPUB), or null. */
  activeDoc: OverlayInstance | null;
  /** The live participation overlay (poll/quiz/vote), or null. */
  activeOverlay: OverlayInstance | null;
  /** Live tallies for the participation overlay slot. */
  results: DirectorResultsMsg | null;
  /** The running class's material manifest, or null. */
  manifest: LiveManifest | null;
  /** Streamer-side preload progress (0..1). 1 = warm (or no materials). */
  preloadProgress: number;
  /** The presenter's pan/zoom on the active doc, or null. */
  docPresenter: DocPresenterState | null;
  /** PER-SCENE served DOC fills (sceneId → itemId → live doc instance). */
  servedDocs: Record<string, Record<string, OverlayInstance>>;
  /** Monotonic scene-sync sequence. */
  sceneNonce: number;
  /** WHITEBOARD-ON-DOC ANNOTATION (Message D item 2): the streamer's active annotation
   *  descriptor for the live doc (`on` + active `wbann:…` `boardId` + `mode`), recomputed
   *  on every doc/page/mode change + `setDocAnnotation` toggle. Mirrored to the platform
   *  store so the operator's pen-toggle UI reflects it. Null ⇒ no active doc to annotate. */
  docAnn: DocAnnotationState | null;
  /** SYNCED placed-whiteboard view-flags, keyed by layout-item id: `transparent` +
   *  `hidden`. These are NOT operator-local — they ride `scene.sync` (transparent in the
   *  board payload; hidden drops the board from the viewer set), so every viewer reflects
   *  the operator's choice. Mirrored to the store so the operator tile's toggles are
   *  controlled. Empty ⇒ all placed boards opaque + visible. */
  wbSettings: Record<string, WhiteboardItemSettings>;
}

/** The handle `createDirectorSession` returns — the producer API surface (mirrors
 *  web `LiveState`'s actions) + a `getState`/`subscribe` so a platform store mirrors
 *  the reactive state. */
export interface DirectorSession {
  /** Read the current producer state snapshot. */
  getState(): DirectorState;
  /** Subscribe to state changes (the platform store mirrors into its own shape).
   *  Returns an unsubscribe. */
  subscribe(listener: (state: DirectorState) => void): () => void;

  // ── Producer lifecycle (mirrors web LiveState actions byte-for-byte) ────────
  goLive(title: string, visibility: DirectorVisibility, audioOnly?: boolean): Promise<void>;
  endLive(): Promise<void>;
  /** Route a pushable to its slot by kind (doc → activeDoc, poll/quiz/vote →
   *  activeOverlay) and sync it. Never populates both slots. */
  activate(draft: PushableOverlay): void;
  /** Display a renderable material as the live DOC slot (cache-fast, grant-fallback). */
  displayMaterial(itemId: string, material: DirectorMaterial): Promise<void>;
  /** Close one slot ('doc' or 'overlay'); broadcasts the clear. */
  closeActive(slot: 'doc' | 'overlay'): void;
  /** Reveal the active participation overlay's results. */
  reveal(): void;
  /** RESET the active poll/quiz so everyone can re-answer (gen bump). */
  refreshActive(): void;
  /** RESET a SPECIFIC poll/quiz/vote by its served overlay id. */
  refreshOverlayId(overlayId: string): void;
  /** Flip the live DOC slot to a page; re-broadcasts so viewers follow. */
  setDocPage(page: number): void;
  /** Update + broadcast the presenter's pan/zoom (throttled internally). */
  setDocPresenter(p: DocPresenterState): void;
  /** Toggle the live DOC's single⇆scroll view mode; broadcasts it on the presenter so
   *  every viewer mirrors it (R1). No-op with no active doc. */
  setDocMode(mode: DocViewMode): void;
  /** WHITEBOARD-ON-DOC ANNOTATION (Message D item 2): toggle the streamer-only
   *  annotation layer over the live doc on/off, then broadcast the descriptor so viewers
   *  show/hide it. No-op with no active doc. The strokes themselves ride the SAME
   *  `overlay.wb.*` wire keyed by the active `wbann:…` board id. */
  setDocAnnotation(on: boolean): void;
  /** SYNCED whiteboard view-flags (placed board, keyed by layout-item id): set the
   *  transparent background — rebroadcasts the scene so every viewer renders the SAME
   *  transparency (NOT operator-local). */
  setWhiteboardTransparent(itemId: string, transparent: boolean): void;
  /** SYNCED whiteboard view-flags: set viewer-visibility — when hidden the board is
   *  DROPPED from the viewer's rendered set ("for viewers it's gone") while the operator
   *  keeps a ghosted tile. Rebroadcasts the scene. */
  setWhiteboardHidden(itemId: string, hidden: boolean): void;
  /** Broadcast the doc slot + selected scene + manifest live-sync. */
  broadcastLiveSync(): void;
  /** Broadcast the COMPLETE rendered overlay set for the current scene. */
  broadcastScene(): void;
  /** PUBLISH the pre-join PREP manifest to the room listing. */
  publishManifest(): void;
  /** LIVE serve an authored overlay (poll/quiz/vote) to a slot in the CURRENT scene.
   *  Returns the served slot id, or null on a NO-OP. */
  serveOverlayToSlot(body: { kind: AuthoredKind; title: string; payload: AuthoredPayload }, itemId?: string): string | null;
  /** LIVE serve a material (doc) to a slot in the CURRENT scene. Returns the served
   *  slot id, or null on a NO-OP. */
  serveMaterialToSlot(material: DirectorMaterial, itemId?: string): Promise<string | null>;
}

// Re-export the scheduling/scenes payload types the deps reference, so a platform
// binding gets the whole contract from `@paxpia/core/director`.
export type { ScenesState } from '../studio/types';
export type { StudioSchedulingState } from '../studio/sync';
export type { ScheduledStream } from '../scheduling/types';
