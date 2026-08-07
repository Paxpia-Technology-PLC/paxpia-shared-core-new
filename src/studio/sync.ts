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
import { initialClassesState, type ClassesState, type KitItem, type LiveClass, type ScheduledSession } from '../classes/types';
import type { ScheduledStream, TimelineItem } from '../scheduling/types';

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

/** The slides-library store's slice the coordinator reads/writes (opaque payload —
 *  owned by `@paxpia/core/slides`; this module only carries it through the blob). */
export interface StudioSlidesState {
  slides: unknown[];
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
  /** The slides-library store. OPTIONAL: a platform with no Slide UI yet (e.g. web,
   *  as of the mobile-only Slide feature) can omit this — the coordinator falls back
   *  to an internal in-memory handle so a mobile-authored slides library still
   *  round-trips losslessly through that platform's GET/PUT instead of being wiped
   *  by a save with no slides state. */
  slides?: StoreHandle<StudioSlidesState>;
  /** The classes store (durable teaching units — `@paxpia/core/classes`). OPTIONAL
   *  so an older build (pre-classes) keeps working; when bound, this is also what
   *  runs the one-time `scheduled[]` → classes conversion (R5) for an existing
   *  creator — additive and idempotent, so both platforms can arm it without
   *  racing each other. Unbound, the coordinator leaves the blob's `classes` /
   *  `sessions` / `activeClassId` fields untouched on save. */
  classes?: StoreHandle<ClassesState>;
  auth: AuthHandle;
  client: StudioConfigClient;
  /** The offline-cache KV the store wrappers persist into (localStorage ↔ MMKV).
   *  Surfaced so a platform binds one adapter for the whole studio module. */
  storage?: StorageAdapter;
  /** Scene id generator (defaults to the shared `${prefix}_base36`). */
  idGen?: IdGen;
}

/** What the one-time `scheduled[]` → classes conversion (R5) reports — read by
 *  `ClassListScreen`/`ClassesPage` so a creator can see (and fix) a gap, like a
 *  slide reference that couldn't be carried over (Slides retired, D14). */
export interface ClassMigrationResult {
  /** Classes newly created by this run (empty when there was nothing to convert,
   *  or everything had already been migrated). */
  createdClassIds: string[];
  /** Sessions newly created by this run. */
  createdSessionIds: string[];
  /** Human-readable, one per thing that couldn't be carried over. */
  warnings: string[];
}

function emptyMigrationResult(): ClassMigrationResult {
  return { createdClassIds: [], createdSessionIds: [], warnings: [] };
}

/**
 * Convert each `scheduled[]` entry (a `ScheduledStream`) into one `LiveClass` +
 * one `ScheduledSession` — pure, so it can run for real OR as a dry run.
 *
 *   ADDITIVE     — `scheduled[]` is never touched; a wrong conversion always has
 *                  the originals to fall back on.
 *   IDEMPOTENT   — the class/session ids are DERIVED from the source stream id,
 *                  so running this against the same blob twice can't duplicate.
 *   NEVER CLOBBERS — a stream already migrated (its derived id already exists in
 *                  `existingClasses`) is skipped — a creator's own rename/re-equip
 *                  since then is THEIRS, not overwritten by a re-run.
 *
 * What can't be carried (a `slide` timeline item — Slides retired, D14) is
 * dropped from the kit and reported, never silently lost.
 */
