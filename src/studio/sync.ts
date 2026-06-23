// STUDIO SYNC COORDINATOR — the account-blob GET/PUT coordinator, lifted out of
// `Paxpia-web/src/store/studioSync.ts` (which self-described as RN-verbatim
// reusable) so web AND the future mobile creator studio load/save the SAME tutor
// config. It bridges the studio stores (scenes + scheduling + assignments) to the
// account-backed `StudioConfigBlob` API.
//
// WHY a coordinator (not per-store persistence): scenes, schedules and assignments
// live in separate stores but persist as ONE server blob keyed by user id, and they
// must LOAD together (a schedule references scene ids) and SAVE together (one PUT).
// This module owns the single source of truth for "the studio config blob" and
// wires every store to it.
//
// LIFECYCLE (byte-identical to the web original):
//   • on login (token appears) → GET the blob, hydrate ALL stores, then arm the
//     change-subscriptions so subsequent edits debounce-save.
//   • on any store change      → debounced PUT of the merged blob (1.2s).
//   • on logout (token clears) → flush any pending save, disarm, reset stores.
//
// PLATFORM SEAMS (so the core stays zustand-free / DOM-free / RN-free):
//   • `StoreHandle<S>`        — the slice of a store the coordinator uses
//     (getState/setState/subscribe). Zustand stores satisfy it directly; the mobile
//     store factory will too.
//   • `AuthHandle`           — read the current user id + whether there's a token,
//     and subscribe to auth changes (login / persona-switch / logout).
//   • `StudioConfigClient`   — the injected `fetch`-like + auth header (config.ts).
//   • `StorageAdapter`       — the offline-cache KV (localStorage ↔ MMKV) the store
//     WRAPPERS persist into. The coordinator treats the cache as already-rehydrated
//     (server wins on login); it's surfaced here so a platform binds ONE adapter for
//     the whole studio module.

import {
  getStudioConfig,
  putStudioConfig,
  type StudioConfigClient,
} from './config';
import { initialScenesState } from './scenes';
import {
  defaultIdGen,
  type AssignmentsState,
  type IdGen,
  type RawStudioConfigBlob,
  type ScenesState,
  type StorageAdapter,
  type StudioConfigBlob,
} from './types';

/** Blob schema version. Bump when the serialized shape changes incompatibly and add
 *  a migration in `migrateBlob`. Mirrors the zustand-persist versions the stores
 *  carried (studio was v4; scenes v1). */
export const STUDIO_BLOB_VERSION = 1;

/** Debounce window that coalesces a burst of edits into one PUT. */
export const SAVE_DEBOUNCE_MS = 1200;

// Core's lib is ES2020 only (no DOM), and `setTimeout`/`clearTimeout` aren't in it.
// Both the browser and React Native expose them on `globalThis`, so read them off a
// typed view (the same pattern `overlays/svgClock.ts` uses for rAF/setInterval). An
// opaque handle keeps the platform's real return type (number vs Timeout) neutral.
type TimerHandle = unknown;
const gg = globalThis as unknown as {
  setTimeout: (cb: () => void, ms: number) => TimerHandle;
  clearTimeout: (h: TimerHandle) => void;
};

/** The slice of a store the coordinator drives. A zustand vanilla/react store
 *  satisfies this as-is (`getState`/`setState`/`subscribe`). */
export interface StoreHandle<S> {
  getState(): S;
  setState(partial: Partial<S>): void;
  subscribe(listener: (state: S, prev: S) => void): () => void;
}

/** The scheduling store's slice the coordinator reads/writes (opaque payload — owned
 *  by `@paxpia/core/scheduling`; this module only carries it through the blob). */
export interface StudioSchedulingState {
  scheduled: unknown[];
  activeStreamId: string | null;
}

/** Read the current auth identity + subscribe to its changes. */
export interface AuthHandle {
  /** Current signed-in user id (null when logged out). */
  userId(): string | null;
  /** Whether there's a usable token right now. */
  hasToken(): boolean;
  /** Subscribe to auth changes; the listener gets the new + previous identity so the
   *  coordinator can tell login / persona-switch / logout apart. */
  subscribe(
    listener: (next: { token: boolean; userId: string | null }, prev: { token: boolean; userId: string | null }) => void,
  ): () => void;
}

/** Everything the coordinator binds to. */
export interface StudioSyncDeps {
  scenes: StoreHandle<ScenesState>;
  scheduling: StoreHandle<StudioSchedulingState>;
  assignments: StoreHandle<AssignmentsState<unknown>>;
  auth: AuthHandle;
  client: StudioConfigClient;
  /** The offline-cache KV the store wrappers persist into (localStorage ↔ MMKV).
   *  Surfaced so a platform binds one adapter for the whole studio module. */
  storage?: StorageAdapter;
  /** Scene id generator (defaults to the shared `${prefix}_base36`). */
  idGen?: IdGen;
}

