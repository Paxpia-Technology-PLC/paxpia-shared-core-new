// SCHEDULING reducers — pure transforms over a `ScheduledStream[]` collection and
// over a single stream's `TimelineItem[]`. Every function returns a NEW value
// (immutable), takes NO platform dependency, and never mutates its input, so any
// store (zustand on web, whatever mobile binds) can delegate to them.
//
// The functions that MINT new ids (`addScheduled`, `addMaterialItem`,
// `addOverlayItem`) take an `idGen: () => string` so each app keeps its own id
// scheme (web uses Math.random; RN can use the same or a uuid lib) — core stays
// free of any id generator.

import type {
  DoneFlag,
  ScheduledStream,
  ScheduledVisibility,
  TimelineItem,
  TimelineOverlay,
} from './types';
import type { MaterialMeta } from '../materials';

/** An id generator the caller supplies (web: Math.random; RN: uuid or same). */
export type IdGen = () => string;

// ── timeline-item helpers ─────────────────────────────────────────────────────

/** Re-number items 0..n-1 by their current array position (call after any
 *  insert / remove / reorder so `order` stays contiguous + matches the array). */
export function renumber(items: TimelineItem[]): TimelineItem[] {
  return items.map((it, i) => ({ ...it, order: i }));
}

/** Apply a pure transform to a single stream's items, then renumber them. */
function withItems(st: ScheduledStream, fn: (items: TimelineItem[]) => TimelineItem[]): ScheduledStream {
  return { ...st, items: renumber(fn(st.items)) };
}

/** Replace the one stream matching `streamId` with `fn(st)`; others pass through. */
function mapStream(
  streams: ScheduledStream[],
  streamId: string,
  fn: (st: ScheduledStream) => ScheduledStream,
): ScheduledStream[] {
  return streams.map((st) => (st.id === streamId ? fn(st) : st));
}

/** Map only the items of the stream matching `streamId`, renumbering after. */
function mapItems(
  streams: ScheduledStream[],
  streamId: string,
  fn: (items: TimelineItem[]) => TimelineItem[],
): ScheduledStream[] {
  return mapStream(streams, streamId, (st) => withItems(st, fn));
}

// ── scheduled-class CRUD + visibility ─────────────────────────────────────────

/** A blank scheduled class (empty timeline + no scenes assigned yet). */
export function makeScheduledStream(
  id: string,
  title: string,
  startUnix: number,
  visibility: ScheduledVisibility = 'public',
): ScheduledStream {
  return { id, title, startUnix, visibility, items: [], sceneIds: [] };
}

/** Append a fresh scheduled class. */
export function addScheduled(
  streams: ScheduledStream[],
  idGen: IdGen,
  title: string,
  startUnix: number,
  visibility: ScheduledVisibility = 'public',
): ScheduledStream[] {
  return [...streams, makeScheduledStream(idGen(), title, startUnix, visibility)];
}

/** Remove a scheduled class by id. */
export function removeScheduled(streams: ScheduledStream[], id: string): ScheduledStream[] {
  return streams.filter((x) => x.id !== id);
}

/** Rename a scheduled class in place (inline-edit of its title). */
export function renameScheduled(streams: ScheduledStream[], id: string, title: string): ScheduledStream[] {
  return mapStream(streams, id, (st) => ({ ...st, title }));
}

/** Reschedule a class to a new start time (unix ms). */
export function setScheduledStart(streams: ScheduledStream[], id: string, startUnix: number): ScheduledStream[] {
  return mapStream(streams, id, (st) => ({ ...st, startUnix }));
}

/** Set a class's public/private visibility. */
export function setScheduledVisibility(
  streams: ScheduledStream[],
  streamId: string,
  visibility: ScheduledVisibility,
): ScheduledStream[] {
  return mapStream(streams, streamId, (st) => ({ ...st, visibility }));
}

// ── scene assignment (which scenes a class may hot-swap between live) ──────────

/** Assign a producer scene id to a class (no duplicates). */
export function assignSceneToStream(
  streams: ScheduledStream[],
  streamId: string,
  sceneId: string,
): ScheduledStream[] {
  return mapStream(streams, streamId, (st) =>
    st.sceneIds.includes(sceneId) ? st : { ...st, sceneIds: [...st.sceneIds, sceneId] },
  );
}