function migrateScheduledToClasses(
  scheduled: readonly ScheduledStream[],
  existingClasses: readonly LiveClass[],
  idGen: IdGen,
): { classes: LiveClass[]; sessions: ScheduledSession[]; result: ClassMigrationResult } {
  const existingIds = new Set(existingClasses.map((c) => c.id));
  const classes: LiveClass[] = [];
  const sessions: ScheduledSession[] = [];
  const result = emptyMigrationResult();

  for (const stream of scheduled) {
    const classId = `class_migrated_${stream.id}`;
    if (existingIds.has(classId)) continue; // already migrated — never re-touch it

    const now = Date.now();
    const kit: KitItem[] = [];
    for (const item of (stream.items ?? []) as TimelineItem[]) {
      if (item.kind === 'material') {
        kit.push({ id: idGen('kit'), order: kit.length, kind: 'material', material: item.material });
      } else if (item.kind === 'overlay') {
        kit.push({ id: idGen('kit'), order: kit.length, kind: 'overlay', overlay: item.overlay });
      } else if (item.kind === 'slide') {
        result.warnings.push(`"${stream.title}": a reusable Slide couldn't be carried over (Slides retired)`);
      }
    }

    classes.push({
      id: classId,
      name: stream.title || 'Untitled class',
      visibility: stream.visibility === 'private' ? 'members' : 'public',
      kit,
      createdAt: now,
      updatedAt: now,
    });
    result.createdClassIds.push(classId);

    const sessionId = `sess_migrated_${stream.id}`;
    sessions.push({ id: sessionId, classId, startUnix: stream.startUnix });
    result.createdSessionIds.push(sessionId);
  }

  return { classes, sessions, result };
}

/** A minimal in-memory `StoreHandle` — used as the `slides` fallback when a
 *  platform doesn't bind a real slides store, so `applyBlob`/`snapshotBlob` still
 *  round-trip the field losslessly (no UI, no persistence beyond this instance's
 *  lifetime, which is fine: a real load always precedes any save). */
