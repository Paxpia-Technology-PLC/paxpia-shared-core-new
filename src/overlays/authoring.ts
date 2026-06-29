// PARTICIPATION AUTHORING — the pure CREATE/EDIT half of the poll / quiz /
// vote-button overlays (WI-7e). The runtime/voting/results half already lives in
// `kinds/participation.ts` (the `OverlayModule`s) + `wire.ts`; this module is the
// AUTHORING-ONLY companion: a platform-neutral draft shape + pure builders +
// mutators + a validator + a `draft → payload` finalizer.
//
// Why a DRAFT and not the payload directly? The wire payloads (`PollPayload`,
// `QuizPayload`, `VoteButtonPayload`) are FINAL shapes — poll/quiz carry
// `options[]`, vote-button carries `{ a, b }`, quiz carries `correctOptionId`.
// While the tutor is typing, the form needs ONE editable shape that survives a
// kind switch (poll ↔ quiz keeps the same options; switching to vote-button keeps
// the first two as the two sides). So the draft is a single super-shape
// (`question + options[] + correctOptionId`) and `finalizeParticipationDraft`
// projects it down to the right wire payload per kind. Both web and mobile bind
// the SAME draft + helpers, so the authoring behaviour can't diverge.
//
// PURE — no UI, no platform, no id scheme baked in: each option-add takes an
// `idGen: () => string` so each app keeps its own (web `Math.random`, RN uuid/same),
// exactly like `scheduling/ops.ts`.

import type { PollPayload, QuizPayload, VoteButtonPayload } from './types';

/** The three participation kinds a tutor can author with this form. (Doc overlays
 *  are authored from a picked material, NOT here — see `scheduling/types.ts`.) */
export type ParticipationKind = 'poll' | 'quiz' | 'vote-button';

/** The final wire payload for any participation kind. */
export type ParticipationPayload = PollPayload | QuizPayload | VoteButtonPayload;

/** One editable option row in the draft (id + label). The id is content-stable for
 *  the round (it becomes the option id on the wire payload + the vote key). */
export interface DraftOption {
  id: string;
  label: string;
}

/** The single editable super-shape the authoring form binds. It carries enough to
 *  build ANY of the three payloads, so switching kinds mid-edit never loses the
 *  question/options the tutor already typed.
 *    • `kind`            — which payload this finalizes to.
 *    • `question`        — the question / prompt (vote-button calls it a prompt).
 *    • `options`         — the answer rows. poll/quiz use all of them; vote-button
 *                          uses exactly the first two as side A / side B.
 *    • `correctOptionId` — quiz only: the id of the correct answer (revealed on
 *                          close). Ignored for poll/vote-button. */
export interface ParticipationDraft {
  kind: ParticipationKind;
  question: string;
  options: DraftOption[];
  correctOptionId?: string;
}

/** An id generator the caller supplies for new option rows (web: Math.random; RN:
 *  uuid or same). Named distinctly from scheduling/studio's `IdGen` so the overlays
 *  barrel doesn't collide with them at the `@paxpia/core` top-level surface. */
export type OptionIdGen = () => string;

/** Min options any participation overlay needs (poll/quiz ≥2; vote-button is exactly 2). */
export const MIN_PARTICIPATION_OPTIONS = 2;
/** A sane upper bound so a poll/quiz UI stays tappable (and bars stay readable). */
export const MAX_PARTICIPATION_OPTIONS = 8;

// ── builders ──────────────────────────────────────────────────────────────────

/** A blank option row. */
export function newOption(idGen: OptionIdGen, label = ''): DraftOption {
  return { id: idGen(), label };
}

/** A blank POLL draft (question + two empty options). */
export function newPollDraft(idGen: OptionIdGen): ParticipationDraft {
  return { kind: 'poll', question: '', options: [newOption(idGen), newOption(idGen)] };
}

/** A blank QUIZ draft (question + two empty options, no correct answer yet). */
export function newQuizDraft(idGen: OptionIdGen): ParticipationDraft {
  return { kind: 'quiz', question: '', options: [newOption(idGen), newOption(idGen)], correctOptionId: undefined };
}

