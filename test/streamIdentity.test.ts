// Unit tests for the STREAM ROOM IDENTITY + REDIRECT model (plan §1h streaming):
// canonical entity-derived room names (`live:{id}`), the id/username/slug alias
// resolver, and the old-room → new-room redirect signal (streamer restarted under
// the same entity). Keeps `findActiveRoomByUsername` regression-covered.
//
// Runs under Node's native TS type-stripping (same harness as chat.test.ts):
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/streamIdentity.test.ts

import {
  roomNameForEntity,
  isCanonicalRoomName,
  entityIdFromRoomName,
  resolveRoomAlias,
  findActiveRoomByUsername,
  normalizeUsername,
  LIVE_ROOM_PREFIX,
} from '../src/streaming/identity.ts';
import {
  computeRoomRedirect,
  shouldCheckRedirect,
  type ActiveRoomRef,
} from '../src/streaming/connection.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

// ── roomNameForEntity: canonical live:{id}, trims, guards empty ───────────────
{
  eq(roomNameForEntity('creator-42'), 'live:creator-42', 'builds live:{entityId}');
  eq(roomNameForEntity('  creator-42  '), 'live:creator-42', 'trims the entity id');
  eq(roomNameForEntity(''), '', 'empty id → empty (no bare "live:")');
  eq(roomNameForEntity(null), '', 'null id → empty');
  eq(LIVE_ROOM_PREFIX, 'live:', 'prefix constant is live:');
}

// ── isCanonicalRoomName / entityIdFromRoomName ────────────────────────────────
{
  ok(isCanonicalRoomName('live:abc'), 'live:abc is canonical');
  ok(!isCanonicalRoomName('live-abc-123'), 'legacy live-abc-123 is NOT canonical');
  ok(!isCanonicalRoomName('live:'), 'bare live: is NOT canonical (no entity)');
  ok(!isCanonicalRoomName(undefined), 'undefined is not canonical');
  eq(entityIdFromRoomName('live:creator-42'), 'creator-42', 'extracts entity id');
  eq(entityIdFromRoomName('live-legacy-1'), '', 'legacy name yields no entity id');
  eq(entityIdFromRoomName(roomNameForEntity('E')), 'E', 'round-trips build → extract');
}

// ── resolveRoomAlias: id > slug > username precedence ─────────────────────────
{
  eq(resolveRoomAlias({ id: 'E1' }), { kind: 'entity', key: 'live:E1' }, 'id resolves to canonical entity key');
  eq(resolveRoomAlias({ slug: 'jazz-101' }), { kind: 'slug', key: 'jazz-101' }, 'slug resolves to slug key');
  eq(resolveRoomAlias({ username: '@Noel' }), { kind: 'username', key: 'noel' }, 'username normalizes to a handle key');
  // precedence: id wins over everything
  eq(resolveRoomAlias({ id: 'E1', username: 'noel', slug: 'jazz' }), { kind: 'entity', key: 'live:E1' }, 'id wins over username+slug');
  // slug is more specific than a bare username (the /:username/:slug route)
  eq(resolveRoomAlias({ username: 'noel', slug: 'jazz' }), { kind: 'slug', key: 'jazz' }, 'slug wins over bare username');
  eq(resolveRoomAlias({}), { kind: 'none', key: '' }, 'nothing addressable → none');
  eq(resolveRoomAlias({ id: '  ', username: '  ' }), { kind: 'none', key: '' }, 'whitespace-only → none');
}

// ── findActiveRoomByUsername: unchanged regression ────────────────────────────
{
  const rooms = [{ u: 'alice' }, { u: 'bob' }];
  const uOf = (r: { u: string }) => r.u;
  eq(findActiveRoomByUsername(rooms, '@Bob', uOf), { u: 'bob' }, 'resolves @Bob case-insensitively');
  ok(findActiveRoomByUsername(rooms, 'carol', uOf) === null, 'unknown handle → null');
  ok(findActiveRoomByUsername(rooms, '', uOf) === null, 'blank handle → null');
  eq(normalizeUsername('@ALICE '), 'alice', 'normalizeUsername strips @ + lowercases + trims');
}

// ── computeRoomRedirect: migrate to a NEW room under the same entity ──────────
{
  const listing: ActiveRoomRef[] = [
    { roomName: 'live:E1', entityId: 'E1' }, // E1 is live again (canonical)
    { roomName: 'live-E9-222', entityId: 'E9' },
  ];
  // Viewer was on the OLD ephemeral room for E1 → migrate to the new canonical room.
  eq(
    computeRoomRedirect({ currentRoomName: 'live-E1-111', entityId: 'E1' }, listing),
    { redirect: true, toRoomName: 'live:E1', reason: 'new-room' },
    'redirects to the entity\'s new room name',
  );
  // Same room name → transient drop, let the SDK reconnect (no churn).
  eq(
    computeRoomRedirect({ currentRoomName: 'live:E1', entityId: 'E1' }, listing),
    { redirect: false, reason: 'same-room' },
    'same room name → no redirect (SDK reconnects)',
  );
  // Entity not in the listing → genuinely offline → hold unavailable (null-stream).
  eq(
    computeRoomRedirect({ currentRoomName: 'live-E5-1', entityId: 'E5' }, listing),
    { redirect: false, reason: 'no-active' },
    'entity offline → no redirect, UI holds unavailable',
  );
  // No entity known → cannot redirect.
  eq(
    computeRoomRedirect({ currentRoomName: 'x', entityId: '' }, listing),
    { redirect: false, reason: 'no-entity' },
    'no entity → cannot redirect',
  );
  eq(computeRoomRedirect(null, listing), { redirect: false, reason: 'no-entity' }, 'null viewer ref → no-entity');
}

// ── shouldCheckRedirect: only in the terminal/offline states ──────────────────
{
  ok(shouldCheckRedirect('unavailable'), 'check redirect when unavailable');
  ok(shouldCheckRedirect('offline'), 'check redirect when offline');
  ok(!shouldCheckRedirect('live'), 'no redirect check while live');
  ok(!shouldCheckRedirect('connecting'), 'no redirect check while connecting');
  ok(!shouldCheckRedirect('reconnecting'), 'no redirect check while the SDK is reconnecting');
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`streamIdentity: ${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`streamIdentity: ${passed} passed`);
