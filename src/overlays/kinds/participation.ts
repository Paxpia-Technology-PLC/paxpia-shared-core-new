// PARTICIPATION overlay modules (poll / quiz / vote-button) — wrap the EXISTING vote
// wire + tally folds into the per-kind `OverlayModule` contract. One factory builds
// all three (they share the bot-aggregated `VoteAggregate` shape, keyed `(overlayId,
// gen)`); only the `kind` discriminant differs.
//
// These are NOT transform-bearing — their `ResyncSnap` resolves to `never`, so
// `onResync` returns `null` (there is no view to snap; the bot aggregate IS the
// state). `capture` is `null` (no content artifact). The persist key is content-stable
// `(overlayId, gen)` so votes persist across a swap-out-and-back (P5 — already OK).

import type { OverlayKind, OverlayInstance } from '../types';
import {
  OVERLAY_WIRE_VERSION,
  encodeOverlayMsg,
  totalVotes,
  type OverlayResultsMsg,
  type OverlayResponseMsg,
} from '../wire';
import { brandPersistKey, emptyVoteAggregate } from '../module';
import type { OverlayModule, PersistKey, PersistCtx, VoteAggregate } from '../module';

type ParticipationKind = 'poll' | 'quiz' | 'vote-button';

/** Build a participation module for one kind. The three kinds share the aggregate +
 *  fold; only `kind` differs (so the registry's per-kind type is satisfied). */
function makeParticipationModule<K extends ParticipationKind>(kind: K): OverlayModule<K> {
  return {
    kind,

    /** Content-stable vote key `(overlayId, gen)` — re-serving the SAME overlay reuses
     *  the key so votes persist across a swap (P5). NEVER a mount nonce (P4). */
    persistKey(inst: OverlayInstance, _ctx: PersistCtx): PersistKey {
      return brandPersistKey(`vote:${inst.id}:${inst.gen}`);
    },

    /** Snapshot the aggregate as an `overlay.results` tick (the bot replay shape). */
    snapshot(state: VoteAggregate): OverlayResultsMsg {
      return resultsFor(state);
    },

    /** Apply a LOCAL vote — emit the viewer's `overlay.response`; the LOCAL aggregate
     *  is NOT mutated (the bot is authoritative for tallies; the optimistic fold lives
     *  in the vote view-model, not here). Pure. */
    applyLocal(state, mutation) {
      const msg: OverlayResponseMsg = {
        t: 'overlay.response',
        v: OVERLAY_WIRE_VERSION,
        overlayId: state.overlayId,
        gen: state.gen,
        choice: mutation.choice,
      };
      return { state, out: [{ bytes: encodeOverlayMsg(msg), reliable: true }] };
    },

    /** No content-capture artifact for a participation overlay. */
    capture() {
      return null;
    },

    /** Fold a REMOTE `overlay.results` tick into the aggregate — NEVER-REGRESS-GEN: a
     *  tick for a strictly OLDER round is ignored; a newer/equal gen adopts the bot's
     *  authoritative tallies. Per-cell LWW (the bot owns the tally). Pure. */
    applyRemote(state, delta: OverlayResultsMsg): VoteAggregate {
      if (delta.overlayId !== state.overlayId) return state;
      if (delta.gen < state.gen) return state; // stale round → drop
      const total = delta.total || totalVotes(delta.tallies);
      return { overlayId: state.overlayId, gen: delta.gen, tallies: { ...delta.tallies }, total };
    },

    /** Additive merge — the HIGHER gen wins (a newer round supersedes); at the same gen
     *  the bot tally is authoritative LWW (prefer `b`, the later fold). Commutative +
     *  idempotent for the converge guarantee. */
    merge(a, b): VoteAggregate {
      if (a.gen !== b.gen) return a.gen > b.gen ? a : b;
      return b; // same round → later authoritative tally
    },

    /** The round clock — the vote generation. */
    gen(state): number {
      return state.gen;
    },

    /** No view to snap — a participation overlay has no transform (ResyncSnap<K> is
     *  `never` here, so this returns `null`). */
    onResync() {
      return null;
    },

    /** RECONNECT replay: re-broadcast the current tallies as an `overlay.results` so a
     *  (re)joining viewer reconstructs the bars. */
    onReconnect(state, _key) {
      return [{ bytes: encodeOverlayMsg(resultsFor(state)), reliable: true }];
    },
  };
}

/** Build the `overlay.results` tick that mirrors an aggregate's tallies. */
function resultsFor(state: VoteAggregate): OverlayResultsMsg {
  return {
    t: 'overlay.results',
    v: OVERLAY_WIRE_VERSION,
    roomName: '',
    overlayId: state.overlayId,
    gen: state.gen,
    phase: 'active',
    tallies: { ...state.tallies },
    total: state.total,
  };
}

export const pollModule: OverlayModule<'poll'> = makeParticipationModule('poll');
export const quizModule: OverlayModule<'quiz'> = makeParticipationModule('quiz');
export const voteButtonModule: OverlayModule<'vote-button'> = makeParticipationModule('vote-button');

/** Re-export so the registry/tests can assert the empty aggregate shape. */
export { emptyVoteAggregate };

/** The participation kind set (for an exhaustiveness assertion in tests). */
export const PARTICIPATION_KINDS: readonly OverlayKind[] = ['poll', 'quiz', 'vote-button'];
