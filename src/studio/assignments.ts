// PURE per-scene overlay-ASSIGNMENT model — the store-agnostic flows behind web's
// `store/assignments.ts` zustand wrapper. The pure resolution reducers already live
// in `overlays/target.ts` (`resolveOverlayTarget`/`assignToSlot`/`markInteracted`/
// `sceneSlots`/`clearSlotAssignment`/`slotAssignment`); what was web-only was the
// AUTO/MANUAL assignment FLOWS that thread those reducers together against the live
// active scene. Those flows are lifted here, generic over the slot BODY `P`.
//
// PLATFORM SEAMS:
//   • `ActiveSceneItems` — the CURRENT scene's `{id,type,z}` items, read LIVE off
//     the platform's scenes store and passed in, so resolution always runs against
//     the scene on screen (web read it via `useScenes.getState()`).
//   • `BodyAdapter<P>` — how to read a body's overlay-kind / stable ref / target
//     item-type. The body shape is platform-defined (web's `SlotBody` references its
//     `MaterialMeta`/authored-overlay types), so the core can't introspect it; the
//     platform injects these three tiny pure readers.
//
// Each flow returns either an updater `(state) => Partial<AssignmentsState<P>>` for
// the platform's `set`, plus the resolved target id (or null/false) the web actions
// returned — so the web wrapper is a thin delegation with byte-identical behaviour.

import {
  assignToSlot,
  clearSlotAssignment,
  markInteracted,
  resolveOverlayTarget,
  sceneSlots,
  slotAssignment,
  type SlotAssignment,
} from '../overlays/target';
import type { OverlayKind } from '../overlays/types';
import type { ActiveSceneItems, AssignmentsState } from './types';

/** The empty initial assignments state. */
export function initialAssignmentsState<P>(): AssignmentsState<P> {
  return { assignments: {}, lastInteracted: {} };
}

/** How the core reads a platform-defined slot body. Three pure readers:
 *    • `kind`     — the overlay kind the body represents (routes doc vs overlay slot),
 *    • `ref`      — a stable ref for the body (material id / synthetic overlay id),
 *    • `itemType` — the LAYOUT item type the body targets ('doc' | 'overlay').
 *  (Web's `bodyKind`/`bodyRef` + the inline `material?'doc':'overlay'` split.) */
export interface BodyAdapter<P> {
  kind(body: P): OverlayKind;
  ref(body: P): string;
  itemType(body: P): 'doc' | 'overlay';
}

/** Read the assignment filling (sceneId, itemId), or undefined. (Web `get`.) */
export function getAssignment<P>(
  st: AssignmentsState<P>,
  sceneId: string,
  itemId: string,
): SlotAssignment<P> | undefined {
  return slotAssignment(st.assignments, sceneId, itemId);
}

/** AUTO path: resolve `body`'s kind against the CURRENT scene and, if a matching
 *  EMPTY slot is found, produce the state updater that assigns it + marks it
 *  interacted. Returns `{ targetId, update }` on success, or `{ targetId: null }`
 *  when no matching empty slot exists (rule 2 NO-OP — never creates a slot, never
 *  touches another scene). The caller applies `update` via its store `set`. */
export function activate<P>(
  st: AssignmentsState<P>,
  active: ActiveSceneItems,
  body: P,
  adapter: BodyAdapter<P>,
): { targetId: string | null; update?: (s: AssignmentsState<P>) => Partial<AssignmentsState<P>> } {
  const { sceneId, items } = active;
  const slots = sceneSlots(sceneId, items, st.assignments);
  const res = resolveOverlayTarget(slots, adapter.kind(body), st.lastInteracted[sceneId]);
  if (!res.targetId) return { targetId: null }; // rule 2: no matching empty slot → NO-OP
  const targetId = res.targetId;
  const targetType = adapter.itemType(body);
  const update = (s: AssignmentsState<P>): Partial<AssignmentsState<P>> => ({
    assignments: assignToSlot(s.assignments, sceneId, targetId, {
      kind: adapter.kind(body),
      ref: adapter.ref(body),
      payload: body,
    }),
    lastInteracted: {
      ...s.lastInteracted,
      [sceneId]: markInteracted(s.lastInteracted[sceneId], targetType, targetId),
    },
  });
  return { targetId, update };
}

/** MANUAL path (drag-drop, rule 5): assign a dragged body to an EXPLICIT slot in the
 *  current scene, bypassing the resolver. Validates the target exists in the CURRENT
 *  scene (scene-scoped, rule 6) and its type matches the body. Returns
 *  `{ ok: true, update }` on success or `{ ok: false }` (mirrors web's boolean). */
export function assignToTarget<P>(
  active: ActiveSceneItems,
  itemId: string,
  body: P,
  adapter: BodyAdapter<P>,
): { ok: boolean; update?: (s: AssignmentsState<P>) => Partial<AssignmentsState<P>> } {
  const { sceneId, items } = active;
  const target = items.find((it) => it.id === itemId);
  if (!target) return { ok: false };
  const wantType = adapter.itemType(body);
  if (target.type !== wantType) return { ok: false };
  const update = (s: AssignmentsState<P>): Partial<AssignmentsState<P>> => ({
    assignments: assignToSlot(s.assignments, sceneId, itemId, {
      kind: adapter.kind(body),
      ref: adapter.ref(body),
      payload: body,
    }),
    lastInteracted: {
      ...s.lastInteracted,
      [sceneId]: markInteracted(s.lastInteracted[sceneId], wantType, itemId),
    },
  });
  return { ok: true, update };
}

/** Clear the assignment at (current scene, itemId). Returns the updater. */
export function clearAssignment<P>(active: ActiveSceneItems, itemId: string) {
  const { sceneId } = active;
  return (s: AssignmentsState<P>): Partial<AssignmentsState<P>> => ({
    assignments: clearSlotAssignment(s.assignments, sceneId, itemId),
  });
}
