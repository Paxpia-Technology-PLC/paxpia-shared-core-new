// Unit tests for the doc-viewer LOCAL TAKEOVER state machine — specifically the
// P1.4 requirement: while taken over the viewer must CONTINUOUSLY BUFFER the
// streamer's latest doc target (never discard it), and a resync must fold that
// buffered latest AT ONCE. Same inline assert harness as the sibling tests; runs
// under Node's native TS type-stripping:
//     node --experimental-strip-types test/docTakeover.test.ts
// Exits non-zero on the first failure so it's CI-able without a test dependency.

import {
  initialDocTakeover,
  isTakenOver,
  takeOverDoc,
  onStreamerDocUpdate,
  onStreamerSceneChange,
  resyncDoc,
  type DocTakeoverState,
  type PendingDocTarget,
} from '../src/streaming/docTakeover.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

const tgt = (docId: string, page: number): PendingDocTarget => ({
  docId,
  page,
  presenter: { page, zoom: 2, panX: 10, panY: -5 },
});

// ── Fresh state: following, nothing pending ──────────────────────────────────
const init = initialDocTakeover();
ok(!isTakenOver(init), 'fresh state is following');
eq(init.pending, null, 'fresh state has no pending');

// ── Following: a streamer doc update APPLIES immediately, nothing buffered ────
{
  const { state, apply } = onStreamerDocUpdate(init, tgt('docA', 1));
  ok(apply, 'following → apply now');
  eq(state.pending, null, 'following → nothing buffered');
}

// ── Takeover BUFFERS every streamer update (the LATEST wins), never applies ───
let s: DocTakeoverState = takeOverDoc(init);
ok(isTakenOver(s), 'takeOverDoc → taken over');
eq(s.pending, null, 'taking over clears any stale pending');

{
  const r1 = onStreamerDocUpdate(s, tgt('docA', 2));
  ok(!r1.apply, 'taken over → does NOT apply (defers)');
  eq(r1.state.pending, tgt('docA', 2), 'taken over → buffers the first update');
  s = r1.state;
}
{
  // A SECOND update while still taken over must REPLACE the buffer with the latest
  // (continuously buffer the newest, never discard by staying on the old one).
  const r2 = onStreamerDocUpdate(s, tgt('docA', 5));
  ok(!r2.apply, 'taken over → still defers the second update');
  eq(r2.state.pending, tgt('docA', 5), 'taken over → buffer holds the LATEST (page 5, not 2)');
  s = r2.state;
}

// ── Resync folds the BUFFERED LATEST at once (snapTo = newest pending) ────────
{
  const { state, snapTo } = resyncDoc(s);
  ok(!isTakenOver(state), 'resync → back to following');
  eq(state.pending, null, 'resync → buffer cleared');
  eq(snapTo, tgt('docA', 5), 'resync → snaps to the BUFFERED LATEST (no waiting for a fresh push)');
}

// ── A SCENE change is absolute: ends takeover, hands back the buffered target ─
{
  let s2 = takeOverDoc(init);
  s2 = onStreamerDocUpdate(s2, tgt('docB', 3)).state;
  const { state, snapTo } = onStreamerSceneChange(s2);
  ok(!isTakenOver(state), 'scene change ends takeover (absolute)');
  eq(snapTo, tgt('docB', 3), 'scene change snaps to the buffered target as it follows');
}

// Resync while FOLLOWING (nothing buffered) → no target to jump to (caller keeps
// the streamer's live doc it already holds).
{
  const { snapTo } = resyncDoc(initialDocTakeover());
  eq(snapTo, null, 'resync while following → no buffered target');
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${passed} assertions passed`);
