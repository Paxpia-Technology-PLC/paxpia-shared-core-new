// pollView — the ONE translation between the authoritative overlay wire and the
// flattened shape a poll card renders.
//
// ── Why this lives in shared-core ────────────────────────────────────────────
// It started life in `Paxpia-website/src/livePollModel.ts`. Copying it to mobile
// would have recreated exactly the drift this whole migration exists to end: the
// two lanes once disagreed about whether the tally field was `counts` or
// `tallies`, and nothing caught it because each side owned its own mapping. One
// module, two platforms, one set of tests.
//
// Pure: no React, no LiveKit, no fetch. It only reshapes data it is handed.
//
// ── The one rule ─────────────────────────────────────────────────────────────
// This NEVER counts anything. `tallies` and `total` come from the bot's
// `overlay.results` verbatim. Clients used to sum locally (and, worse, the web
// host once invented votes with a random-number timer); they do not any more,
// and they must not start again — the bot's Redis tally is the only count.

// `OverlayResultsMsg` is the WIRE shape (wire.ts); the rest are payload types.
import type { OverlayResultsMsg } from './wire';
import type {
  OverlayInstance,
  PollPayload,
  QuizPayload,
  VoteButtonPayload,
} from './types';

/** The site's existing view model — kept EXACTLY as `Live.tsx` already declares
 *  it, so `OverlayCard` renders it unchanged. */
export interface PollOption { id: string; label: string; correct?: boolean }
export interface PollViewModel {
  id: string;
  /** The bot's `vote-button` collapses to the site's existing `vote`. */
  kind: 'poll' | 'quiz' | 'vote';
  title: string;
  options: PollOption[];
  /** choiceId → count. Straight from the bot. Never computed here. */
  tallies: Record<string, number>;
  phase: 'active' | 'reveal' | 'closed';
  /** This viewer's own committed choice, as the BOT reports it (`mine`). */
  myChoice?: string;
  /** The round. A results tick for an older gen must be ignored by the caller. */
  gen: number;
  /** The BOT's own phase, unmapped. The host needs it to distinguish a staged
   *  draft (offer "Go Live") from a genuinely closed poll (offer "Reveal"), which
   *  the mapped `phase` deliberately collapses together. */
  serverPhase: string;
  /** Authoritative response count. `Σ tallies` by construction server-side; kept
   *  separate rather than re-summed so the number shown is the one sent. */
  total: number;
}

/** A staged `draft` is NOT public: viewers must not see a question the creator is
 *  still writing. The creator does need to see it — that is the review step before
 *  Go Live — so the host passes `forHost` and gets it back mapped to 'closed',
 *  which renders the card in its non-votable form. Everything else maps 1:1. */
function phaseOf(phase: string, forHost: boolean): PollViewModel['phase'] | null {
  switch (phase) {
    case 'active': return 'active';
    case 'closed': return 'closed';
    case 'revealed': return 'reveal';
    case 'draft': return forHost ? 'closed' : null;
    default: return null; // 'idle' | anything newer
  }
}

/** Pull {title, options} out of the bot's opaque payload for the three
 *  participation kinds. Returns null for a kind this card cannot draw (doc,
 *  whiteboard, svg, gift all ride the same overlay system). */
function contentOf(
  overlay: OverlayInstance,
): { kind: PollViewModel['kind']; title: string; options: PollOption[] } | null {
  const p = overlay.payload as Partial<PollPayload & QuizPayload & VoteButtonPayload> | undefined;
  if (!p) return null;

  if (overlay.kind === 'poll' || overlay.kind === 'quiz') {
    const options = Array.isArray(p.options) ? p.options : [];
    if (options.length === 0) return null;
    const correctId = overlay.kind === 'quiz' ? p.correctOptionId : undefined;
    return {
      kind: overlay.kind,
      title: p.question ?? '',
      // `correct` is only ever attached for a quiz, and the card only paints it
      // once the phase is `reveal` — so carrying it early cannot leak the answer.
      options: options.map((o) => ({
        id: o.id,
        label: o.label,
        ...(correctId && o.id === correctId ? { correct: true } : {}),
      })),
    };
  }

  if (overlay.kind === 'vote-button') {
    if (!p.a || !p.b) return null;
    return {
      kind: 'vote',
      title: p.prompt ?? '',
      options: [
        { id: p.a.id, label: p.a.label },
        { id: p.b.id, label: p.b.label },
      ],
    };
  }

  return null; // doc / whiteboard / svg / gift — not a poll surface
}

/**
 * Build the view model for the current overlay, or null when there is nothing
 * this card should draw (no overlay, a staged draft, a non-participation kind,
 * or a malformed payload).
 *
 * `results` is the last authoritative tick; `mine` is the bot's per-identity
 * echo. Both are optional because `overlay.changed` can arrive before the first
 * `overlay.results` — an unvoted poll renders with empty bars, which is correct.
 */
