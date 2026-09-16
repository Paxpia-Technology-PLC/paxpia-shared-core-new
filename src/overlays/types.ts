// Overlay framework — the flexible, lifecycle-aware system for everything that
// rides on top of (or beside) a live video: illustrations, polls, two-sided
// vote buttons, quizzes, synced docs, gift toasts. One model, rendered per
// platform; the data + lifecycle are shared so web and mobile behave identically
// and a stream can cycle between overlay types over time.

// Type-only: `books/types.ts` has no reverse dependency on this file, so this
// does not create a real module cycle (only `books/payload.ts` imports `DocPayload`,
// one-directionally, to CONSTRUCT one).
import type { BookPage } from '../books/types';

export type OverlayKind =
  | 'svg' // freehand illustration / whiteboard strokes
  | 'poll' // multi-option poll
  | 'vote-button' // two-sided TikTok-style vote (A vs B)
  | 'quiz' // question + answers, collects responses
  | 'doc' // synced paged document
  | 'gift' // gift toast feed
  | 'whiteboard'; // synced, takeover-capable freehand board (WebView-rendered, like doc)

/** The lifecycle states an overlay instance can hold.
 *
 * `draft` and `revealed` were added so the phase vocabulary covers the control
 * verbs that produce them (`create` → draft, `reveal` → revealed). They were
 * previously expressible ONLY on `OverlayResultsMsg.phase`, which widened the
 * union inline — so the bot could report a phase that no `OverlayInstance` was
 * able to store, and the two halves of the same lifecycle disagreed by design.
 *
 * Order is lifecycle order: idle → draft → active → closed → revealed. */
export type OverlayPhase = 'idle' | 'draft' | 'active' | 'closed' | 'revealed';

/** A live overlay instance on a stream. `gen` (generation) bumps on every reset
 *  so a new round re-opens participation; `payload` is kind-specific. */
export interface OverlayInstance<P = unknown> {
  id: string;
  kind: OverlayKind;
  phase: OverlayPhase;
  gen: number;
  startedAtUnix?: number;
  endsAtUnix?: number; // for timed overlays (e.g. a 30s poll)
  payload: P;
  /** Aggregate results (publisher/server-authoritative), e.g. option tallies. */
  results?: Record<string, number>;
}

// ── Kind-specific payloads ───────────────────────────────────────────────────
export interface PollPayload {
  question: string;
  options: { id: string; label: string }[];
}
export interface VoteButtonPayload {
  /** Two sides, e.g. { a: 'Cats', b: 'Dogs' }. */
  prompt: string;
  a: { id: string; label: string };
  b: { id: string; label: string };
}
export interface QuizPayload {
  question: string;
  options: { id: string; label: string }[];
  correctOptionId?: string; // revealed when phase === 'closed'
}

/** A synced paged document (class materials: slides, worksheets). `pages` are
 *  per-page image URLs in order (rendered client-side from a PDF, or uploaded
 *  slide images); `page` is the page the streamer is currently showing and is
 *  synced live — flipping it re-broadcasts the instance so every viewer follows
 *  along. Page images live in object storage; only their URLs ride the wire. */
export interface DocPayload {
  title: string;
  pages: string[];
  page: number;
  /** The viewer-resolvable SOURCE url (presigned MinIO/CDN) of the doc. `pages` are
   *  the producer's LOCAL rasterized page blobs (cross-device useless), so the
   *  pre-join PREP manifest must carry THIS so other devices can fetch + render it. */
  sourceUrl?: string;
  /** The source file's MIME (e.g. application/epub+zip, application/pdf). Set when a
   *  doc is built WITHOUT a live manifest — the studio PREVIEW path, where there's no
   *  room manifest to read the kind from. Lets resolveDocRender pick the epub/pdf/
   *  image leaf off `sourceUrl` alone. EPUB especially needs it: it ships with EMPTY
   *  pages[] (reflowable, never rasterized), so with no manifest AND no mime hint the
   *  plan would fall to 'empty'. Live rooms still derive the kind from the manifest. */
  sourceMime?: string;
  /** A written book's current chapter (see `@paxpia/core/books`). Present ⇒
   *  `resolveDocRender` returns kind 'book' before any other branch — a book has
   *  no file, no `pages`, no `sourceUrl`, so every other branch would otherwise
   *  land on 'empty'. Pagination (which chapter, how many) rides `page` above;
   *  this is just the one chapter's content. */
  book?: BookPage;
}

/** A live whiteboard. Strokes do NOT live here (they stream as deltas, like doc
 *  pages broadcast separately); the payload is just the board identity + canvas
 *  geometry every front renders in, so a viewer can resolve a render plan offline.
 *  Strokes ride the SHARED `overlay` topic as `overlay.wb.*` envelopes (see
 *  overlays/whiteboard.ts) and are composited natively in the WebView (whiteboardHtml.ts),
 *  exactly like the doc engine — NOT a private data plane. */
export interface WhiteboardPayload {
  boardId: string;
  /** The fixed authoring/render space (publisher coords). Default 1000x1000. */
  canvas: { w: number; h: number };
  /** Optional background (a presigned image/PDF-page url) the board is drawn over. */
  backgroundUrl?: string;
  title?: string;
  /** SYNCED operator setting — transparent background: when true the board page renders
   *  alpha-0 so the underlying scene sources composite through (default opaque). It rides
   *  the payload on `scene.sync` so EVERY viewer (web + mobile) renders the SAME
   *  transparency the operator chose — it is NOT operator-local. Absent ⇒ opaque. */
  transparent?: boolean;
  /** SYNCED operator setting — viewer-visibility: when true the operator has HIDDEN the
   *  board from viewers. The director DROPS a hidden board from the viewer's rendered set
   *  (so "for viewers the whole thing is gone"), while the operator keeps a GHOSTED copy
   *  it can still draw on. Carried so the state is observable + survives a scene rebuild.
   *  Absent ⇒ visible. */
  hidden?: boolean;
}

/** Per-user, per-overlay state that MUST persist across logout/login (e.g. "you
 *  already voted"). Keyed by (overlayId, gen) so a reset re-opens participation
 *  but a re-login within the same round still shows the user's committed choice. */
export interface UserOverlayState {
  overlayId: string;
  gen: number;
  /** The committed choice for this round (e.g. option id). Absent = not acted. */
  choice?: string;
  actedAtUnix?: number;
}

/** The CANONICAL participation view-model the overlay renderers (poll / quiz /
 *  vote-button) consume — `voted`/`mine`/`tallies`/`total`/`onVote`. It is the
 *  single shape that drives a participation overlay's render + interaction:
 *    • `voted`  — has this viewer committed a choice this round?
 *    • `mine`   — the choice they committed (option id), if any.
 *    • `tallies`— per-option vote counts (server-mirrored + optimistic fold).
 *    • `total`  — the sum across options (the denominator for the % bars).
 *    • `onVote` — commit a choice (the platform binds this to the data channel).
 *
 *  Promoted here (out of BOTH web `overlay/renderers.tsx` AND mobile
 *  `useLivestreamSync.ts`, where it was duplicated verbatim) so web + mobile +
 *  the studio + the mobile creator dashboard all reference ONE definition. The
 *  render-brain (`useOverlaySession`, Task C) returns this; the `@paxpia/ui`
 *  participation components (Task E) consume it. Pure — no platform primitive in
 *  the shape, only the `onVote` callback the platform supplies. */
export interface OverlayViewProps {
  voted: boolean;
  mine?: string;
  tallies: Record<string, number>;
  total: number;
  onVote: (choice: string) => void;
}
