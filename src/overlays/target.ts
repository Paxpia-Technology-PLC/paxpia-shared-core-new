// Overlay-target RESOLUTION + per-scene ASSIGNMENT model — the pure brain that
// decides WHICH overlay slot in the CURRENT scene a clicked material populates.
//
// ── The problem this fixes ───────────────────────────────────────────────────
// A scene holds MULTIPLE overlay items (e.g. two PDF/doc slots + a poll slot).
// When the streamer clicks a material (a doc, or a poll/quiz/vote) to send it
// live, the OLD behaviour was ambiguous: it could auto-create a new overlay, or
// it could spill into a DIFFERENT (background) scene's slot. This module makes
// the targeting deterministic and SCENE-SCOPED:
//
//   1. Find an EMPTY overlay of the MATCHING type in the CURRENT scene.
//   2. NO matching overlay → NO-OP (never create one, never touch another scene).
//   3. Exactly one matching empty slot → use it.
//   4. Multiple matching empty slots → use the MOST-RECENTLY-INTERACTED-WITH one
//      (per type), falling back to draw order when none is remembered.
//   5. Manual drag-drop assignment bypasses this (caller passes the explicit id).
//   6. SCENE-SCOPED: the caller passes only the CURRENT scene's slots, so a
//      resolution can NEVER return a slot from another scene.
//
// The ASSIGNMENT model below is the persisted truth of "which material sits in
// which scene's overlay slot", keyed by (sceneId → itemId → assignment), so a
// scene keeps its slot fills when the streamer switches scenes away and back.
//
// RN PORTABILITY: types + pure functions only (no DOM, no store) — web + mobile
// import the identical logic; only the click/drag wiring differs per platform.

import type { OverlayKind } from './types';
import type { LayoutItemType } from '../layout/types';

/** Which scene-item TYPE a clicked overlay kind targets. A `doc` material lands
 *  on a `doc` layout item; every participation kind (poll/quiz/vote-button/svg/
 *  gift) lands on an `overlay` layout item. Mirrors the live two-slot split. */
export function itemTypeForKind(kind: OverlayKind): Extract<LayoutItemType, 'doc' | 'overlay'> {
  return kind === 'doc' ? 'doc' : 'overlay';
}

/** A candidate overlay/doc slot in the CURRENT scene, as the resolver sees it.
 *  `filled` = a material/overlay is already assigned to this slot (so it's not an
 *  EMPTY target). `z` is the layout draw order, used as the deterministic
 *  tie-break when no slot was recently interacted with. */
export interface OverlaySlot {
  id: string;
  type: Extract<LayoutItemType, 'doc' | 'overlay'>;
  filled: boolean;
  z: number;
}

/** Per-type "last interacted overlay" — the slot id last populated/clicked/
 *  dragged-to for each item type. Drives rule 4 (multiple matching slots → the
 *  one you were just working in). Scoped per scene by the caller. */
export interface LastInteracted {
  doc?: string;
  overlay?: string;
}

/** The outcome of resolving a click. `targetId` is the slot to populate, or null
 *  with a `reason` when nothing matches (the caller MUST no-op on null — never
 *  create a slot, never touch another scene). */
export interface ResolveResult {
  targetId: string | null;
  reason?: 'no-matching-slot';
}

/** Resolve which slot in the CURRENT scene a clicked material populates.
 *
 *  RULES (see file header):
 *   • Considers only EMPTY slots of the matching type in `slots` — the caller
 *     passes ONLY the current scene's slots, so the result is scene-scoped (6).
 *   • 0 empty matching slots → { targetId: null } — NO-OP (2). Note: if every
 *     matching slot is FILLED we still no-op rather than overwrite, so a click
 *     never silently clobbers a slot the streamer set up (manual drag overrides).
 *   • 1 → that slot (3).
 *   • >1 → the per-type last-interacted slot if it's still an empty candidate,
 *     else the lowest-z (first in draw order) candidate — deterministic (4).
 *
 *  Pure — no mutation, no side effects. */
