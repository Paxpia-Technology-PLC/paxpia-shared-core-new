// Unit tests for TASK C — the render-brain's PURE core (overlaySessionLogic.ts):
// the participation-vote reducer (applyVoteChanged / applyVoteResults /
// applyOptimisticVote / deriveVoteView) and the doc-takeover overlay
// (reconcileDocTakeover). These are the folds the headless `useOverlaySession` hook
// composes; testing them directly proves the vote/takeover/scene behaviour with NO
// React renderer (the hook itself is a thin useState/effect shell over exactly
// these, so the parity Noel needs is in this logic).
//
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/overlaySession.test.ts

import {
  initialVoteState,
  applyVoteChanged,
  applyVoteResults,
  applyOptimisticVote,
  deriveVoteView,
  reconcileDocTakeover,
  sceneIdKey,
  type PresentedDoc,
} from '../src/streaming/overlaySessionLogic.ts';
import {
  initialDocTakeover,
  takeOverDoc,
  isTakenOver,
} from '../src/streaming/docTakeover.ts';
import {
  initialViewerState,
  applyLiveSync,
  applySceneSync,
  type ViewerState,
} from '../src/streaming/viewer.ts';
import { buildRenderedScene } from '../src/streaming/scene.ts';
import type { LiveScene, LiveSyncMsg } from '../src/streaming/live.ts';
import type { OverlayInstance } from '../src/overlays/types.ts';
import type { OverlayResultsMsg } from '../src/overlays/wire.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