/** A blank VOTE-BUTTON draft (prompt + exactly two sides A/B). */
export function newVoteButtonDraft(idGen: OptionIdGen): ParticipationDraft {
  return { kind: 'vote-button', question: '', options: [newOption(idGen), newOption(idGen)] };
}

/** A blank draft for any kind. */
export function newParticipationDraft(kind: ParticipationKind, idGen: OptionIdGen): ParticipationDraft {
  if (kind === 'quiz') return newQuizDraft(idGen);
  if (kind === 'vote-button') return newVoteButtonDraft(idGen);
  return newPollDraft(idGen);
}

// ── mutators (pure — return a NEW draft, never mutate the input) ────────────────

/** Switch the draft's kind, preserving what carries over:
 *    • → vote-button COLLAPSES to exactly two sides (keeps the first two options,
 *      padding with blanks if there were fewer), since a vote button is always A/B.
 *    • leaving vote-button keeps those two as the starting options (the tutor can
 *      add more for a poll/quiz).
 *    • → poll DROPS the correct-answer mark (poll has no correct answer).
 *  The question text always carries over. */
export function setDraftKind(draft: ParticipationDraft, kind: ParticipationKind, idGen: OptionIdGen): ParticipationDraft {
  if (kind === draft.kind) return draft;
  let options = draft.options;
  if (kind === 'vote-button') {
    options = [options[0] ?? newOption(idGen), options[1] ?? newOption(idGen)];
  }
  const correctOptionId = kind === 'quiz' ? draft.correctOptionId : undefined;
  return { ...draft, kind, options, correctOptionId };
}

/** Set the question / prompt text. */
export function setDraftQuestion(draft: ParticipationDraft, question: string): ParticipationDraft {
  return { ...draft, question };
}

/** Append a blank option (poll/quiz only — capped at {@link MAX_PARTICIPATION_OPTIONS};
 *  a vote-button is fixed at two sides, so this is a no-op for it). */
export function addDraftOption(draft: ParticipationDraft, idGen: OptionIdGen): ParticipationDraft {
  if (draft.kind === 'vote-button') return draft;
  if (draft.options.length >= MAX_PARTICIPATION_OPTIONS) return draft;
  return { ...draft, options: [...draft.options, newOption(idGen)] };
}

/** Edit one option's label by id. */
export function editDraftOption(draft: ParticipationDraft, optionId: string, label: string): ParticipationDraft {
  return { ...draft, options: draft.options.map((o) => (o.id === optionId ? { ...o, label } : o)) };
}

/** Remove an option by id. No-op when it would drop below the minimum, or for a
 *  vote-button (always exactly two sides). If the removed option was the quiz's
 *  correct answer, the mark is cleared. */
export function removeDraftOption(draft: ParticipationDraft, optionId: string): ParticipationDraft {
  if (draft.kind === 'vote-button') return draft;
  if (draft.options.length <= MIN_PARTICIPATION_OPTIONS) return draft;
  const options = draft.options.filter((o) => o.id !== optionId);
  const correctOptionId = draft.correctOptionId === optionId ? undefined : draft.correctOptionId;
  return { ...draft, options, correctOptionId };
}

/** Mark which option is the correct answer (QUIZ only; no-op otherwise). */
export function setDraftCorrect(draft: ParticipationDraft, optionId: string): ParticipationDraft {
  if (draft.kind !== 'quiz') return draft;
  return { ...draft, correctOptionId: optionId };
}

// ── validation ──────────────────────────────────────────────────────────────────

/** A field-keyed validation result. `ok` gates the Save button; `errors` can drive
 *  inline field hints. The keys are stable so a UI can map them to fields. */
export interface ParticipationValidation {
  ok: boolean;
  errors: {
    /** Question/prompt is empty. */
    question?: string;
    /** Fewer than the minimum non-empty options (or, for vote-button, a missing side). */
    options?: string;
    /** Quiz only: a correct answer hasn't been marked (or points at a removed option). */
    correct?: string;
  };
}

/** The non-empty, trimmed options of a draft (the ones that count toward validity
 *  and become the wire payload). Order-preserving. */
export function filledOptions(draft: ParticipationDraft): DraftOption[] {
  return draft.options.map((o) => ({ id: o.id, label: o.label.trim() })).filter((o) => o.label.length > 0);
}

