// Overlay framework — the flexible, lifecycle-aware system for everything that
// rides on top of (or beside) a live video: illustrations, polls, two-sided
// vote buttons, quizzes, synced docs, gift toasts. One model, rendered per
// platform; the data + lifecycle are shared so web and mobile behave identically
// and a stream can cycle between overlay types over time.

export type OverlayKind =
  | 'svg' // freehand illustration / whiteboard strokes
  | 'poll' // multi-option poll
  | 'vote-button' // two-sided TikTok-style vote (A vs B)
  | 'quiz' // question + answers, collects responses
  | 'doc' // synced paged document
  | 'gift'; // gift toast feed

export type OverlayPhase = 'idle' | 'active' | 'closed';

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
