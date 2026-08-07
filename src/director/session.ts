// createDirectorSession — THE HEADLESS PRODUCER-DIRECTION BRAIN (audit step 2.1).
//
// Lifted out of `Paxpia-web/src/store/live.ts` (~925 lines) so the producer
// lifecycle — go-live, serve-to-slot, scene broadcast, vote aggregation, manifest
// warm, doc page/presenter sync — exists ONCE and the mobile creator studio
// (Wave 3) binds to the same brain instead of re-forking ~900 lines.
//
// ── Framework-light, like `createStudioSync` (NOT a React hook) ───────────────
// No React, no zustand, no DOM, no RN, no `livekit-client`. The brain holds its own
// mutable state, exposes a `getState`/`subscribe`, and orchestrates over the
// injected seams (`DirectorTransport`/`DirectorMedia`/`Compositor`/`MaterialsClient`
// + the scenes/scheduling `StoreHandle`s). The web `store/live.ts` becomes a thin
// zustand binding that constructs this and mirrors `getState()` into its store.
//
// The pure DECISIONS (vote-aggregation reconcile, serve-to-slot target, scene
// snapshot/projection) live in `logic.ts` (unit-tested with no seams); this file is
// the lifecycle + state shell wiring them to the transport/media/compositor.

import {
  clearSlot,
  setSlot,
  slotForKind,
  docViewModeOf,
  type DocPresenterState,
  type DocViewMode,
  type ManifestEntry,
} from '../streaming/live';
import { docAnnotationStateFor, docAnnotationDocId, type DocAnnotationState } from '../overlays/annotation';
import type { DocPayload, OverlayInstance } from '../overlays/types';
import { buildManifest, manifestEntry } from '../streaming/viewer';
import { getCachedDoc } from '../streaming/preload';
import { buildRenderedScene } from '../streaming/scene';
import { deriveManifest } from '../streaming/prep';
import { resolveOverlayTarget } from '../overlays/target';
import { buildManifestEntries } from '../materials/grant';
import { activeScene as readActiveScene } from '../studio/scenes';
import type { ScheduledStream, TimelineMaterialItem } from '../scheduling/types';
import {
  currentSceneSlots,
  deriveSceneItems,
  docForSceneSwitch,
  overlaySlotHostId,
  reconcileOverlayChanged,
  reconcileResultsGen,
  resolveDocServeTarget,
  resolveOverlayServeTarget,
  sceneFillFor,
  snapshotScene,
  type ServedDocs,
  type WhiteboardItemSettings,
} from './logic';
import type {
  DirectorDeps,
  DirectorMaterial,
  DirectorPreloadCache,
  DirectorRoomHandle,
  DirectorSession,
  DirectorState,
  DirectorTransport,
  DirectorVisibility,
  PushableOverlay,
} from './types';

// Core's lib is ES2020 only; setTimeout/clearTimeout aren't in it but both browser
// and RN expose them on globalThis (same pattern as studio/sync.ts).
type TimerHandle = unknown;
const gg = globalThis as unknown as {
  setTimeout: (cb: () => void, ms: number) => TimerHandle;
  clearTimeout: (h: TimerHandle) => void;
};

/** Presenter (pan/zoom) broadcast throttle, ms — coalesces a high-frequency gesture
 *  (the web store used 120ms). */
const PRESENTER_THROTTLE_MS = 120;

/** The initial producer state (mirrors web `LiveState`'s defaults). */
function initialState(): DirectorState {
  return {
    status: 'idle',
    roomName: null,
    visibility: 'public',
    audioOnly: false,
    error: null,
    provisioning: null,
    room: null,
    activeDoc: null,
    activeOverlay: null,
    results: null,
    manifest: null,
    preloadProgress: 1,
    docPresenter: null,
    servedDocs: {},
    servingDocs: {},
    sceneNonce: 0,
    docAnn: null,
    wbSettings: {},
  };
}

/** Compute the WHITEBOARD-ON-DOC annotation descriptor for the current doc state
 *  (Message D item 2). Null when there's no active doc to annotate. The board id is
 *  derived from the doc INSTANCE id + current page + view mode via `docAnnotationStateFor`,
 *  so a page flip / doc switch / mode change yields a DIFFERENT board (per-page/per-doc
 *  strokes that SWAP, never bleed); producer + viewer derive the SAME id, so they agree
 *  on the active board with no negotiation. */
function computeDocAnn(
  doc: OverlayInstance | null,
  presenter: DocPresenterState | null,
  on: boolean,
): DocAnnotationState | null {
  if (!doc || doc.kind !== 'doc') return null;
  const payload = doc.payload as DocPayload;
  const page = payload.page ?? 0;
  // Key the annotation off the stable DOCUMENT identity (path-stripped source URL), NOT the
  // slot/instance id — so swapping a different doc into the same slot starts a BLANK board
  // (item 7) while re-serving the SAME doc resumes its strokes.
  const docId = docAnnotationDocId(doc.id, payload.sourceUrl);
  return docAnnotationStateFor(docId, page, docViewModeOf(presenter), on);
}

/** Value-equality for two annotation descriptors (avoids a spurious store update +
 *  re-render when the recomputed descriptor is identical). */