/** Remove a scene assignment from a class. */
export function unassignSceneFromStream(
  streams: ScheduledStream[],
  streamId: string,
  sceneId: string,
): ScheduledStream[] {
  return mapStream(streams, streamId, (st) => ({
    ...st,
    sceneIds: st.sceneIds.filter((id) => id !== sceneId),
  }));
}

// ── timeline editing ──────────────────────────────────────────────────────────

/** Whether a class's timeline already contains a given material (by material id). The UI
 *  reads this to disable an already-added material in the picker (#1). */
export function streamHasMaterial(stream: Pick<ScheduledStream, 'items'>, materialId: string): boolean {
  return stream.items.some((it) => it.kind === 'material' && it.material.id === materialId);
}

/** Append a picked (renderable) material to the class's timeline. DEDUPED (#1): the SAME
 *  material (by id) can appear at most once per class — a duplicate add is a no-op. */
export function addMaterialItem(
  streams: ScheduledStream[],
  idGen: IdGen,
  streamId: string,
  material: MaterialMeta,
): ScheduledStream[] {
  return mapItems(streams, streamId, (items) =>
    items.some((it) => it.kind === 'material' && it.material.id === material.id)
      ? items // already on this class's timeline → no duplicate
      : [...items, { id: idGen(), kind: 'material', order: items.length, done: null, material }],
  );
}

/** Append an authored overlay (a poll/quiz/vote JSON blob) to the timeline. */
export function addOverlayItem(
  streams: ScheduledStream[],
  idGen: IdGen,
  streamId: string,
  overlay: TimelineOverlay,
): ScheduledStream[] {
  return mapItems(streams, streamId, (items) => [
    ...items,
    { id: idGen(), kind: 'overlay', order: items.length, done: null, overlay },
  ]);
}

/** Append a reference to a saved Slide (by id) to the class's timeline. DEDUPED,
 *  like `addMaterialItem`: the SAME slide can appear at most once per class. */
export function addSlideItem(
  streams: ScheduledStream[],
  idGen: IdGen,
  streamId: string,
  slideId: string,
): ScheduledStream[] {
  return mapItems(streams, streamId, (items) =>
    items.some((it) => it.kind === 'slide' && it.slideId === slideId)
      ? items // already on this class's timeline → no duplicate
      : [...items, { id: idGen(), kind: 'slide', order: items.length, done: null, slideId }],
  );
}

/** Remove a timeline item by id. */
export function removeItem(streams: ScheduledStream[], streamId: string, itemId: string): ScheduledStream[] {
  return mapItems(streams, streamId, (items) => items.filter((it) => it.id !== itemId));
}

/** Move an item one slot up (-1) or down (+1) in the timeline. Out-of-range
 *  swaps are no-ops (the items array is returned unchanged). */
export function reorderItem(
  streams: ScheduledStream[],
  streamId: string,
  itemId: string,
  dir: -1 | 1,
): ScheduledStream[] {
  return mapItems(streams, streamId, (items) => {
    const i = items.findIndex((it) => it.id === itemId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= items.length) return items;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
}

/** Move an item to an explicit index (drag-drop / programmatic). The target index
 *  is clamped into range; a no-op move returns the items unchanged. */
export function moveItem(
  streams: ScheduledStream[],
  streamId: string,
  itemId: string,
  toIndex: number,
): ScheduledStream[] {
  return mapItems(streams, streamId, (items) => {
    const i = items.findIndex((it) => it.id === itemId);
    if (i < 0) return items;
    const clamped = Math.max(0, Math.min(toIndex, items.length - 1));
    if (clamped === i) return items;
    const next = [...items];
    const [moved] = next.splice(i, 1);
    next.splice(clamped, 0, moved);
    return next;
  });
}

/** Set the green/red/null progress flag on a timeline item (live run). */
export function setDone(
  streams: ScheduledStream[],
  streamId: string,
  itemId: string,
  done: DoneFlag,
): ScheduledStream[] {
  return mapItems(streams, streamId, (items) =>
    items.map((it) => (it.id === itemId ? { ...it, done } : it)),
  );
}