function memoryStoreHandle<S extends object>(initial: S): StoreHandle<S> {
  let state = initial;
  const listeners = new Set<(state: S, prev: S) => void>();
  return {
    getState: () => state,
    setState: (partial) => {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((l) => l(state, prev));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
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
  /** What the last real `scheduled[]` → classes conversion carried over (R5), or
   *  null when none has run yet this session. A live-updating property (not a
   *  snapshot) — read it any time after a load. */
  readonly lastMigration: ClassMigrationResult | null;
  /** DRY RUN the conversion — reports exactly what WOULD be produced, touching no
   *  store and sending nothing (R5's "inspect a real account first" valve). Pass a
   *  raw blob to inspect it directly; omit it to dry-run against whatever the
   *  scheduling store currently holds (already-loaded local state — no round trip
   *  either way). */
  dryRunMigration(blob?: RawStudioConfigBlob): ClassMigrationResult;
}

/** Build a studio-sync coordinator bound to the given stores + auth + config client.
 *  All the module-global mutable state of the web original is now closed over per
 *  instance. */
export function createStudioSync(deps: StudioSyncDeps): StudioSync {
  const { scenes, scheduling, assignments, auth, client } = deps;
  const slides = deps.slides ?? memoryStoreHandle<StudioSlidesState>({ slides: [] });
  const classes = deps.classes ?? memoryStoreHandle<ClassesState>(initialClassesState());
  const idGen = deps.idGen ?? defaultIdGen;

  let saveTimer: TimerHandle | null = null;
  let unsubScenes: (() => void) | null = null;
  let unsubScheduling: (() => void) | null = null;
  let unsubAssignments: (() => void) | null = null;
  let unsubSlides: (() => void) | null = null;
  let unsubClasses: (() => void) | null = null;
  let armed = false;
  let lastMigrationResult: ClassMigrationResult | null = null;
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
    const sl = slides.getState();
    const cl = classes.getState();
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
      // The slides library — rides the SAME account blob (opaque to this module).
      slides: sl.slides,
      // Durable classes (v2) — see `@paxpia/core/classes`.
      classes: cl.classes,
      sessions: cl.sessions,
      activeClassId: cl.activeClassId,
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
      slides.setState({ slides: [] });
      classes.setState(initialClassesState());
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

      // The slides library. Default to empty so an older blob (pre-slides) hydrates
      // cleanly without losing scenes/schedules.
      const rawSlides = Array.isArray(blob.slides) ? (blob.slides as unknown[]) : [];
      slides.setState({ slides: rawSlides });

      // Durable classes (v2). Default to empty so a v1 blob (pre-classes) hydrates
      // cleanly, then run the one-time scheduled[] → classes conversion (R5) against
      // what was JUST hydrated above — additive + idempotent, so it's safe to run on
      // every load (a stream already migrated is skipped, see migrateScheduledToClasses).
      const rawClasses = Array.isArray(blob.classes) ? (blob.classes as LiveClass[]) : [];
      const rawSessions = Array.isArray(blob.sessions) ? (blob.sessions as ScheduledSession[]) : [];
      const rawActiveClassId = typeof blob.activeClassId === 'string' ? (blob.activeClassId as string) : null;
      const migrated = migrateScheduledToClasses(scheduled as unknown as ScheduledStream[], rawClasses, idGen);
      classes.setState({
        classes: [...rawClasses, ...migrated.classes],
        sessions: [...rawSessions, ...migrated.sessions],
        activeClassId: rawActiveClassId,
      });
      if (migrated.result.createdClassIds.length > 0 || migrated.result.warnings.length > 0) {
        lastMigrationResult = migrated.result;
      }
    } finally {
      hydrating = false;
    }
    // Persist itself (save-suppressed above via `hydrating`, so this can't recurse):
    // a load that actually converted something schedules its own save, or the
    // converted classes would sit in memory-only until the creator happened to
    // edit something.
    if (lastMigrationResult && lastMigrationResult.createdClassIds.length > 0) scheduleSave();
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
    unsubSlides = slides.subscribe(() => scheduleSave());
    unsubClasses = classes.subscribe(() => scheduleSave());
  }

  /** Disarm. Called on logout. */
  function disarm(): void {
    unsubScenes?.();
    unsubScheduling?.();
    unsubAssignments?.();
    unsubSlides?.();
    unsubClasses?.();
    unsubScenes = null;
    unsubScheduling = null;
    unsubAssignments = null;
    unsubSlides = null;
    unsubClasses = null;
    armed = false;
  }

  async function loadStudioForCurrentUser(freshUser = false): Promise<void> {
    const userId = auth.userId();
    if (!userId) return;
    if (syncedUserId === userId && armed) return; // already synced this user
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
      // Only mark this user "synced" on a successful round-trip. Setting this
      // unconditionally (before the request) used to permanently skip every future
      // load after a single transient failure (cold-start network hiccup, etc.) —
      // the studio screen would silently stay on stale/empty local cache for the
      // rest of the session since the guard above treats an attempt as done.
      syncedUserId = userId;
    } catch {
      /* server unreachable — keep the local cache; leave `syncedUserId` unset so the
         next studio-entry mount (or auth event) retries instead of getting stuck. */
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

  /** DRY RUN the scheduled[] → classes conversion — no store write, no PUT. Pass a
   *  raw blob to inspect it directly (R5's "against a real account" valve); omit it
   *  to dry-run against whatever is currently loaded locally. */
  function dryRunMigration(blob?: RawStudioConfigBlob): ClassMigrationResult {
    const scheduled = blob
      ? Array.isArray(blob.scheduled)
        ? (blob.scheduled as ScheduledStream[])
        : []
      : scheduling.getState().scheduled as ScheduledStream[];
    const existingClasses = blob
      ? Array.isArray(blob.classes)
        ? (blob.classes as LiveClass[])
        : []
      : classes.getState().classes;
    return migrateScheduledToClasses(scheduled, existingClasses, idGen).result;
  }

  return {
    snapshotBlob,
    loadStudioForCurrentUser,
    resetStudioOnLogout,
    initStudioSync,
    flushNow,
    get lastMigration() {
      return lastMigrationResult;
    },
    dryRunMigration,
  };
}