// ── fixtures ──────────────────────────────────────────────────────────────────
const poll = (id: string, gen = 1): OverlayInstance => ({
  id,
  kind: 'poll',
  phase: 'active',
  gen,
  payload: { question: id, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
});
const doc = (id: string, page = 0): OverlayInstance => ({
  id,
  kind: 'doc',
  phase: 'active',
  gen: 1,
  payload: { title: id, pages: [], page },
});
const results = (overlayId: string, gen: number, tallies: Record<string, number>): OverlayResultsMsg => ({
  t: 'overlay.results',
  v: 1,
  roomName: 'r',
  overlayId,
  gen,
  phase: 'active',
  tallies,
  total: Object.values(tallies).reduce((a, b) => a + b, 0),
});

// ════════════════════ VOTE FOLD ════════════════════
// ── new round resets optimistic/results; adopts server `mine` ──────────────────
{
  let v = initialVoteState();
  // First overlay arrives (no prior) → new round, no mine.
  v = applyVoteChanged(v, null, poll('p1'), undefined);
  eq(v, { myChoice: undefined, optimisticChoice: undefined, results: null }, 'first overlay → clean round');
  // Optimistic tap.
  v = applyOptimisticVote(v, 'a');
  eq(v.optimisticChoice, 'a', 'optimistic vote recorded');
  // Server confirms `mine = a` in the SAME round → adopt + clear matching optimistic.
  v = applyVoteChanged(v, poll('p1'), poll('p1'), 'a');
  eq(v.myChoice, 'a', 'server mine adopted in same round');
  eq(v.optimisticChoice, undefined, 'optimistic cleared once it matched the server mine');
  // A NEW round (gen bump) wipes the vote.
  v = applyVoteChanged(v, poll('p1', 1), poll('p1', 2), undefined);
  eq(v, { myChoice: undefined, optimisticChoice: undefined, results: null }, 'gen bump → fresh round');
}

// ── re-vote (change answer): a NEW choice goes through, dup is a no-op ──────────
{
  let v = initialVoteState();
  v = applyVoteChanged(v, null, poll('p1'), undefined);
  v = applyOptimisticVote(v, 'a');
  // Re-sending the SAME optimistic choice → no change.
  ok(applyOptimisticVote(v, 'a') === v, 're-sending the same optimistic choice is a no-op (by ref)');
  // A DIFFERENT choice → switch.
  v = applyOptimisticVote(v, 'b');
  eq(v.optimisticChoice, 'b', 'change-answer switches the optimistic choice');
}

// ── results tick only accepted for the active overlay at gen ≥ local ───────────
{
  let v = initialVoteState();
  v = applyVoteChanged(v, null, poll('p1', 2), undefined);
  // A tick for a DIFFERENT overlay id is ignored.
  ok(applyVoteResults(v, poll('p1', 2), results('other', 2, { a: 5 })) === v, 'results for another overlay ignored');
  // A tick for an OLDER gen is ignored.
  ok(applyVoteResults(v, poll('p1', 2), results('p1', 1, { a: 5 })) === v, 'results for an older gen ignored');
  // A matching tick (gen ≥ local) is accepted.
  v = applyVoteResults(v, poll('p1', 2), results('p1', 2, { a: 3, b: 1 }));
  eq(v.results?.tallies, { a: 3, b: 1 }, 'matching results tick adopted');
}

// ── deriveVoteView: first vote is +1; re-vote MOVES the count (old−1/new+1) ─────
{
  const noop = () => {};
  // First vote, no server results yet → optimistic +1, total 1.
  let v = initialVoteState();
  v = applyVoteChanged(v, null, poll('p1'), undefined);
  v = applyOptimisticVote(v, 'a');
  let view = deriveVoteView(v, noop);
  ok(view.voted === true, 'deriveVoteView: voted true after a tap');
  eq(view.mine, 'a', 'deriveVoteView: mine reflects the optimistic choice');
  eq(view.tallies, { a: 1 }, 'first vote → +1 on the choice');
  eq(view.total, 1, 'first vote → total 1');

  // Server confirms `mine=a` + tallies {a:1}; then the viewer RE-VOTES to b.
  v = applyVoteChanged(v, poll('p1'), poll('p1'), 'a');
  v = applyVoteResults(v, poll('p1'), results('p1', 1, { a: 1 }));
  v = applyOptimisticVote(v, 'b');
  view = deriveVoteView(v, noop);
  eq(view.tallies, { a: 0, b: 1 }, 're-vote MOVES the count (a−1, b+1) — never both-zero');
  eq(view.total, 1, 're-vote keeps the total unchanged');
  // Parity with useLivestreamSync: `mine = myChoice ?? optimisticChoice`, so during a
  // re-vote `mine` stays the SERVER-confirmed 'a' until the server acks the new 'b'
  // (the bar already moved via the optimistic fold). The server ack then flips it.
  eq(view.mine, 'a', 're-vote: mine stays the server-confirmed choice until the new vote acks');
  // After the server confirms `mine=b`, the optimistic layer clears and mine is 'b'.
  v = applyVoteChanged(v, poll('p1'), poll('p1'), 'b');
  view = deriveVoteView(v, noop);
  eq(view.mine, 'b', 're-vote: mine flips to the new choice once the server confirms it');
}

// ════════════════════ DOC TAKEOVER FOLD ════════════════════
// Build a converged ViewerState via the real reducers (the source's output) so the
// reconcile runs against authentic state.
const sceneA: LiveScene = {
  id: 'A',
  name: 'A',
  items: [{ id: 'a-doc', type: 'doc', rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0, fit: 'contain' }],
};
const sceneB: LiveScene = {
  id: 'B',
  name: 'B',
  items: [{ id: 'b-doc', type: 'doc', rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0, fit: 'contain' }],
};
function vsWith(scene: LiveScene, d: OverlayInstance | null): ViewerState {
  const m: LiveSyncMsg = { t: 'live.sync', v: 1, sceneId: scene.id, scene, doc: d };
  return applyLiveSync(initialViewerState(), m);
}

// ── following: a doc update applies (viewer mirrors the streamer) ───────────────
{
  const vsA = vsWith(sceneA, doc('d1', 0));
  const r = reconcileDocTakeover(initialDocTakeover(), undefined, vsA, { doc: null, presenter: null });
  eq(r.presented.doc?.id, 'd1', 'following + first snapshot → present the streamer doc');
  ok(!isTakenOver(r.takeover), 'following stays follow on a doc update');

  // A doc-only page flip (same scene) still applies while following.
  const vsA2 = vsWith(sceneA, doc('d1', 3));
  const r2 = reconcileDocTakeover(r.takeover, sceneIdKey(vsA), vsA2, r.presented);
  eq((r2.presented.doc?.payload as { page?: number }).page, 3, 'following: a page flip applies');
}

// ── taken over: the streamer's doc update is DEFERRED (held doc presented) ──────
{
  const vsA = vsWith(sceneA, doc('d1', 0));
  const held: PresentedDoc = { doc: doc('d1', 0), presenter: null };
  // Viewer takes over.
  const taken = takeOverDoc(initialDocTakeover());
  // Streamer flips to page 5 while taken over → DEFERRED.
  const vsA2 = vsWith(sceneA, doc('d1', 5));
  const r = reconcileDocTakeover(taken, sceneIdKey(vsA), vsA2, held);
  ok(isTakenOver(r.takeover), 'still taken over after a deferred doc update');
  eq((r.presented.doc?.payload as { page?: number }).page, 0, 'taken over: the streamer page flip is DEFERRED (held page 0 shown)');
  // The streamer target is buffered for the eventual resync.
  eq(r.takeover.pending?.page, 5, 'taken over: the streamer target is buffered into pending');
}

// ── scene change is ABSOLUTE: ends takeover, viewer follows immediately ─────────
{
  const vsA = vsWith(sceneA, doc('d1', 0));
  const taken = takeOverDoc(initialDocTakeover());
  const held: PresentedDoc = { doc: doc('d1', 0), presenter: null };
  // The streamer switches to scene B while the viewer is taken over.
  const vsB = vsWith(sceneB, doc('d2', 0));
  const r = reconcileDocTakeover(taken, sceneIdKey(vsA), vsB, held);
  ok(!isTakenOver(r.takeover), 'scene change ENDS takeover (absolute)');
  eq(r.presented.doc?.id, 'd2', 'scene change → present the streamer doc of the new scene');
}

// ── scene fold parity: applySceneSync drives the rendered layer the hook paints ─
{
  // The hook's `rendered`/`renderOverlays`/`hasSceneSync` come straight off the
  // converged ViewerState — verify the scene fold the source performs is the one the
  // legacy reducer performs (the hook adds no scene logic of its own).
  const renderedA = buildRenderedScene(sceneA, 1, () => null);
  const vs = applySceneSync(initialViewerState(), renderedA);
  eq(vs.rendered.sceneId, 'A', 'applySceneSync sets the rendered scene id (hook reads this verbatim)');
  // A stale (lower-nonce) snapshot is ignored — the hook can never regress a scene.
  const stale = applySceneSync(vs, { sceneId: 'OLD', nonce: 0, overlays: [] });
  ok(stale === vs, 'a stale scene snapshot is ignored (by ref) — no regression');
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${passed} assertions passed`);
