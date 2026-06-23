// SCHEDULING — the SCHEDULE-as-TIMELINE domain model, shared once by web + mobile.
//
// A scheduled class is an ORDERED TIMELINE the tutor arranges ahead of time:
// materials (slides/PDFs to show live) and ephemeral overlays (polls / quizzes /
// two-sided votes) interleaved in the exact order they'll be run. Polls/quizzes
// are NOT a separate library — they're authored INLINE and saved as a JSON blob
// directly into a class's timeline, because they're ephemeral and only meaningful
// in the context of one specific class.
//
// During a live run the tutor walks this timeline beside the preview, clicks an
// item to push it live + sync it to every viewer, and marks each item DONE with a
// GREEN (went well) or RED (revisit) flag. The flags persist so going back is
// trivial after the class.
//
// PLATFORM NEUTRALITY: this module is pure serializable model + plain reducers
// (no DOM, no zustand, no web APIs, no AsyncStorage), so web and React Native
// reuse it VERBATIM. Web keeps its zustand wrapper; mobile keeps whatever store it
// binds. The ONLY domain dependency is `MaterialMeta` from `@paxpia/core/materials`
// (itself platform-agnostic metadata). Reducers in `ops.ts` are
// collection-level (operate on a `ScheduledStream[]`) so a store of any flavor can
// delegate to them; a store provides only its own id generator.

import type { DocPayload, OverlayKind, PollPayload, QuizPayload, VoteButtonPayload } from '../overlays';
import type { MaterialMeta } from '../materials';

/** Overlay kinds a tutor can AUTHOR inline (everything that isn't a live media
 *  source). `doc` is authored from a picked material rather than the poll form. */
export type AuthoredKind = Extract<OverlayKind, 'poll' | 'quiz' | 'vote-button' | 'doc'>;
export type AuthoredPayload = PollPayload | VoteButtonPayload | QuizPayload | DocPayload;

/** The progress flag a tutor sets on a timeline item DURING the live run.
 *  green = done/went well; red = revisit later; null = not yet run / unflagged. */
export type DoneFlag = 'green' | 'red' | null;

/** A picked material in the timeline — the renderable doc the tutor will push
 *  live (we copy the whole MaterialMeta in so the timeline is self-describing
 *  even if the material is later renamed/removed from the library). */
export interface TimelineMaterialItem {
  id: string;
  kind: 'material';
  /** Position in the ordered timeline (0-based). Kept contiguous by reorder. */
  order: number;
  done: DoneFlag;
  material: MaterialMeta;
}

/** An authored overlay in the timeline — the poll/quiz/vote JSON blob the tutor
 *  built inline. Self-contained: title + kind + payload, no external draft to
 *  resolve. */
export interface TimelineOverlayItem {
  id: string;
  kind: 'overlay';
  order: number;
  done: DoneFlag;
  overlay: {
    kind: AuthoredKind;
    title: string;
    payload: AuthoredPayload;
  };
}

export type TimelineItem = TimelineMaterialItem | TimelineOverlayItem;

/** The authored overlay blob carried by a {@link TimelineOverlayItem}. */
export type TimelineOverlay = TimelineOverlayItem['overlay'];

export type ScheduledVisibility = 'public' | 'private';

export interface ScheduledStream {
  id: string;
  title: string;
  startUnix: number;
  /** public = anyone can watch; private = community/super-followers only. */
  visibility: ScheduledVisibility;
  /** The ORDERED timeline (materials + overlays) the tutor runs through live,
   *  top → bottom. `order` on each item is the source of truth; we keep `items`
   *  sorted by it. */
  items: TimelineItem[];
  /** The producer SCENES this class may run live (ids into the scenes store). A
   *  class must have ≥1 assigned scene to go live; the streamer HOT-SWAPS among
   *  exactly these during the run — there is NO implicit default scene. The first
   *  id is just the run's starting selection (the streamer can switch instantly). */
  sceneIds: string[];
}