/** The coordinator's public surface — identical in name + behaviour to web's
 *  `studioSync.ts` module functions, now returned from a factory instead of being
 *  module-global, so multiple platforms instantiate their own. */
export interface StudioSync {
  /** Snapshot all stores into the single serializable config blob. */
  snapshotBlob(): StudioConfigBlob;
  /** Load the server config for the signed-in user and hydrate the stores, then arm
   *  change-saving. Falls back to the local cache when the server is unreachable.
   *  Idempotent per user. */
  loadStudioForCurrentUser(freshUser?: boolean): Promise<void>;
  /** Reset on logout: flush any pending save, disarm, clear the studio stores. */
  resetStudioOnLogout(): void;
  /** Wire the coordinator to auth: load on login, reset on logout. Call ONCE at app
   *  startup. Returns an unsubscribe. */
  initStudioSync(): () => void;
  /** Push the current merged blob now (best-effort; logged out → no-op). Exposed for
   *  tests + explicit flush points. */
  flushNow(): Promise<void>;
}

/** Build a studio-sync coordinator bound to the given stores + auth + config client.
 *  All the module-global mutable state of the web original is now closed over per
 *  instance. */
export function createStudioSync(deps: StudioSyncDeps): StudioSync {
  const { scenes, scheduling, assignments, auth, client } = deps;
  const idGen = deps.idGen ?? defaultIdGen;

  let saveTimer: TimerHandle | null = null;
  let unsubScenes: (() => void) | null = null;
  let unsubScheduling: (() => void) | null = null;
  let unsubAssignments: (() => void) | null = null;
  let armed = false;
  // True while applying a server snapshot, so the resulting store writes don't echo
  // back into a save (load → store-set → subscription → save loop).
  let hydrating = false;
  // The last user we synced for, so a re-login as a different persona reloads.
  let syncedUserId: string | null = null;

  /** Snapshot all stores into the single serializable config blob. */
  function snapshotBlob(): StudioConfigBlob {
    const sc = scenes.getState();
    const st = scheduling.getState();
    const as = assignments.getState();
    return {
      version: STUDIO_BLOB_VERSION,
      scenes: sc.scenes,
      activeSceneId: sc.activeId,
      scheduled: st.scheduled,
      activeStreamId: st.activeStreamId,
      // Per-scene overlay→material slot fills + per-type last-interacted, so a scene
      // keeps its assignments across scene switches, reload, and devices (rule 7).
      assignments: as.assignments,
      lastInteracted: as.lastInteracted,
    };
  }

  /** Forward-migrate a raw server/cache blob to the current shape. Today there's only
   *  v1, so this is a passthrough that fills any missing fields defensively. */
  function migrateBlob(raw: RawStudioConfigBlob): RawStudioConfigBlob {
    return raw ?? {};
  }

  /** Reset ALL stores to a clean single-user default (one fresh empty scene, no
   *  schedules). Called when a NEW user signs in / on logout so one tutor's setup
   *  never bleeds into the next user. Guarded by `hydrating` so it doesn't echo-save. */
  function resetStudioStores(): void {
    hydrating = true;
    try {
      scenes.setState(initialScenesState(idGen));
      scheduling.setState({ scheduled: [], activeStreamId: null });
      assignments.setState({ assignments: {}, lastInteracted: {} });
    } finally {
      hydrating = false;
    }
  }

  /** Apply a config blob to ALL stores (server snapshot wins). Guarded by `hydrating`
   *  so the resulting writes don't trigger a save echo. */
  function applyBlob(raw: RawStudioConfigBlob): void {
    const blob = migrateBlob(raw);
    hydrating = true;
    try {
      const rawScenes = Array.isArray(blob.scenes) ? (blob.scenes as ScenesState['scenes']) : null;
      if (rawScenes && rawScenes.length > 0) {
        const activeSceneId =
          typeof blob.activeSceneId === 'string' && rawScenes.some((s) => s.id === blob.activeSceneId)
            ? (blob.activeSceneId as string)
            : rawScenes[0].id;
        scenes.setState({ scenes: rawScenes, activeId: activeSceneId });
      }
      // Schedules + their timelines ride the SAME blob as scenes. Defensively
      // normalize each schedule's items into a stable, contiguously-renumbered,
      // `order`-sorted array so an add/remove/REORDER always rehydrates in the exact
      // authored sequence, regardless of how the blob was serialized cross-device.
      const scheduled = Array.isArray(blob.scheduled)
        ? (blob.scheduled as Array<{ items?: unknown[] } & Record<string, unknown>>).map((st) => ({
            ...st,
            items: Array.isArray(st.items)
              ? [...(st.items as Array<{ order?: number } & Record<string, unknown>>)]
                  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                  .map((it, i) => ({ ...it, order: i }))
              : [],
          }))
        : [];
      const activeStreamId =
        typeof blob.activeStreamId === 'string' &&
        scheduled.some((s) => (s as { id?: string }).id === blob.activeStreamId)
          ? (blob.activeStreamId as string)
          : null;
      scheduling.setState({ scheduled, activeStreamId });

      // Per-scene overlay assignments + last-interacted (rule 7). Default to empty so
      // an older blob (pre-assignments) hydrates cleanly without losing scenes.
      const nextAssignments =
        blob.assignments && typeof blob.assignments === 'object'
          ? (blob.assignments as AssignmentsState<unknown>['assignments'])
          : {};
      const nextLastInteracted =
        blob.lastInteracted && typeof blob.lastInteracted === 'object'
          ? (blob.lastInteracted as AssignmentsState<unknown>['lastInteracted'])
          : {};
      assignments.setState({ assignments: nextAssignments, lastInteracted: nextLastInteracted });
    } finally {
      hydrating = false;
    }
  }

  /** Push the current merged blob to the server (best-effort). Logged out → no-op. */
  async function flushNow(): Promise<void> {
    if (saveTimer) {
      gg.clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      await putStudioConfig(client, snapshotBlob(), STUDIO_BLOB_VERSION);
    } catch {
      /* offline / transient — the local cache still holds the change; a later edit
         (or next login) re-syncs. Don't surface; the studio stays usable offline. */
    }
  }

  /** Debounced save — coalesces a burst of edits into one PUT. */
  function scheduleSave(): void {
    if (hydrating) return;
    if (saveTimer) gg.clearTimeout(saveTimer);
    saveTimer = gg.setTimeout(() => {
      saveTimer = null;
      void flushNow();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Arm the change-subscriptions that debounce-save on edit (idempotent). */
  function arm(): void {
    if (armed) return;
    armed = true;
    unsubScenes = scenes.subscribe(() => scheduleSave());
    unsubScheduling = scheduling.subscribe(() => scheduleSave());
    unsubAssignments = assignments.subscribe(() => scheduleSave());
  }

  /** Disarm. Called on logout. */
  function disarm(): void {
    unsubScenes?.();
    unsubScheduling?.();
    unsubAssignments?.();
    unsubScenes = null;
    unsubScheduling = null;
    unsubAssignments = null;
    armed = false;
  }

  async function loadStudioForCurrentUser(freshUser = false): Promise<void> {
    const userId = auth.userId();
    if (!userId) return;
    if (syncedUserId === userId && armed) return; // already synced this user
    syncedUserId = userId;
    // A genuinely DIFFERENT user just signed in (persona switch) → wipe the prior
    // user's scenes/schedules from memory+cache up front so they never bleed
    // through, even if THIS user has never saved server-side (version 0). On a plain
    // page-reload (freshUser=false) we keep the cache — it's THIS user's offline data.
    if (freshUser) resetStudioStores();
    try {
      const res = await getStudioConfig(client);
      // version 0 = the user has never saved server-side. Keep whatever the local
      // cache rehydrated and let the next change push it up — DON'T clobber a
      // local-only setup with the empty server blob.
      if (res && res.version > 0) {
        applyBlob(res.config);
      }
    } catch {
      /* server unreachable — keep the local cache; arming still enables later sync */
    } finally {
      arm();
    }
  }

  function resetStudioOnLogout(): void {
    void flushNow();
    disarm();
    syncedUserId = null;
    // Clear in-memory studio state so the next user never sees the previous user's
    // setup. The persist cache is per-browser; the next login reloads from the server
    // (or resets to a clean default for a fresh user).
    resetStudioStores();
  }

  function initStudioSync(): () => void {
    // Run once for the current state (handles a page-load with a persisted token).
    if (auth.hasToken()) void loadStudioForCurrentUser();

    const unsub = auth.subscribe((s, prev) => {
      const was = prev.token;
      const now = s.token;
      if (now && (!was || prev.userId !== s.userId)) {
        // Logged in (or switched persona) → (re)load for the new user. This is a
        // FRESH user (not a same-user reload), so reset stores first to avoid bleed.
        syncedUserId = null;
        void loadStudioForCurrentUser(true);
      } else if (!now && was) {
        // Logged out → flush + reset.
        resetStudioOnLogout();
      }
    });
    return unsub;
  }

  return {
    snapshotBlob,
    loadStudioForCurrentUser,
    resetStudioOnLogout,
    initStudioSync,
    flushNow,
  };
}
