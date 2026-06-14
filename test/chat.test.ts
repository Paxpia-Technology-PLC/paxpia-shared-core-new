// Unit tests for the shared LIVE-CHAT + LIVE-VIEWERS model (the P0/P1 fan-out
// pieces): the ring-buffer chat reducer + cap + dedupe + encode/decode, and the
// viewer derivation / newest-first-with-gifters-pinned ordering / deposit-bump /
// stage-scaffold folds.
//
// Runs under Node's native TS type-stripping (same harness as scene.test.ts):
//     node --experimental-strip-types test/chat.test.ts

import {
  emptyChatLog,
  appendComment,
  commentAuthorLabel,
  makeComment,
  makeGift,
  encodeChatMsg,
  decodeChatMsg,
  CHAT_WIRE_VERSION,
  type LiveComment,
  type ChatMsg,
} from '../src/streaming/chat.ts';
import {
  participantToViewer,
  viewerIdFromIdentity,
  isWatcher,
  addViewer,
  removeViewer,
  enrichFromComment,
  applyGift,
  orderViewers,
  viewerLabel,
  applyStageRequest,
  isStageRequest,
  type ViewerMap,
  type StageRequest,
} from '../src/streaming/viewers.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

const comment = (id: string, authorId: string, over: Partial<LiveComment> = {}): LiveComment => ({
  id,
  authorId,
  handle: '',
  displayName: '',
  avatarUrl: '',
  text: 't',
  ts: 1,
  kind: 'comment',
  ...over,
});

// ── chat reducer: append, dedupe, cap ────────────────────────────────────────
{
  let log = emptyChatLog(3);
  log = appendComment(log, comment('a', 'u1'));
  log = appendComment(log, comment('b', 'u2'));
  eq(log.comments.map((c) => c.id), ['a', 'b'], 'append keeps order');

  // dedupe on id (at-least-once redelivery)
  const before = log;
  log = appendComment(log, comment('b', 'u2'));
  ok(log === before, 'duplicate id is dropped (same ref)');

  // cap to last N (ring buffer)
  log = appendComment(log, comment('c', 'u3'));
  log = appendComment(log, comment('d', 'u4'));
  eq(log.comments.map((c) => c.id), ['b', 'c', 'd'], 'ring-buffer caps to last 3');
}

// ── author label never shows a UUID ──────────────────────────────────────────
{
  eq(commentAuthorLabel({ displayName: 'Noel', handle: 'noel' }), 'Noel', 'label prefers displayName');
  eq(commentAuthorLabel({ displayName: '', handle: 'noel' }), '@noel', 'label falls back to @handle');
  eq(commentAuthorLabel({ displayName: '', handle: '' }), 'Guest', 'label falls back to Guest (no UUID)');
}

// ── makeComment / makeGift ───────────────────────────────────────────────────
{
  const c = makeComment({ id: 'u1', handle: 'noel', displayName: 'Noel' }, '  hi  ');
  ok(!!c && c.text === 'hi' && c.kind === 'comment' && c.authorId === 'u1', 'makeComment trims + stamps author');
  ok(makeComment({ id: 'u1' }, '   ') === null, 'makeComment rejects empty body');
  const g = makeGift({ id: 'u1', handle: 'noel' }, 'Rose');
  ok(g.kind === 'gift' && g.giftLabel === 'Rose' && g.text === 'sent Rose', 'makeGift builds a gift row');
}

// ── wire encode/decode round-trips; foreign bytes decode to null ─────────────
{
  const msg: ChatMsg = { t: 'chat.msg', v: CHAT_WIRE_VERSION, comment: comment('a', 'u1', { text: 'héllo' }) };
  const round = decodeChatMsg(encodeChatMsg(msg));
  eq(round, msg, 'chat msg round-trips through encode/decode (utf-8)');
  ok(decodeChatMsg(new TextEncoder().encode('{"t":"scene.sync"}')) === null, 'foreign envelope decodes to null');
  ok(decodeChatMsg(new TextEncoder().encode('not json')) === null, 'garbage decodes to null');
}

// ── viewers: identity → stable user id ───────────────────────────────────────
{
  eq(viewerIdFromIdentity('uuid-1::view::room::42'), 'uuid-1', 'user id is the first :: segment');
  eq(viewerIdFromIdentity('plain'), 'plain', 'no separator → whole identity');
  ok(isWatcher({ identity: 'u::view::r::1' }), 'view identity is a watcher');
  ok(!isWatcher({ identity: 'u-publisher' }), 'publisher identity is NOT a watcher');
}