function docAnnEq(a: DocAnnotationState | null, b: DocAnnotationState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.on === b.on && a.boardId === b.boardId && a.mode === b.mode;
}

export function createDirectorSession(deps: DirectorDeps): DirectorSession {
  const {
    media,
    compositorFactory,
    materials,
    materialsRuntime,
    scenes,
    scheduling,
    isAuthed,
  } = deps;

  // ── State + subscription (the zustand-free analog of set/get/subscribe) ─────
  let state: DirectorState = initialState();
  const listeners = new Set<(s: DirectorState) => void>();
  const getState = (): DirectorState => state;
  function set(patch: Partial<DirectorState> | ((s: DirectorState) => Partial<DirectorState>)): void {
    const p = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...p };
    for (const l of listeners) l(state);
  }
  function subscribe(listener: (s: DirectorState) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // ── Module-scoped (non-reactive) handles — exactly the web store's module vars ─
  let compositor: ReturnType<typeof compositorFactory> | null = null;
  let channel: DirectorTransport | null = null;
  let room: DirectorRoomHandle | null = null;
  let gen = 0;
  // The id of the participation overlay the STREAMER chose (P0.2 streamer-authoritative).
  let localOverlayId: string | null = null;
  // The (id, gen) of the participation round the streamer just CLOSED via "None". The bot
  // keeps `current` pointed at the closed overlay and re-echoes it (overlay.changed, same
  // id+gen) on close + on join, so without this the cleared slot snaps back to that quiz.
  // We ignore echoes of this exact round until a NEW activation bumps gen / changes id.
  let closedOverlay: { id: string; gen: number } | null = null;
  // Per-overlay LAST gen the streamer used (overlay id → gen), so re-serving the SAME
  // overlay reuses its gen and votes PERSIST across a swap-out-and-back (P1.4).
  const overlayGens = new Map<string, number>();
  // Unsubscribe for the scenes-store subscription that re-broadcasts on scene swap.
  let scenesUnsub: (() => void) | null = null;
  // Unsubscribe for the media seam's "published video track lost" safety-net hook.
  let videoLostUnsub: (() => void) | null = null;
  // Unsub for the compositor's "output track ready" callback (RN async composite mint).
  let compositorReadyUnsub: (() => void) | null = null;
  // Guards against re-entrant recovery (a track-lost event firing while we're already
  // re-provisioning + republishing).
  let recoveringVideo = false;
  let disableAggregator: (() => void) | null = null;
  // In-memory preload cache for the running class's materials (id → rendered doc).
  let preloadCache: DirectorPreloadCache = deps.newPreloadCache();
  // Throttle handle for presenter (pan/zoom) broadcasts.
  let presenterTimer: TimerHandle | null = null;
  // WHITEBOARD-ON-DOC ANNOTATION toggle INTENT (Message D item 2). The active board id is
  // derived from the doc+page+mode; THIS holds only whether the streamer has the layer on.
  // The descriptor (`state.docAnn`) is recomputed from this + the active doc on every
  // broadcast, so a page flip / doc switch swaps the board while honoring the toggle.
  let annOn = false;

  // ── Scene read helpers (off the injected scenes store) ──────────────────────
  /** The producer's active Scene snapshotted to the wire `LiveScene` shape. */
  function snapshotActiveScene(): { id: string; scene: ReturnType<typeof snapshotScene> } {
    const s = readActiveScene(scenes.getState());
    return { id: s.id, scene: snapshotScene(s) };
  }
  /** Seed/refresh the compositor with a scene (the real layout `Scene`) and bind each
   *  camera/screen item's live media source — the §1.4 seam drive. The web compositor
   *  self-reads its store so these calls are advisory there; an RN compositor uses
   *  them to build its tile tree. */
  function seedCompositorScene(sceneId: string): void {
    if (!compositor) return;
    const s = readActiveScene(scenes.getState());
    const scene = s.id === sceneId ? s : (scenes.getState().scenes.find((sc) => sc.id === sceneId) ?? s);
    compositor.setScene(scene);
    for (const item of scene.items) {
      if (item.type !== 'camera' && item.type !== 'screen') continue;
      compositor.upsertItem(item, media.mediaSourceFor(item.id));
    }
  }
  /** RE-PUBLISH the compositor's CURRENT output video track to the SFU after a scene
   *  hot-swap (or a recovery). On a platform whose compositor output track is STABLE
   *  across scenes (web canvas), `media.republishVideoTrack` is absent and this is a
   *  correct no-op — the already-published track keeps carrying the new scene content.
   *  On RN's single-source passthrough the output track CHANGES per scene, so this swaps
   *  the new camera track onto the existing publication's sender in place (the platform
   *  uses `replaceTrack` — no unpublish/publish black window). Null track ⇒ the new scene
   *  has no video; the platform decides (mute/keep). Best-effort: a republish failure must
   *  never crash the live session (the safety net + next switch can recover). */
  async function republishOutputTrack(): Promise<void> {
    if (!room || state.audioOnly || !compositor) return;
    if (!media.republishVideoTrack) return; // stable-track platform (web) → nothing to do
    const vtrack = compositor.getOutputTrack();
    try {
      await media.republishVideoTrack(room, vtrack ?? null);
    } catch {
      /* best-effort — the safety net / next scene switch can recover */
    }
  }

  /** SAFETY NET — the published video track was lost unexpectedly (track `ended`/`mute`,
   *  transceiver gone, or the compositor output became null). RE-PROVISION the active
   *  scene's media (the camera may have been stopped/dropped), re-seed the compositor so
   *  its output points at a LIVE track again, then RE-PUBLISH that track back to the SFU —
   *  so a lost feed always heals back to LiveKit instead of only showing in the local
   *  preview. Re-entrancy-guarded; best-effort; only meaningful while live + video. */
  async function recoverVideoTrack(): Promise<void> {
    if (recoveringVideo) return;
    if (state.status !== 'live' || state.audioOnly || !room || !compositor) return;
    recoveringVideo = true;
    try {
      const sceneId = activeSceneId();
      try {
        await media.provisionScene(sceneId, (msg) => set({ provisioning: msg }));
      } catch {
        /* a denied/failed re-acquire still lets us try whatever source is live */
      } finally {
        set({ provisioning: null });
      }
      // Re-bind the (possibly fresh) sources to the compositor, then republish its output.
      seedCompositorScene(sceneId);
      compositor.setActiveScene(sceneId);
      await republishOutputTrack();
    } finally {
      recoveringVideo = false;
    }
  }

  /** The active scene's id (off the store). */
  function activeSceneId(): string {
    return readActiveScene(scenes.getState()).id;
  }
  /** The CURRENT scene's resolver slots (filled reflecting served docs). */
  function sceneSlotsNow(servedDocs: ServedDocs): { sceneId: string; slots: ReturnType<typeof currentSceneSlots> } {
    const s = readActiveScene(scenes.getState());
    return { sceneId: s.id, slots: currentSceneSlots(s, servedDocs) };
  }

  /** The renderable material ids the running class will show (its timeline material
   *  items). Empty when no class is running or it has no docs. Mirrors web
   *  `runningClassMaterials`. */
  function runningClassMaterials(): TimelineMaterialItem['material'][] {
    const st = scheduling.getState();
    const sched = st.scheduled as ScheduledStream[];
    const run = sched.find((s) => s.id === st.activeStreamId);
    if (!run) return [];
    return run.items
      .filter((it): it is TimelineMaterialItem => it.kind === 'material' && it.material.kind === 'renderable')
      .map((it) => it.material);
  }

  /** Build an OverlayInstance from a pushable, minting an id when none supplied. */
  function buildInstance(d: PushableOverlay, g: number): OverlayInstance {
    const id = d.id ?? `ov_${Math.random().toString(36).slice(2, 9)}`;
    return { id, kind: d.kind, phase: 'active', gen: g, payload: d.payload, results: {} } as OverlayInstance;
  }

  // ── Broadcast (the producer signal fan-out) ─────────────────────────────────

  function broadcastLiveSync(): void {
    if (!channel || state.status !== 'live') return;
    const { id, scene } = snapshotActiveScene();
    // Recompute the annotation descriptor from the CURRENT doc/page/mode + toggle intent
    // (Message D item 2) so every doc/scene change + participant-join replay carries the
    // right `wbann:…` board + on/off. Mirror it to the store (set-if-changed) so the
    // operator's pen-toggle UI reflects it; the strokes ride the `overlay.wb.*` wire.
    const docAnn = computeDocAnn(state.activeDoc, state.docPresenter, annOn);
    if (!docAnnEq(docAnn, state.docAnn)) set({ docAnn });
    channel.publishLiveSync({
      t: 'live.sync',
      v: 1,
      sceneId: id,
      scene,
      doc: state.activeDoc,
      docPresenter: state.docPresenter,
      manifest: state.manifest,
      docAnn,
    });
  }

  function broadcastScene(): void {
    if (!channel || state.status !== 'live') return;
    const { scene } = snapshotActiveScene();
    const nonce = state.sceneNonce + 1;
    set({ sceneNonce: nonce });
    // The COMPLETE overlay set for THIS scene (P0.3 full-replace). Doc slots from the
    // per-scene served-doc map; the participation slot from the live activeOverlay at
    // the new scene's overlay rect (the FIRST overlay-type item in draw order hosts it);
    // and a placed WHITEBOARD slot from a synthesized `kind:'whiteboard'` instance so the
    // director's AUTHORITATIVE scene.sync carries the board to viewers (the §0.1 fix —
    // previously a whiteboard layout-item was silently dropped here).
    const activeOverlay = state.activeOverlay;
    const overlaySlotId = overlaySlotHostId(scene, activeOverlay);
    const rendered = buildRenderedScene(
      scene,
      nonce,
      // wbSettings carries the SYNCED whiteboard view-flags (transparent into the payload;
      // hidden DROPS the board from the viewer set — operator keeps a ghosted tile).
      sceneFillFor(scene, state.servedDocs, activeOverlay, overlaySlotId, state.wbSettings),
    );
    channel.publishScene(rendered);
    // ALONGSIDE the reliable in-room scene broadcast, refresh the room-listing PREP
    // manifest so a viewer who fetches the listing next sees the current shape.
    publishManifest();
  }

  function publishManifest(): void {
    const { roomName, status } = state;
    if (!roomName || status !== 'live') return;
    const { scene } = snapshotActiveScene();
    const activeOverlay = state.activeOverlay;
    const overlaySlotId = overlaySlotHostId(scene, activeOverlay);
    const items = deriveSceneItems(scene, state.servedDocs, activeOverlay, overlaySlotId);
    const derived = deriveManifest({ items }, { audio: true, sceneNonce: state.sceneNonce });
    // Fire-and-forget: a manifest PUT must never disrupt the live stream.
    channel?.publishManifest(roomName, derived);
  }

  // ── Producer lifecycle ──────────────────────────────────────────────────────

  async function goLive(title: string, visibility: DirectorVisibility, audioOnly = false): Promise<void> {
    if (state.status !== 'idle') return;

    if (!isAuthed()) {
      deps.onUnauthorized?.();
      set({ status: 'idle', error: 'Sign in to go live.' });
      return;
    }

    set({ status: 'connecting', error: null, visibility, audioOnly, provisioning: null });

    // ── Provision scene inputs BEFORE publishing ──────────────────────────────
    // A scene with a camera/screen item must have its media live, or the published
    // frame is black. Acquire missing input streams now and fail fast on a denial.
    if (!audioOnly) {
      const sceneId = activeSceneId();
      try {
        const hasMedia = media.sceneHasMedia(sceneId);
        const anyLive = await media.provisionScene(sceneId, (s) => set({ provisioning: s }));
        if (hasMedia && !anyLive) {
          throw new Error('No camera or screen is live — add and allow an input before going live.');
        }
      } catch (provErr) {
        set({
          status: 'idle',
          provisioning: null,
          error:
            provErr instanceof Error
              ? `Couldn't start your inputs — ${provErr.message}`
              : "Couldn't start your camera/screen inputs.",
        });
        return;
      }
    }
    set({ provisioning: null });

    try {
      const open = await media.openRoom(title, visibility);
      room = open.room;
      const roomName = open.roomName;

      // Video-only-mode publishes the compositor; audio-only skips it entirely.
      if (!audioOnly) {
        compositor = compositorFactory();
        const sceneId = activeSceneId();
        // Seed the compositor with the active scene + media-item sources, then start.
        seedCompositorScene(sceneId);
        compositor.setActiveScene(sceneId);
        compositor.start();
        const vtrack = compositor.getOutputTrack();
        if (vtrack) await media.publishVideoTrack(room, vtrack);
        // SAFETY NET: if the published video track is ever lost (camera stopped, track
        // `ended`/`mute`, transceiver gone), re-provision + republish a live track back
        // to the SFU — never just leave viewers on a frozen feed (Noel's "renegotiate
        // back to LiveKit, not just the local preview"). Web omits the hook (stable
        // canvas track), so optional-chaining = no-op there.
        videoLostUnsub = media.onVideoTrackLost?.(() => void recoverVideoTrack()) ?? null;
        // The mobile composite output track is minted ASYNC; when it first resolves,
        // republish so the composite shows on its OWN scene at go-live (without it, the
        // first publish above is the passthrough primary / null and the composite only
        // appeared on the next scene switch, then dropped). Web omits the hook (no-op).
        compositorReadyUnsub = compositor.onOutputTrackReady?.(() => { void republishOutputTrack(); }) ?? null;
      }

      // Mic: best-effort with video, REQUIRED in audio-only (the media seam throws).
      await media.publishMic(room, audioOnly);

      channel = media.buildTransport(room);
      // No server overlays bot → the STREAMER's room is the authoritative aggregator.
      disableAggregator = channel.enableAggregator(() => state.activeOverlay);
      // The bot owns the participation overlay slot; route its echo there (P0.2).
      channel.onOverlayChanged((e) => {
        const decision = reconcileOverlayChanged(e.overlay, state.activeOverlay, localOverlayId, closedOverlay);
        if (decision.action === 'ignore') return;
        if (decision.action === 'clear') {
          set({ activeOverlay: null });
          broadcastScene();
          return;
        }
        set({ activeOverlay: decision.overlay });
        broadcastScene();
      });
      channel.onResults((r) =>
        set((s) => {
          // Ignore a late results tick for a round the streamer just closed (don't repopulate).
          if (closedOverlay && r.overlayId === closedOverlay.id && r.gen <= closedOverlay.gen) return {};
          const a = s.activeOverlay;
          const { adopt, gen: g } = reconcileResultsGen(a, r.overlayId, r.gen);
          return adopt ? { results: r, activeOverlay: { ...a!, gen: g } } : { results: r };
        }),
      );
      // On a participant join, replay the doc slot + scene + full overlay set.
      channel.onParticipantConnected(() => {
        broadcastLiveSync();
        broadcastScene();
      });

      // Re-broadcast + re-provision whenever the streamer hot-swaps scenes.
      scenesUnsub?.();
      let lastSceneId = activeSceneId();
      scenesUnsub = scenes.subscribe((s) => {
        const nextId = readActiveScene(s).id;
        if (nextId === lastSceneId) return;
        lastSceneId = nextId;
        if (state.status !== 'live') return;
        // Rebuild the live DOC slot from the NEW scene's served-doc fill (or clear it).
        const nextDoc = docForSceneSwitch(nextId, state.servedDocs);
        set({ activeDoc: nextDoc, docPresenter: nextDoc ? state.docPresenter : null });
        // Tell the compositor to hot-swap. On web the output track is STABLE (only its
        // content changes); on RN's single-source passthrough the output track CHANGES to
        // the new scene's primary camera — so after the new media is provisioned we must
        // RE-PUBLISH that track to the SFU (otherwise the SFU keeps the OLD, now-stale track
        // and the viewer's video drops on every scene switch — WI-8).
        // Flip the active scene NOW (so useComposite() reflects it for already-live shared
        // sources), but do NOT eager-seed here: the eager seed pushed a layout for sources
        // not yet live AND double-seeded with the post-provision seed below, thrashing the
        // native sinks and momentarily dropping the composite (~2s flash). The authoritative
        // seed + republish run ONCE after provision (below), when the new sources are live.
        compositor?.setActiveScene(nextId);
        // Acquire the new scene's media, THEN republish the (possibly changed) output track
        // and re-broadcast layout + overlays. Provision is sequenced (awaited) before the
        // republish so the new camera stream is live when we grab the compositor output —
        // closing the "fire-and-forget provision races the republish" gap.
        void media
          .provisionScene(nextId, (msg) => set({ provisioning: msg }))
          .catch((err) => {
            set({
              provisioning: null,
              error: err instanceof Error ? `Scene input not started — ${err.message}` : null,
            });
          })
          .then(async () => {
            // The provision may have acquired new sources — rebind them to the compositor,
            // then swap the new output track onto the existing LiveKit publication in place
            // (RN: replaceTrack, no black window; web: no-op, stable track).
            seedCompositorScene(nextId);
            await republishOutputTrack();
          })
          .finally(() => {
            set({ provisioning: null });
            broadcastLiveSync();
            broadcastScene();
          });
      });

      // ── Build the material MANIFEST + warm the in-memory preload cache ────────
      preloadCache = deps.newPreloadCache();
      try {
        const classMaterials = runningClassMaterials();
        if (classMaterials.length > 0) {
          set({ preloadProgress: 0 });
          const entries: ManifestEntry[] = await buildManifestEntries(
            materials,
            classMaterials.map((m) => m.id),
            roomName,
          );
          const built = buildManifest(entries);
          set({ manifest: built, preloadProgress: built.totalSizeBytes > 0 ? 0 : 1 });
          await materialsRuntime.warmManifest(built, preloadCache, (loaded) => {
            const total = built.totalSizeBytes;
            set({ preloadProgress: total > 0 ? Math.min(1, loaded / total) : 1 });
          });
          set({ preloadProgress: 1 });
        } else {
          set({ manifest: null, preloadProgress: 1 });
        }
      } catch (preErr) {
        set({ preloadProgress: 1, error: preErr instanceof Error ? `Materials preload: ${preErr.message}` : null });
      }

      annOn = false;
      // wbSettings is NOT reset here — a transparent/hidden choice made in the setup
      // PREVIEW carries into the live stream (it's reset only on endLive). servedDocs +
      // docAnn DO reset (a fresh stream shows no doc until served).
      set({ status: 'live', roomName, room, servedDocs: {}, sceneNonce: 0, docAnn: null });
      broadcastLiveSync();
      broadcastScene();
    } catch (e) {
      videoLostUnsub?.();
      videoLostUnsub = null;
      compositorReadyUnsub?.();
      compositorReadyUnsub = null;
      compositor?.stop();
      compositor = null;
      scenesUnsub?.();
      scenesUnsub = null;
      disableAggregator?.();
      disableAggregator = null;
      channel?.dispose();
      channel = null;
      const r = room;
      room = null;
      if (r) await media.closeRoom(r, state.roomName).catch(() => undefined);
      set({ status: 'idle', provisioning: null, room: null, error: e instanceof Error ? e.message : 'go live failed' });
    }
  }

  async function endLive(): Promise<void> {
    const roomName = state.roomName;
    // Tell viewers to wipe BOTH slots before we drop the channel.
    if (channel) {
      try {
        channel.publishLiveSync({ t: 'live.sync', v: 1, doc: null, sceneId: null, scene: null });
      } catch {
        /* best-effort */
      }
    }
    videoLostUnsub?.();
    videoLostUnsub = null;
    compositorReadyUnsub?.();
    compositorReadyUnsub = null;
    recoveringVideo = false;
    scenesUnsub?.();
    scenesUnsub = null;
    disableAggregator?.();
    disableAggregator = null;
    channel?.dispose();
    channel = null;
    compositor?.stop();
    compositor = null;
    const r = room;
    room = null;
    await media.closeRoom(r, roomName).catch(() => undefined);
    if (presenterTimer) {
      gg.clearTimeout(presenterTimer);
      presenterTimer = null;
    }
    preloadCache = deps.newPreloadCache();
    localOverlayId = null;
    closedOverlay = null;
    overlayGens.clear();
    annOn = false;
    scheduling.setActiveStream?.(null);
    set({
      status: 'idle',
      roomName: null,
      room: null,
      activeDoc: null,
      activeOverlay: null,
      results: null,
      manifest: null,
      preloadProgress: 1,
      docPresenter: null,
      servedDocs: {},
      servingDocs: {},
      sceneNonce: 0,
      audioOnly: false,
      provisioning: null,
      docAnn: null,
      wbSettings: {},
    });
  }

  function activate(draft: PushableOverlay): void {
    if (!channel) return;
    const slot = slotForKind(draft.kind);
    if (slot === 'doc') {
      // Doc slot: web-only, broadcast via live-sync. Stable id; mint a gen only on
      // first push of this id so re-pushing the same material is stable.
      const prev = state.activeDoc;
      const g = prev && prev.id === draft.id ? prev.gen : (gen += 1);
      const inst = buildInstance(draft, g);
      const { sceneId, slots } = sceneSlotsNow(state.servedDocs);
      const docSlotId = resolveOverlayTarget(slots, 'doc', undefined).targetId;
      set((s) => {
        const slotted = setSlot({ activeDoc: s.activeDoc, activeOverlay: s.activeOverlay }, inst);
        const servedDocs = docSlotId
          ? { ...s.servedDocs, [sceneId]: { ...(s.servedDocs[sceneId] ?? {}), [docSlotId]: inst } }
          : s.servedDocs;
        return { ...slotted, servedDocs };
      });
      broadcastLiveSync();
      broadcastScene();
      return;
    }
    // Participation overlay slot: server-authoritative via the bot. REUSE this
    // overlay's last gen so a swap-out-and-back RETAINS its votes (P1.4).
    const draftId = draft.id ?? `ov_${Math.random().toString(36).slice(2, 9)}`;
    const prevGen = overlayGens.get(draftId);
    const g = prevGen ?? (gen += 1);
    overlayGens.set(draftId, g);
    const inst = buildInstance({ ...draft, id: draftId }, g);
    // Mark the streamer's CURRENT selection so a stale echo can't flash it back (P0.2).
    localOverlayId = inst.id;
    // A new activation supersedes any closed-round guard (re-serving the SAME id must stick).
    closedOverlay = null;
    channel.createAndActivate(inst);
    // Reflect it locally right away; the onOverlayChanged echo reconciles after.
    set((s) => ({ ...setSlot({ activeDoc: s.activeDoc, activeOverlay: s.activeOverlay }, inst), results: null }));
    broadcastScene();
  }

  async function displayMaterial(itemId: string, material: DirectorMaterial): Promise<void> {
    if (!channel) return;
    const { roomName } = state;
    // FAST PATH: pre-warmed on go-live → read its rendered DocPayload from memory.
    let payload = getCachedDoc(preloadCache as never, material.id);
    if (!payload && roomName) {
      payload = await materialsRuntime.buildDocPayload(material, roomName);
      preloadCache.set(material.id, { id: material.id, doc: payload, bytes: material.sizeBytes });
    }
    if (!payload) throw new Error('Room not ready yet.');
    // Reset the presenter transform (start fitted) BEFORE activate(), so the single
    // live-sync broadcast carries the fresh presenter state.
    set({ docPresenter: { page: payload.page, zoom: 1, panX: 0, panY: 0 } });
    activate({ id: itemId, kind: 'doc', title: payload.title, payload });
  }

  function closeActive(slot: 'doc' | 'overlay'): void {
    if (slot === 'doc') {
      const sceneId = activeSceneId();
      set((s) => {
        const sceneDocs = { ...(s.servedDocs[sceneId] ?? {}) };
        for (const k of Object.keys(sceneDocs)) delete sceneDocs[k];
        const servedDocs = { ...s.servedDocs };
        if (Object.keys(sceneDocs).length === 0) delete servedDocs[sceneId];
        else servedDocs[sceneId] = sceneDocs;
        return { ...clearSlot({ activeDoc: s.activeDoc, activeOverlay: s.activeOverlay }, 'doc'), servedDocs };
      });
      broadcastLiveSync();
      broadcastScene();
      return;
    }
    const a = state.activeOverlay;
    if (channel && a) channel.closeOverlay(a.id);
    // Streamer took the overlay down → drop the local selection AND remember the closed
    // round so the bot's re-assert echo (same id+gen, phase 'closed') can't snap it back.
    localOverlayId = null;
    if (a && slotForKind(a.kind) === 'overlay') closedOverlay = { id: a.id, gen: a.gen };
    set((s) => ({ ...clearSlot({ activeDoc: s.activeDoc, activeOverlay: s.activeOverlay }, 'overlay') }));
    broadcastScene();
  }

  function reveal(): void {
    const a = state.activeOverlay;
    if (channel && a) channel.revealOverlay(a.id);
  }

  function refreshActive(): void {
    const a = state.activeOverlay;
    if (!channel || !a || a.kind === 'doc') return;
    const newGen = channel.refreshOverlay(a.id);
    if (newGen == null) return;
    gen = Math.max(gen, newGen);
    overlayGens.set(a.id, newGen);
    set({ activeOverlay: { ...a, gen: newGen, phase: 'active', results: {} }, results: null });
    broadcastScene();
  }

  function refreshOverlayId(overlayId: string): void {
    if (!channel) return;
    const newGen = channel.refreshOverlay(overlayId);
    if (newGen == null) return;
    gen = Math.max(gen, newGen);
    overlayGens.set(overlayId, newGen);
    const a = state.activeOverlay;
    if (a && a.id === overlayId) {
      set({ activeOverlay: { ...a, gen: newGen, phase: 'active', results: {} }, results: null });
      broadcastScene();
    }
  }

  function setDocPage(page: number): void {
    const a = state.activeDoc;
    if (!a || a.kind !== 'doc') return;
    const payload = a.payload as DocPayload;
    // Effective page total: the rendered page blobs (web operator path) OR the manifest's
    // pageCount (raw PDF/EPUB served by URL — `payload.pages` is EMPTY there, so the old
    // `pages.length - 1` clamp collapsed EVERY page to 0 → next/prev no-op'd for PDF + EPUB).
    // When neither is known yet (raw doc, no manifest count), don't cap — the frame clamps to
    // its discovered page count and reports the real page back.
    const entry = manifestEntry(state.manifest, a.id);
    const total = Math.max(payload.pages.length, entry?.pageCount && entry.pageCount > 0 ? entry.pageCount : 0);
    const clamped = total > 0 ? Math.max(0, Math.min(page, total - 1)) : Math.max(0, page);
    if (clamped === payload.page) return;
    const next = { ...a, payload: { ...payload, page: clamped } } as OverlayInstance;
    // A page flip PRESERVES the presenter ZOOM across pages (P1.3); only pan recentres.
    const sceneId = activeSceneId();
    const prevZoom = state.docPresenter?.zoom ?? 1;
    set((s) => {
      const sceneDocs = s.servedDocs[sceneId];
      let servedDocs = s.servedDocs;
      if (sceneDocs) {
        const slotId = Object.keys(sceneDocs).find((k) => sceneDocs[k].id === a.id);
        if (slotId) servedDocs = { ...s.servedDocs, [sceneId]: { ...sceneDocs, [slotId]: next } };
      }
      return { activeDoc: next, docPresenter: { page: clamped, zoom: prevZoom, panX: 0, panY: 0 }, servedDocs };
    });
    broadcastLiveSync();
    broadcastScene();
  }

  function setDocPresenter(p: DocPresenterState): void {
    const a = state.activeDoc;
    if (!a || a.kind !== 'doc') return;
    set({ docPresenter: p });
    // Throttle pan/zoom broadcasts — last write wins; a late joiner gets the latest.
    if (presenterTimer) return;
    presenterTimer = gg.setTimeout(() => {
      presenterTimer = null;
      broadcastLiveSync();
    }, PRESENTER_THROTTLE_MS);
  }

  /** Update a placed whiteboard's SYNCED view-flags (transparent / hidden) keyed by its
   *  layout-item id, then rebroadcast the scene so EVERY viewer reflects the change. A
   *  transparent toggle re-renders the board alpha-0 on all planes; a hidden toggle drops
   *  it from the viewer's rendered set (the operator keeps a ghosted tile). Pure-ish: only
   *  touches `wbSettings` + a scene rebroadcast. */
  function setWhiteboardSetting(itemId: string, patch: WhiteboardItemSettings): void {
    const boardKey = itemId; // wbSettings is keyed by the layout-item id
    set((s) => {
      const prev = s.wbSettings[boardKey] ?? {};
      const next: WhiteboardItemSettings = { ...prev, ...patch };
      if (prev.transparent === next.transparent && prev.hidden === next.hidden) return {};
      return { wbSettings: { ...s.wbSettings, [boardKey]: next } };
    });
    // The synced flags ride the rendered scene (transparent → payload; hidden → drop).
    broadcastScene();
  }
  function setWhiteboardTransparent(itemId: string, transparent: boolean): void {
    setWhiteboardSetting(itemId, { transparent });
  }
  function setWhiteboardHidden(itemId: string, hidden: boolean): void {
    setWhiteboardSetting(itemId, { hidden });
  }

  function setDocMode(mode: DocViewMode): void {
    const a = state.activeDoc;
    if (!a || a.kind !== 'doc') return;
    const prev = state.docPresenter;
    if (docViewModeOf(prev) === mode) return;
    const page = prev?.page ?? (a.payload as DocPayload).page ?? 0;
    // Carry the new mode on the presenter so every viewer mirrors the single⇆scroll toggle
    // (R1). broadcastLiveSync also recomputes docAnn — so the annotation board id swaps
    // between per-page (single) and per-doc (scroll) with the mode.
    set({ docPresenter: { page, zoom: prev?.zoom ?? 1, panX: prev?.panX ?? 0, panY: prev?.panY ?? 0, mode, scrollPos: prev?.scrollPos ?? 0 } });
    broadcastLiveSync();
  }

  function setDocAnnotation(on: boolean): void {
    // No active doc → nothing to annotate (the toggle intent is still recorded so a
    // subsequently-served doc honors it). Recompute + broadcast the descriptor so viewers
    // show/hide the layer; the strokes ride the `overlay.wb.*` wire keyed by the active
    // `wbann:…` board id (the operator's publisher uses `state.docAnn.boardId`).
    annOn = on;
    broadcastLiveSync();
  }

  function serveOverlayToSlot(
    body: { kind: PushableOverlay['kind']; title: string; payload: PushableOverlay['payload'] },
    itemId?: string,
  ): string | null {
    if (!channel || state.status !== 'live') return null;
    const { slots } = sceneSlotsNow(state.servedDocs);
    const targetId = resolveOverlayServeTarget(slots, body.kind, itemId);
    if (!targetId) return null; // no matching empty slot in this scene → NO-OP
    // The id is stable PER POLL IDENTITY (kind+title), so re-serving the SAME poll
    // resumes its round + RETAINS votes (P1.4). `activate` broadcasts the full scene.
    const overlayId = `srv_${body.kind}:${body.title}`;
    activate({ id: overlayId, kind: body.kind, title: body.title, payload: body.payload });
    return targetId;
  }

  // Per-slot in-flight flag bookkeeping (sceneId → itemId → true) so the operator slot can
  // show a LOADING spinner between the tap and the rendered doc. Pure set helper.
  function markServing(sceneId: string, targetId: string, on: boolean): void {
    set((s) => {
      const sceneServing = { ...(s.servingDocs[sceneId] ?? {}) };
      if (on) sceneServing[targetId] = true;
      else delete sceneServing[targetId];
      const servingDocs = { ...s.servingDocs };
      if (Object.keys(sceneServing).length === 0) delete servingDocs[sceneId];
      else servingDocs[sceneId] = sceneServing;
      return { servingDocs };
    });
  }

  async function serveMaterialToSlot(material: DirectorMaterial, itemId?: string): Promise<string | null> {
    // Works in BOTH preview and live. The slot-target math is pure (no room needed); only the
    // presigned grant needs a room scope. When NOT live, grant under the synthetic 'preview'
    // scope (ownership is enforced server-side per-caller, mirroring web preview.ts) so the
    // operator sees the doc in the scene preview BEFORE going live (the live-only guard here was
    // the bug: a doc pick in preview silently did nothing).
    const { sceneId, slots } = sceneSlotsNow(state.servedDocs);
    const targetId = resolveDocServeTarget(slots, itemId);
    if (!targetId) return null; // no empty doc slot in this scene → NO-OP

    let built: DocPayload;
    try {
      // Fast path (live, pre-warmed) reads the cache; else grant on demand under the live room
      // when live, otherwise the synthetic 'preview' scope.
      let payload = getCachedDoc(preloadCache as never, material.id);
      if (!payload) {
        markServing(sceneId, targetId, true);
        const roomName = state.roomName ?? 'preview';
        payload = await materialsRuntime.buildDocPayload(material, roomName);
        // Only cache under a REAL room — a 'preview'-scoped URL is short-lived and is re-granted
        // on go-live via the manifest warm.
        if (state.roomName) {
          preloadCache.set(material.id, { id: material.id, doc: payload, bytes: material.sizeBytes });
        }
      }
      built = payload;
    } catch (e) {
      markServing(sceneId, targetId, false);
      set({ error: e instanceof Error ? e.message : 'Could not load document.' });
      throw e;
    }

    const inst = buildInstance({ id: `srv_${targetId}`, kind: 'doc', title: built.title, payload: built }, (gen += 1));
    set((s) => {
      const sceneServing = { ...(s.servingDocs[sceneId] ?? {}) };
      delete sceneServing[targetId];
      const servingDocs = { ...s.servingDocs };
      if (Object.keys(sceneServing).length === 0) delete servingDocs[sceneId];
      else servingDocs[sceneId] = sceneServing;
      return {
        servedDocs: { ...s.servedDocs, [sceneId]: { ...(s.servedDocs[sceneId] ?? {}), [targetId]: inst } },
        activeDoc: inst,
        docPresenter: { page: built.page, zoom: 1, panX: 0, panY: 0 },
        servingDocs,
      };
    });
    // Broadcasts are internally guarded (no-op when not live), so calling them in preview is safe
    // and keeps the live path byte-for-byte identical.
    broadcastLiveSync();
    broadcastScene();
    return targetId;
  }

  /** Serve an already-built doc payload (a book's current chapter) directly into
   *  a slot — no grant to await, unlike `serveMaterialToSlot`. Works in both
   *  preview and live, same as the material path. */
  function serveDocPayloadToSlot(payload: DocPayload, itemId?: string): string | null {
    const { sceneId, slots } = sceneSlotsNow(state.servedDocs);
    const targetId = resolveDocServeTarget(slots, itemId);
    if (!targetId) return null; // no empty doc slot in this scene → NO-OP

    const inst = buildInstance({ id: `srv_${targetId}`, kind: 'doc', title: payload.title, payload }, (gen += 1));
    set((s) => ({
      servedDocs: { ...s.servedDocs, [sceneId]: { ...(s.servedDocs[sceneId] ?? {}), [targetId]: inst } },
      activeDoc: inst,
      docPresenter: { page: payload.page, zoom: 1, panX: 0, panY: 0 },
    }));
    broadcastLiveSync();
    broadcastScene();
    return targetId;
  }

  return {
    getState,
    subscribe,
    goLive,
    endLive,
    activate,
    displayMaterial,
    closeActive,
    reveal,
    refreshActive,
    refreshOverlayId,
    setDocPage,
    setDocPresenter,
    setDocMode,
    setDocAnnotation,
    setWhiteboardTransparent,
    setWhiteboardHidden,
    broadcastLiveSync,
    broadcastScene,
    publishManifest,
    serveOverlayToSlot,
    serveMaterialToSlot,
    serveDocPayloadToSlot,
  };
}
