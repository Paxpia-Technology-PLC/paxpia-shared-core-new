// SLIDES — a reusable presentation asset: an ordered stack of materials
// (PDFs/images) a creator authors ONCE and can attach to any scene by reference,
// exactly like a Material is uploaded once and referenced from many timelines. A
// Slide is NOT a timeline material and NOT a scene item body — it's its own small
// library, sitting one level above `MaterialMeta` (which it composes, in order).
//
// PLATFORM NEUTRALITY: plain data only (no DOM/RN), mirroring `materials/types.ts`.
// The live-rendering path reuses the EXISTING `doc` overlay pipeline wholesale —
// a Slide's "pages" ARE its ordered materials; stepping through them is just
// repeatedly serving the next material into the same doc-family slot (see the
// director's `serveMaterialToSlot`). No new render/sync model is introduced here.

import type { MaterialMeta } from '../materials';

/** A reusable, ordered stack of materials a creator authors once. `materials[0]`
 *  is the first thing shown when the slide is presented; order is the array
 *  order (no separate `order` field — reordering just re-splices the array). */
export interface SlideAsset {
  id: string;
  title: string;
  subtitle?: string;
  /** Ordered materials that make up the presentation (mixed PDFs/images allowed). */
  materials: MaterialMeta[];
  /** Optional thumbnail url (e.g. the first material's rendered first page). */
  thumbnail?: string;
  createdAtUnix: number;
  updatedAtUnix: number;
  /** Bumped whenever the slide is attached to a scene or served live — drives a
   *  "recently used" sort in the Slide Picker. Absent = never used yet. */
  lastUsedUnix?: number;
}

export interface SlidesState {
  slides: SlideAsset[];
}
