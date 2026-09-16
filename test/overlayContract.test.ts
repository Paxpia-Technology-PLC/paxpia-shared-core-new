// The overlay lane contract — the invariants a bot and both clients must agree on.
// Same inline assert harness as the sibling tests:
//     node --experimental-strip-types test/overlayContract.test.ts
//
// This exists because the lane's field names drifted once already and NOTHING
// caught it: `DirectorResultsMsg` declared only `{overlayId, gen}`, so producers
// cast their payload through `as unknown as` to publish it at all, and the web
// aggregator shipped `counts` where every reader wanted `tallies`. The compiler
// could not object to an argument about a field the type had deleted. These pin
// the names and the shapes so the next drift fails here instead of in a live room.

import {
  buildResultsMsg,
  resultsFromSnapshot,
  emptyVoteSnapshot,
  mineFromSnapshot,
  foldOptimisticTally,
  resultsMatchOverlay,
  stableVoteIdentity,
  tally,
  totalVotes,
  decodeOverlayMsg,
  encodeOverlayMsg,
  OVERLAY_TOPIC,
  OVERLAY_WIRE_VERSION,
  type OverlayResultsMsg,
} from '../src/overlays/wire.ts';
import type { DirectorResultsMsg } from '../src/director/types.ts';
import type { OverlayPhase } from '../src/overlays/types.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}

// ── the transport constants both ends key on ─────────────────────────────────
ok(OVERLAY_TOPIC === 'overlay', 'topic is "overlay"');
ok(OVERLAY_WIRE_VERSION === 1, 'wire version is 1');

// ── results carry `tallies`, never `counts` ──────────────────────────────────
{
  const msg = buildResultsMsg('room1', { id: 'ov1', gen: 3, phase: 'active' }, [
    { identity: 'u1', choice: 'a' },
    { identity: 'u2', choice: 'a' },
    { identity: 'u3', choice: 'b' },
  ]);
  ok('tallies' in msg, 'results has `tallies`');
  ok(!('counts' in msg), 'results does NOT have `counts`');
  ok(msg.tallies.a === 2 && msg.tallies.b === 1, 'tallies bucket by choice');
  ok(msg.total === 3, 'total is the response count');
  ok(msg.t === 'overlay.results' && msg.v === OVERLAY_WIRE_VERSION, 'results envelope tagged');
  ok(msg.roomName === 'room1' && msg.overlayId === 'ov1' && msg.gen === 3, 'results identifies its round');

  // THE assignability the cast used to paper over: a concrete wire message must be
  // usable as a DirectorResultsMsg with no cast at all.
  const asDirector: DirectorResultsMsg = msg;
  ok(asDirector.tallies.a === 2 && asDirector.total === 3, 'OverlayResultsMsg IS a DirectorResultsMsg');
}

// ── the response field is `choice`, never `optionId` ─────────────────────────
{
  const bytes = encodeOverlayMsg({
    t: 'overlay.response', v: OVERLAY_WIRE_VERSION, overlayId: 'ov1', gen: 1, choice: 'a',
  });
  const back = decodeOverlayMsg(bytes) as Record<string, unknown> | null;
  ok(!!back && back.t === 'overlay.response', 'response round-trips');
  ok(!!back && 'choice' in back, 'response has `choice`');
  ok(!!back && !('optionId' in back), 'response does NOT have `optionId`');
}

// ── the state frame is `overlay.changed`, never `overlay.active` ─────────────
{
  const bytes = encodeOverlayMsg({
    t: 'overlay.changed', v: OVERLAY_WIRE_VERSION, roomName: 'r', overlay: null,
  });
  const back = decodeOverlayMsg(bytes);
  ok(back?.t === 'overlay.changed', 'changed round-trips');
  // The decoder must REFUSE the web aggregator's spelling, rather than half-accept it.
  const foreign = new TextEncoder().encode(JSON.stringify({ t: 'overlay.active', overlay: null }));
  ok(decodeOverlayMsg(foreign) === null, 'decoder rejects `overlay.active`');
  const req = new TextEncoder().encode(JSON.stringify({ t: 'overlay.request_state' }));
  ok(decodeOverlayMsg(req) === null, 'decoder rejects the bare `overlay.request_state` frame');
}

