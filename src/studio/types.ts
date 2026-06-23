// @paxpia/core/studio — the educator/streamer STUDIO state model + account-config
// sync, lifted out of Paxpia-web so the SAME tutor config the web studio authors
// can later be loaded (and authored) by the mobile creator studio. This file holds
// the platform-neutral seams + the serializable state shapes the two studio stores
// (scenes + assignments) and the sync coordinator pass over the wire.
//
// SCOPE OF THIS LIFT (audit step 1.2): the PURE scene/assignment reducers already
// live in `@paxpia/core` (`layout/*` + `overlays/target.ts`). What was web-only was
//   (a) the STORE ORCHESTRATION around those reducers (the scene-list array moves,
//       the active-scene mapping, the auto/manual assignment flows), and
//   (b) the CONFIG-BLOB SYNC COORDINATOR (`studioSync.ts`): GET/PUT of the account
//       `StudioConfigBlob`, debounced save, login/logout lifecycle.
// Both are lifted here behind two injected seams so the core stays platform-neutral
// (no zustand, no DOM, no RN): a `StorageAdapter` (localStorage ↔ MMKV) and a
// `StudioConfigClient` (a `fetch`-like + auth header, mirroring `MaterialsClient`).
// The platform keeps a THIN store wrapper (web: zustand) that delegates every
// state transition to the pure reducers here.

import type { Scene } from '../layout/types';
import type { LastInteracted, SceneAssignments } from '../overlays/target';

// ── Random-id seam ───────────────────────────────────────────────────────────
// Scenes/items/streams need stable opaque ids. The id generator is injectable so a
// platform (or a test) can supply a deterministic one; the default mirrors the
// web/mobile stores' `${prefix}_${base36}` shape exactly (byte-for-byte behaviour).

/** Mint an opaque id with a short prefix. */
export type IdGen = (prefix: string) => string;

/** The default id generator — `${prefix}_${7-char base36}`, identical to the shape
 *  the web stores used inline (`scene_ab12cd3`, `item_…`, `str_…`). */
export const defaultIdGen: IdGen = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

// ── Scenes state ─────────────────────────────────────────────────────────────

/** The serializable producer-scenes state: the ordered scene list + the active
 *  selection. Live media (MediaStreams) is NOT here — it's keyed by item id in the
 *  platform media layer and re-acquired per session; only this normalized layout
 *  persists. */
export interface ScenesState {
  scenes: Scene[];
  activeId: string;
}

// ── Assignments state ────────────────────────────────────────────────────────
// Generic over the slot BODY `P` (web binds it to its `SlotBody` = material | over-
// lay blob). The pure resolution/assignment reducers in `overlays/target.ts` are
// already generic; this state shape + the flows below stay generic too so mobile
// can bind the same (or a compatible) body type.

/** The per-scene overlay-assignment state: the persisted slot fills keyed
 *  (sceneId → itemId → assignment), plus the per-scene/per-type last-interacted
 *  slot id that drives multi-slot click resolution. */
export interface AssignmentsState<P> {
  assignments: SceneAssignments<P>;
  lastInteracted: Record<string, LastInteracted>;
}

/** The CURRENT active scene's items, reduced to the `{id,type,z}` shape the slot
 *  resolver needs. The platform reads this LIVE off its scenes store so resolution
 *  always runs against the scene on screen. */
export interface ActiveSceneItems {
  sceneId: string;
  items: { id: string; type: Scene['items'][number]['type']; z: number }[];
}

// ── Storage seam (offline cache) ─────────────────────────────────────────────

/** The synchronous key/value store the studio uses as an OFFLINE CACHE (web:
 *  `localStorage`; mobile: MMKV — both expose synchronous get/set/remove of
 *  strings). The account blob is authoritative; this is first-paint + offline only.
 *  Kept minimal (3 methods) so any platform KV satisfies it directly. */
export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

// ── Config blob (the single account-backed studio document) ──────────────────

/** The persisted studio blob — the ONE document the scenes + scheduling +
 *  assignments stores serialize into and the sync coordinator GET/PUTs. Mirrors the
 *  web `snapshotBlob` shape exactly. `scheduled`/`activeStreamId` ride along here
 *  but are owned by the scheduling store (see `@paxpia/core/scheduling`); this
 *  module only carries them through opaquely (it never interprets them) so the one
 *  blob loads + saves atomically. */
export interface StudioConfigBlob {
  version: number;
  scenes: Scene[];
  activeSceneId: string;
  /** Scheduling-store payload (opaque to this module). */
  scheduled: unknown[];
  activeStreamId: string | null;
  /** Per-scene overlay→body slot fills + per-type last-interacted. */
  assignments: SceneAssignments<unknown>;
  lastInteracted: Record<string, LastInteracted>;
}

/** A raw blob as it comes off the server/cache — every field optional/unknown so the
 *  coordinator can defensively normalize an older or partial blob. */
export type RawStudioConfigBlob = Partial<Record<keyof StudioConfigBlob, unknown>> &
  Record<string, unknown>;