/** Validate a participation draft for finalization. Pure — same input, same result.
 *    • question/prompt must be non-blank;
 *    • poll/quiz need ≥2 non-empty options; vote-button needs BOTH sides filled;
 *    • a quiz must mark a correct answer, and it must be one of the FILLED options. */
export function validateParticipationDraft(draft: ParticipationDraft): ParticipationValidation {
  const errors: ParticipationValidation['errors'] = {};
  if (!draft.question.trim()) {
    errors.question = draft.kind === 'vote-button' ? 'Enter a prompt.' : 'Enter a question.';
  }

  const filled = filledOptions(draft);
  if (draft.kind === 'vote-button') {
    // Exactly two sides; BOTH must be filled (the first two rows are A and B).
    const a = draft.options[0]?.label.trim();
    const b = draft.options[1]?.label.trim();
    if (!a || !b) errors.options = 'Fill in both sides (A and B).';
  } else if (filled.length < MIN_PARTICIPATION_OPTIONS) {
    errors.options = `Add at least ${MIN_PARTICIPATION_OPTIONS} options.`;
  }

  if (draft.kind === 'quiz') {
    const valid = draft.correctOptionId && filled.some((o) => o.id === draft.correctOptionId);
    if (!valid) errors.correct = 'Mark the correct answer.';
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

/** Convenience boolean — true when the draft finalizes cleanly. */
export function isParticipationDraftValid(draft: ParticipationDraft): boolean {
  return validateParticipationDraft(draft).ok;
}

// ── finalize (draft → wire payload) ──────────────────────────────────────────────

/** Project a VALIDATED draft down to its wire payload, or `null` when the draft is
 *  invalid (so a caller can `const p = finalize(...); if (!p) return;`). poll/quiz
 *  ship the filled options; quiz also ships `correctOptionId`; vote-button ships the
 *  first two filled rows as `{ a, b }`. The question is trimmed. */
export function finalizeParticipationDraft(draft: ParticipationDraft): ParticipationPayload | null {
  if (!isParticipationDraftValid(draft)) return null;
  const question = draft.question.trim();
  const filled = filledOptions(draft);

  if (draft.kind === 'vote-button') {
    // Validation guaranteed both sides are filled; take the first two.
    return { prompt: question, a: filled[0], b: filled[1] } satisfies VoteButtonPayload;
  }
  if (draft.kind === 'quiz') {
    return {
      question,
      options: filled,
      // Validation guaranteed correctOptionId points at a filled option.
      correctOptionId: draft.correctOptionId,
    } satisfies QuizPayload;
  }
  return { question, options: filled } satisfies PollPayload;
}

/** The authored-overlay blob a participation draft becomes in a scheduling timeline
 *  (`TimelineOverlayItem['overlay']` shape: `{ kind, title, payload }`). Returns
 *  `null` for an invalid draft. The `title` mirrors the question/prompt so the
 *  timeline row + preview have a label. Kept here (not in scheduling) so authoring
 *  has ONE finalizer; scheduling's `addOverlayItem` accepts exactly this shape. */
export function finalizeParticipationOverlay(
  draft: ParticipationDraft,
): { kind: ParticipationKind; title: string; payload: ParticipationPayload } | null {
  const payload = finalizeParticipationDraft(draft);
  if (!payload) return null;
  return { kind: draft.kind, title: draft.question.trim(), payload };
}

// ── hydrate (existing payload → draft, for EDITING an already-saved overlay) ──────

/** Rebuild an editable draft from a finalized payload (so a saved timeline overlay
 *  can be re-opened in the editor). Inverse of {@link finalizeParticipationDraft}. */
export function draftFromPayload(kind: ParticipationKind, payload: ParticipationPayload): ParticipationDraft {
  if (kind === 'vote-button') {
    const p = payload as VoteButtonPayload;
    return { kind, question: p.prompt, options: [p.a, p.b] };
  }
  if (kind === 'quiz') {
    const p = payload as QuizPayload;
    return { kind, question: p.question, options: p.options.map((o) => ({ ...o })), correctOptionId: p.correctOptionId };
  }
  const p = payload as PollPayload;
  return { kind, question: p.question, options: p.options.map((o) => ({ ...o })) };
}