// ── the phase vocabulary covers the control verbs that produce it ────────────
{
  // `create` → draft and `reveal` → revealed must be STORABLE on an instance, not
  // only reportable on a results tick (they were widened inline on the tick before).
  const phases: OverlayPhase[] = ['idle', 'draft', 'active', 'closed', 'revealed'];
  ok(phases.length === 5, 'five lifecycle phases');
  const draft: OverlayResultsMsg['phase'] = 'draft';
  const revealed: OverlayResultsMsg['phase'] = 'revealed';
  ok(draft === 'draft' && revealed === 'revealed', 'results phase accepts draft/revealed');
}

// ── last-choice-wins (⑪), as the optimistic fold implements it ───────────────
{
  // First vote: net +1.
  const first = foldOptimisticTally({ a: 2 }, undefined, 'b', 2);
  ok(first.tallies.b === 1 && first.total === 3, 'first vote adds one');

  // Re-vote: the vote MOVES; the total does not change.
  const moved = foldOptimisticTally({ a: 2, b: 1 }, 'a', 'b', 3);
  ok(moved.tallies.a === 1 && moved.tallies.b === 2, 're-vote moves the vote');
  ok(moved.total === 3, 're-vote leaves the total alone');

  // Re-sending the same choice is a no-op.
  const same = foldOptimisticTally({ a: 2 }, 'a', 'a', 2);
  ok(same.tallies.a === 2 && same.total === 2, 'same choice is a no-op');

  // One row per identity, so sum(tallies) === distinct voters === total.
  const rows = [
    { identity: 'u1', choice: 'a' },
    { identity: 'u2', choice: 'b' },
  ];
  ok(totalVotes(tally(rows)) === rows.length, 'total equals the voter count');
}

// ── round matching: accept gen >= known, drop strictly older ─────────────────
{
  const ov = { id: 'ov1', gen: 2 };
  ok(resultsMatchOverlay(ov, { overlayId: 'ov1', gen: 2 }), 'same gen matches');
  ok(resultsMatchOverlay(ov, { overlayId: 'ov1', gen: 3 }), 'newer gen matches (bot owns gen)');
  ok(!resultsMatchOverlay(ov, { overlayId: 'ov1', gen: 1 }), 'older gen is dropped');
  ok(!resultsMatchOverlay(ov, { overlayId: 'other', gen: 2 }), 'another overlay is dropped');
}

// ── the durable snapshot answers both the tally and `mine` ───────────────────
{
  const snap = { ...emptyVoteSnapshot('r', 'ov1', 4), rows: [
    { identity: 'u1', choice: 'a' },
    { identity: 'u2', choice: 'a' },
  ]};
  const ticked = resultsFromSnapshot(snap);
  ok(ticked.tallies.a === 2 && ticked.total === 2, 'snapshot projects to a results tick');
  ok(ticked.gen === 4 && ticked.overlayId === 'ov1', 'snapshot tick keeps its round');
  ok(mineFromSnapshot(snap, 'u1') === 'a', 'snapshot answers `mine`');
  ok(mineFromSnapshot(snap, 'nobody') === undefined, 'unknown identity has no `mine`');
  ok(emptyVoteSnapshot('r', 'ov1', 5).rows.length === 0, 'a reset writes an empty round');
}

// ── votes key on the STABLE identity, not the per-session one ────────────────
{
  ok(stableVoteIdentity('uuid-1::view::room::nonce') === 'uuid-1', 'session identity collapses');
  ok(stableVoteIdentity('guest-abc::view::room::n') === 'guest-abc', 'guest identity collapses');
  ok(stableVoteIdentity('bare-id') === 'bare-id', 'a bare id passes through');
  // Two sessions of one user must be ONE voter — the web aggregator keys on the raw
  // participant identity instead, which is how the same person votes twice there.
  const a = stableVoteIdentity('uuid-1::view::room::n1');
  const b = stableVoteIdentity('uuid-1::view::room::n2');
  ok(a === b, 'two sessions of one user are one voter');
}

if (failures.length) {
  console.error(`overlayContract: ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`overlayContract: ${passed} passed`);
