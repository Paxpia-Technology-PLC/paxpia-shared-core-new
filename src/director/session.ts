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
  type DocPresenterState,
  type ManifestEntry,
} from '../streaming/live';
import type { DocPayload, OverlayInstance } from '../overlays/types';
import { buildManifest } from '../streaming/viewer';
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
  snapshotScene,
  type ServedDocs,
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
    sceneNonce: 0,
  };
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
  // Per-overlay LAST gen the streamer used (overlay id → gen), so re-serving the SAME
  // overlay reuses its gen and votes PERSIST across a swap-out-and-back (P1.4).
  const overlayGens = new Map<string, number>();
  // Unsubscribe for the scenes-store subscription that re-broadcasts on scene swap.
  let scenesUnsub: (() => void) | null = null;
  let disableAggregator: (() => void) | null = null;
  // In-memory preload cache for the running class's materials (id → rendered doc).
  let preloadCache: DirectorPreloadCache = deps.newPreloadCache();
  // Throttle handle for presenter (pan/zoom) broadcasts.
  let presenterTimer: TimerHandle | null = null;

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
    channel.publishLiveSync({
      t: 'live.sync',
      v: 1,
      sceneId: id,
      scene,
      doc: state.activeDoc,
      docPresenter: state.docPresenter,
      manifest: state.manifest,
    });
  }

  function broadcastScene(): void {
    if (!channel || state.status !== 'live') return;
    const { scene } = snapshotActiveScene();
    const nonce = state.sceneNonce + 1;
    set({ sceneNonce: nonce });
    // The COMPLETE overlay set for THIS scene (P0.3 full-replace). Doc slots from the
    // per-scene served-doc map; the participation slot from the live activeOverlay at
    // the new scene's overlay rect. The FIRST overlay-type item in draw order hosts it.
    const activeOverlay = state.activeOverlay;
    const overlaySlotId = overlaySlotHostId(scene, activeOverlay);
    const sceneDocs = state.servedDocs[scene.id] ?? {};
    const rendered = buildRenderedScene(scene, nonce, (itemId, type) => {
      if (type === 'doc') return sceneDocs[itemId] ?? null;
      return overlaySlotId && itemId === overlaySlotId ? activeOverlay : null;
    });
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
      }

      // Mic: best-effort with video, REQUIRED in audio-only (the media seam throws).
      await media.publishMic(room, audioOnly);

      channel = media.buildTransport(room);
      // No server overlays bot → the STREAMER's room is the authoritative aggregator.
      disableAggregator = channel.enableAggregator(() => state.activeOverlay);
      // The bot owns the participation overlay slot; route its echo there (P0.2).
      channel.onOverlayChanged((e) => {
        const decision = reconcileOverlayChanged(e.overlay, state.activeOverlay, localOverlayId);
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
        // Tell the compositor to hot-swap (output track unchanged; only content does);
        // re-seed its scene + bindings so a newly-composed scene paints correctly.
        seedCompositorScene(nextId);
        compositor?.setActiveScene(nextId);
        // Acquire the new scene's media (best-effort), then re-broadcast layout + overlays.
        void media
          .provisionScene(nextId, (msg) => set({ provisioning: msg }))
          .catch((err) =>
            set({
              provisioning: null,
              error: err instanceof Error ? `Scene input not started — ${err.message}` : null,
            }),
          )
          .finally(() => {
            // The provision may have acquired new sources — rebind them to the compositor.
            seedCompositorScene(nextId);
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

      set({ status: 'live', roomName, room, servedDocs: {}, sceneNonce: 0 });
      broadcastLiveSync();
      broadcastScene();
    } catch (e) {
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
    overlayGens.clear();
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
      sceneNonce: 0,
      audioOnly: false,
      provisioning: null,
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
    // Streamer took the overlay down → drop the local selection so a later clear echo
    // is honored and a new activation starts clean.
    localOverlayId = null;
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
    const clamped = Math.max(0, Math.min(page, payload.pages.length - 1));
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

  async function serveMaterialToSlot(material: DirectorMaterial, itemId?: string): Promise<string | null> {
    if (!channel || state.status !== 'live') return null;
    const { sceneId, slots } = sceneSlotsNow(state.servedDocs);
    const targetId = resolveDocServeTarget(slots, itemId);
    if (!targetId) return null; // no empty doc slot in this scene → NO-OP
    const { roomName } = state;
    let payload = getCachedDoc(preloadCache as never, material.id);
    if (!payload && roomName) {
      payload = await materialsRuntime.buildDocPayload(material, roomName);
      preloadCache.set(material.id, { id: material.id, doc: payload, bytes: material.sizeBytes });
    }
    if (!payload) throw new Error('Room not ready yet.');
    const built = payload;
    const inst = buildInstance({ id: `srv_${targetId}`, kind: 'doc', title: built.title, payload: built }, (gen += 1));
    set((s) => ({
      servedDocs: { ...s.servedDocs, [sceneId]: { ...(s.servedDocs[sceneId] ?? {}), [targetId]: inst } },
      activeDoc: inst,
      docPresenter: { page: built.page, zoom: 1, panX: 0, panY: 0 },
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
    broadcastLiveSync,
    broadcastScene,
    publishManifest,
    serveOverlayToSlot,
    serveMaterialToSlot,
  };
}