// ── viewers: neutral guest, never a raw UUID ─────────────────────────────────
{
  const v = participantToViewer({ identity: 'uuid-guest::view::r::1' }, 100);
  ok(v.isGuest && v.handle === '' && v.displayName === '', 'no metadata → neutral guest');
  eq(viewerLabel(v), 'Guest', 'guest renders "Guest" not the UUID');

  // metadata-stamped profile enriches
  const m = participantToViewer(
    { identity: 'uuid-2::view::r::1', metadata: JSON.stringify({ username: 'noel', displayName: 'Noel', avatarUrl: 'a' }) },
    100,
  );
  ok(!m.isGuest && m.handle === 'noel' && m.displayName === 'Noel', 'metadata profile enriches viewer');
}

// ── viewers: add/remove + reconnect keeps earliest joinedAt + enrichment ─────
{
  let map: ViewerMap = {};
  map = addViewer(map, participantToViewer({ identity: 'u1::view::r::1' }, 100));
  map = enrichFromComment(map, { authorId: 'u1', handle: 'noel', displayName: 'Noel', avatarUrl: 'a', ts: 150 });
  ok(!map['u1'].isGuest && map['u1'].displayName === 'Noel', 'comment enriches a guest viewer');

  // reconnect under a fresh nonce → same user id, keep earliest join + profile
  map = addViewer(map, participantToViewer({ identity: 'u1::view::r::999' }, 200));
  eq(map['u1'].joinedAt, 100, 'reconnect keeps earliest joinedAt');
  ok(map['u1'].displayName === 'Noel', 'reconnect keeps prior enrichment');

  map = removeViewer(map, 'u1');
  ok(!('u1' in map), 'removeViewer drops by user id');
}

// ── ordering: newest-joined first, gifters pinned to the very top ────────────
{
  let map: ViewerMap = {};
  map = addViewer(map, participantToViewer({ identity: 'a::view::r::1' }, 100));
  map = addViewer(map, participantToViewer({ identity: 'b::view::r::1' }, 200));
  map = addViewer(map, participantToViewer({ identity: 'c::view::r::1' }, 300));
  eq(orderViewers(map).map((v) => v.id), ['c', 'b', 'a'], 'newest-joined first');

  // a gifts → pinned to the very top despite being the oldest join
  map = applyGift(map, { authorId: 'a', handle: 'a', displayName: 'A', avatarUrl: '', ts: 500 });
  eq(orderViewers(map).map((v) => v.id), ['a', 'c', 'b'], 'a recent gifter pins to top');

  // b gifts later → b above a (more recent gift), both above non-gifters
  map = applyGift(map, { authorId: 'b', handle: 'b', displayName: 'B', avatarUrl: '', ts: 600 });
  eq(orderViewers(map).map((v) => v.id), ['b', 'a', 'c'], 'most-recent gifter on top');
  ok(map['a'].lastGiftTs === 500 && map['b'].lastGiftTs === 600, 'gift sets lastGiftTs');
}

// ── stage scaffold: flags fold; promote is a no-op; unknown viewer ignored ───
{
  let map: ViewerMap = { u1: participantToViewer({ identity: 'u1::view::r::1' }, 100) };
  const req = (action: StageRequest['action'], viewerId = 'u1'): StageRequest => ({
    t: 'stage.request',
    v: 1,
    action,
    viewerId,
    by: 'u1',
    ts: 1,
  });
  ok(isStageRequest(req('raise_hand')), 'isStageRequest recognizes the envelope');
  map = applyStageRequest(map, req('raise_hand'));
  ok(map['u1'].raisedHand === true, 'raise_hand sets the flag');
  map = applyStageRequest(map, req('invite'));
  ok(map['u1'].invited === true, 'invite sets the flag');
  map = applyStageRequest(map, req('opt_in_av'));
  ok(map['u1'].stageOptIn === true, 'opt_in_av sets the flag');

  const before = map;
  map = applyStageRequest(map, req('promote'));
  ok(map === before, 'promote is a no-op (scaffold)');
  ok(applyStageRequest(map, req('invite', 'ghost')) === map, 'request about unknown viewer is ignored');
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`chat/viewers: ${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`chat/viewers: ${passed} passed`);