export function resolveOverlayTarget(
  slots: readonly OverlaySlot[],
  kind: OverlayKind,
  lastInteracted: LastInteracted | undefined,
): ResolveResult {
  const wantType = itemTypeForKind(kind);
  const candidates = slots.filter((s) => s.type === wantType && !s.filled);
  if (candidates.length === 0) return { targetId: null, reason: 'no-matching-slot' };
  if (candidates.length === 1) return { targetId: candidates[0].id };

  // Multiple empty matching slots → prefer the most-recently-interacted one if it
  // is STILL an empty candidate; otherwise the deterministic draw-order first.
  const lastId = lastInteracted?.[wantType];
  if (lastId && candidates.some((c) => c.id === lastId)) return { targetId: lastId };
  const byZ = [...candidates].sort((a, b) => a.z - b.z);
  return { targetId: byZ[0].id };
}

/** Record that `itemId` (of `type`) was just interacted with (populated/clicked/
 *  dragged-to), so a later multi-slot resolution prefers it. Pure — returns a new
 *  map. The caller scopes this per scene (one LastInteracted per scene id). */
export function markInteracted(
  prev: LastInteracted | undefined,
  type: Extract<LayoutItemType, 'doc' | 'overlay'>,
  itemId: string,
): LastInteracted {
  return { ...(prev ?? {}), [type]: itemId };
}

// ── Per-scene assignment model (the persisted slot fills) ─────────────────────
// A SceneAssignments maps a scene id → (overlay/doc item id → the assignment that
// fills it). The assignment payload is intentionally opaque to core (it's a web/
// mobile material ref or authored-overlay blob); core only needs to know a slot
// is FILLED to resolve targets and to keep fills across scene switches.

/** One slot's assignment. `kind` lets the renderer pick a path; `ref` is the
 *  material id (doc) or authored-overlay id; `payload` is the opaque body the
 *  platform stores (e.g. a DocPayload or an authored poll blob). */
export interface SlotAssignment<P = unknown> {
  kind: OverlayKind;
  ref: string;
  payload?: P;
}

/** scene id → (item id → assignment). The persisted source of truth for "which
 *  material sits in which scene's overlay slot". Serializable → it rides the
 *  studio config blob, so a scene keeps its fills across reload + scene switches. */
export type SceneAssignments<P = unknown> = Record<string, Record<string, SlotAssignment<P>>>;

/** Assign `assignment` to (sceneId, itemId), replacing any prior fill. Pure. */
export function assignToSlot<P>(
  all: SceneAssignments<P>,
  sceneId: string,
  itemId: string,
  assignment: SlotAssignment<P>,
): SceneAssignments<P> {
  return { ...all, [sceneId]: { ...(all[sceneId] ?? {}), [itemId]: assignment } };
}

/** Clear the assignment at (sceneId, itemId). Pure — drops the scene key when it
 *  becomes empty so the blob stays tidy. */
export function clearSlotAssignment<P>(
  all: SceneAssignments<P>,
  sceneId: string,
  itemId: string,
): SceneAssignments<P> {
  const scene = all[sceneId];
  if (!scene || !(itemId in scene)) return all;
  const nextScene = { ...scene };
  delete nextScene[itemId];
  const next = { ...all };
  if (Object.keys(nextScene).length === 0) delete next[sceneId];
  else next[sceneId] = nextScene;
  return next;
}

/** The assignment filling (sceneId, itemId), or undefined. */
export function slotAssignment<P>(
  all: SceneAssignments<P>,
  sceneId: string,
  itemId: string,
): SlotAssignment<P> | undefined {
  return all[sceneId]?.[itemId];
}

/** Build the resolver's slot list for ONE scene from its layout items + the
 *  current assignments. Only overlay/doc items become slots; `filled` reflects a
 *  live assignment. This is the bridge from the layout model to the resolver, so
 *  callers don't recompute fill state by hand. Pure. */
export function sceneSlots<P>(
  sceneId: string,
  items: readonly { id: string; type: LayoutItemType; z: number }[],
  all: SceneAssignments<P>,
): OverlaySlot[] {
  const scene = all[sceneId] ?? {};
  const out: OverlaySlot[] = [];
  for (const it of items) {
    if (it.type !== 'doc' && it.type !== 'overlay') continue;
    out.push({ id: it.id, type: it.type, filled: it.id in scene, z: it.z });
  }
  return out;
}