export function toPollViewModel(
  overlay: OverlayInstance | null | undefined,
  results?: Pick<OverlayResultsMsg, 'overlayId' | 'gen' | 'tallies' | 'total'> | null,
  mine?: string,
  opts?: { forHost?: boolean },
): PollViewModel | null {
  if (!overlay) return null;
  const phase = phaseOf(overlay.phase, opts?.forHost === true);
  if (!phase) return null;
  const content = contentOf(overlay);
  if (!content) return null;

  // A tick from a DIFFERENT overlay, or an OLDER round, is not this poll's count.
  // Dropping it to zeroes is deliberate: showing the previous round's numbers under
  // a fresh question is worse than showing none, and the next tick is ~500ms away.
  const fresh = results && results.overlayId === overlay.id && results.gen >= overlay.gen;

  return {
    id: overlay.id,
    kind: content.kind,
    title: content.title,
    options: content.options,
    tallies: fresh ? { ...results.tallies } : {},
    total: fresh ? results.total : 0,
    phase,
    myChoice: mine || undefined,
    gen: overlay.gen,
    serverPhase: overlay.phase,
  };
}

/** Percentage of the authoritative total, 0 when nothing has been cast yet.
 *  Rounded for display only — the counts themselves are never derived from this. */
export function pollPct(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

// ── authoring: the composer's draft → the instance the bot persists ──────────

/** Production limits. The backend keeps overlay payloads opaque, so it enforces
 *  no per-kind shape — these are the client's guard, and they are checked here
 *  (pure, tested) rather than only in the form, so no call path can skip them. */
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_QUESTION = 120;
export const POLL_MAX_OPTION = 60;

export interface PollDraft {
  kind: 'poll' | 'quiz' | 'vote';
  title: string;
  options: { id: string; label: string; correct?: boolean }[];
}

/** Why a draft cannot be published, or null when it can. The messages are the
 *  ones shown to the creator, so they name the actual problem. */
export function validatePollDraft(draft: PollDraft): string | null {
  const title = draft.title.trim();
  if (!title) return 'Add a question.';
  if (title.length > POLL_MAX_QUESTION) return `Keep the question under ${POLL_MAX_QUESTION} characters.`;

  const labelled = draft.options.filter((o) => o.label.trim());
  if (labelled.length < POLL_MIN_OPTIONS) return `Add at least ${POLL_MIN_OPTIONS} options.`;
  if (labelled.length > POLL_MAX_OPTIONS) return `Use at most ${POLL_MAX_OPTIONS} options.`;
  if (labelled.some((o) => o.label.trim().length > POLL_MAX_OPTION)) {
    return `Keep each option under ${POLL_MAX_OPTION} characters.`;
  }
  // Duplicates are rejected here because the tally is keyed by option ID: two
  // options reading "Go" would produce two separate bars with the same label and
  // a result nobody can interpret.
  const seen = new Set<string>();
  for (const o of labelled) {
    const k = o.label.trim().toLowerCase();
    if (seen.has(k)) return `"${o.label.trim()}" is listed twice.`;
    seen.add(k);
  }
  if (draft.kind === 'quiz' && !labelled.some((o) => o.correct)) return 'Mark the correct answer.';
  return null;
}

/** Build the `OverlayInstance` the bot stores. `gen` is 0 and `phase` is 'draft':
 *  the bot assigns the real generation and drives the lifecycle — a client-minted
 *  gen is explicitly ignored by `store.Reset`/`Respond`, which is what keeps the
 *  round authoritative. Returns null for an invalid draft. */
export function pollDraftToOverlay(draft: PollDraft, id: string): OverlayInstance | null {
  if (validatePollDraft(draft)) return null;
  const title = draft.title.trim();
  const opts = draft.options
    .filter((o) => o.label.trim())
    .map((o) => ({ id: o.id, label: o.label.trim(), correct: o.correct }));

  if (draft.kind === 'vote') {
    const payload: VoteButtonPayload = {
      prompt: title,
      a: { id: opts[0].id, label: opts[0].label },
      b: { id: opts[1].id, label: opts[1].label },
    };
    return { id, kind: 'vote-button', phase: 'draft', gen: 0, payload };
  }

  const options = opts.map((o) => ({ id: o.id, label: o.label }));
  if (draft.kind === 'quiz') {
    const payload: QuizPayload = {
      question: title,
      options,
      correctOptionId: opts.find((o) => o.correct)?.id,
    };
    return { id, kind: 'quiz', phase: 'draft', gen: 0, payload };
  }
  const payload: PollPayload = { question: title, options };
  return { id, kind: 'poll', phase: 'draft', gen: 0, payload };
}
