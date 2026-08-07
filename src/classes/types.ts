// CLASSES — the durable, reusable teaching unit that replaces `ScheduledStream`
// (which welded what-you-teach to when-you-teach-it, so prep was single-use).
//
// A class is a name + a KIT of equipped content, with no date attached.
// `ScheduledSession`s point AT a class — the same class can be taught many times.
// See docs/GO-LIVE-REBUILD-PLAN.md §2.
//
// PLATFORM NEUTRALITY: pure serializable model + plain reducers (no DOM, no
// zustand, no AsyncStorage) — web and React Native reuse it verbatim, exactly
// like `@paxpia/core/scheduling`. The id generator is injectable (see `IdGen`)
// so core stays free of any concrete id scheme.

import type { MaterialMeta } from '../materials';
import type { AuthoredKind, AuthoredPayload } from '../scheduling/types';

/** Mint an opaque id with a short prefix (`class_ab12cd3`, `kit_…`, `sess_…`). The
 *  caller supplies this so a platform (or a test) can inject a deterministic one. */
export type IdGen = (prefix: string) => string;

export type ClassVisibility = 'public' | 'members';

// ── Kit items — what a class is equipped with ────────────────────────────────
// Every variant carries `id` (stable across reorders) and `order` (the reducers'
// source of truth for position; kept contiguous by `moveKitItem`).

interface KitItemBase {
  id: string;
  order: number;
}

/** A picked material (PDF / image / EPUB) from the library or a fresh device pick. */
export interface KitMaterialItem extends KitItemBase {
  kind: 'material';
  material: MaterialMeta;
}

/** A course module's attached document. `material` is absent until resolved (an
 *  unattached reading), in which case the item can't be shown live yet. */
export interface KitModuleItem extends KitItemBase {
  kind: 'module';
  courseId: string;
  moduleId: string;
  blockId: string;
  label: string;
  material?: MaterialMeta;
}

/** A book the creator wrote, rendered live as pages (see `@paxpia/core/books`). */
export interface KitBookItem extends KitItemBase {
  kind: 'book';
  courseId: string;
  moduleId: string;
  blockId: string;
  label: string;
  chapterCount: number;
}

/** A blank whiteboard, equipped ahead of time (a class can carry more than one). */
export interface KitWhiteboardItem extends KitItemBase {
  kind: 'whiteboard';
  label: string;
}

/** An authored poll/quiz/vote — the "Ask" tab. Rescued from the deleted schedule
 *  editor (§11 phase 6): the authored blob shape didn't change, only where it's
 *  written. `overlay` mirrors `TimelineOverlayItem['overlay']` byte-for-byte. */
export interface KitOverlayItem extends KitItemBase {
  kind: 'overlay';
  overlay: {
    kind: AuthoredKind;
    title: string;
    payload: AuthoredPayload;
  };
}

export type KitItem = KitMaterialItem | KitModuleItem | KitBookItem | KitWhiteboardItem | KitOverlayItem;

/** A caller-supplied kit item — everything but `id`/`order`, which the reducer
 *  mints/assigns. */
export type NewKitItem =
  | Omit<KitMaterialItem, 'id' | 'order'>
  | Omit<KitModuleItem, 'id' | 'order'>
  | Omit<KitBookItem, 'id' | 'order'>
  | Omit<KitWhiteboardItem, 'id' | 'order'>
  | Omit<KitOverlayItem, 'id' | 'order'>;

export interface LiveClass {
  id: string;
  name: string;
  description?: string;
  visibility: ClassVisibility;
  /** The prepared set Creator Tools opens on, ordered by `order`. */
  kit: KitItem[];
  createdAt: number;
  updatedAt: number;
}

/** A scheduling point AT a class (D1) — a class is taught many times, so a
 *  session is just "this class, at this time," not its own content. */
export interface ScheduledSession {
  id: string;
  classId: string;
  startUnix: number;
}

/** The serializable classes state — what the store wraps and the account blob
 *  carries (`StudioConfigBlob.classes`/`sessions`/`activeClassId`, v2). */
export interface ClassesState {
  classes: LiveClass[];
  sessions: ScheduledSession[];
  /** The class currently being taught / last opened, or null. */
  activeClassId: string | null;
}

export function initialClassesState(): ClassesState {
  return { classes: [], sessions: [], activeClassId: null };
}
