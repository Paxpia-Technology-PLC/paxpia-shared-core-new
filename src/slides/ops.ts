// SLIDES reducers — pure transforms over a `SlideAsset[]` collection. Mirrors
// `scheduling/ops.ts`'s shape (collection-level, idGen injected) so any store
// (web zustand, mobile zustand) can delegate identically.
//
// The Slide Editor owns its in-progress draft (title/subtitle/materials) LOCALLY
// while authoring — exactly like the poll/quiz editor owns `ParticipationDraft` —
// and commits ONCE on Save via `upsertSlide`. There's no per-keystroke store
// round-trip; reordering/removing a material while editing is local state until
// Save, which keeps the store's history free of transient in-progress edits.

import type { MaterialMeta } from '../materials';
import type { SlideAsset, SlidesState } from './types';

// Not exported: `IdGen` already names a differently-shaped type in `studio/types`
// (prefix-based). Callers just pass a `() => string` inline (mirrors scheduling).
type IdGen = () => string;

export function initialSlidesState(): SlidesState {
  return { slides: [] };
}

/** The authored fields a Save commits — everything about a slide except its
 *  identity + timestamps, which `upsertSlide` fills in. */
export interface SlideDraft {
  title: string;
  subtitle?: string;
  materials: MaterialMeta[];
  thumbnail?: string;
}

/** Create a new slide (no `existingId`) or overwrite one in place (editing an
 *  existing slide re-opened from the picker/timeline). Returns the id (new or
 *  unchanged) alongside the next array, so the caller can immediately reference
 *  it (e.g. to append a `TimelineSlideItem`). */
export function upsertSlide(
  slides: SlideAsset[],
  idGen: IdGen,
  draft: SlideDraft,
  now: number,
  existingId?: string,
): { id: string; slides: SlideAsset[] } {
  if (existingId && slides.some((s) => s.id === existingId)) {
    const id = existingId;
    return {
      id,
      slides: slides.map((s) => (s.id === id ? { ...s, ...draft, updatedAtUnix: now } : s)),
    };
  }
  const id = existingId ?? idGen();
  const created: SlideAsset = { id, ...draft, createdAtUnix: now, updatedAtUnix: now };
  return { id, slides: [...slides, created] };
}

/** Remove a slide from the library by id (does not touch scenes/timelines that
 *  still reference it — those keep a dangling id, exactly like removing a
 *  Material doesn't retroactively edit timelines that already picked it). */
export function removeSlide(slides: SlideAsset[], id: string): SlideAsset[] {
  return slides.filter((s) => s.id !== id);
}

/** Bump `lastUsedUnix` — called when a slide is attached to a scene (Scene
 *  Editor picker) or served live (the operator slot), so the Slide Picker's
 *  "recent" sort reflects actual use, not just authoring time. */
export function touchSlideUsage(slides: SlideAsset[], id: string, now: number): SlideAsset[] {
  return slides.map((s) => (s.id === id ? { ...s, lastUsedUnix: now } : s));
}
