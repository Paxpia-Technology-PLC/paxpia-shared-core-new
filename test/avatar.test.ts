// Unit tests for the deterministic avatar resolver — the shared fix for the
// recurring "pfps don't render" gap (the backend ships an empty `avatar_url`
// even though the object exists at `…/videos/avatars/<id>.png`).
//
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/avatar.test.ts

import {
  resolveAvatarUrl,
  avatarUrlCandidates,
  avatarObjectUrl,
} from '../src/media/avatar.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}

const CDN = 'https://cdn.example/videos';
const UID = 'f01e186a-261d-4f33-b1ee-4fc9bfa3a861';

// ── explicit avatar_url always wins ───────────────────────────────────────────
ok(
  resolveAvatarUrl({ userId: UID, avatarUrl: 'https://x/y.jpg' }, CDN) === 'https://x/y.jpg',
  'explicit avatar_url wins over the deterministic path',
);

// ── empty avatar_url → deterministic png object path ──────────────────────────
ok(
  resolveAvatarUrl({ userId: UID, avatarUrl: '' }, CDN) === `${CDN}/avatars/${UID}.png`,
  'empty avatar_url falls back to <base>/avatars/<id>.png',
);
ok(
  resolveAvatarUrl({ userId: UID, avatarUrl: '   ' }, CDN) === `${CDN}/avatars/${UID}.png`,
  'whitespace avatar_url is treated as empty',
);

// ── no userId AND no url → '' (caller renders initials) ───────────────────────
ok(resolveAvatarUrl({ userId: '', avatarUrl: '' }, CDN) === '', 'no id + no url → empty string');
ok(resolveAvatarUrl({ avatarUrl: null, userId: null }, CDN) === '', 'null id + null url → empty string');

// ── trailing slash on the base is normalized (no double slash) ────────────────
ok(
  resolveAvatarUrl({ userId: UID }, `${CDN}/`) === `${CDN}/avatars/${UID}.png`,
  'trailing slash on bucketBase is trimmed',
);

// ── candidate chain: explicit → png → jpg, deduped ────────────────────────────
{
  const c = avatarUrlCandidates({ userId: UID, avatarUrl: '' }, CDN);
  ok(c.length === 2 && c[0].endsWith('.png') && c[1].endsWith('.jpg'), 'empty url → [png, jpg] candidates');
}
{
  const c = avatarUrlCandidates({ userId: UID, avatarUrl: `${CDN}/avatars/${UID}.png` }, CDN);
  // explicit equals the png candidate → deduped to [png, jpg]
  ok(c.length === 2, 'explicit equal to a candidate is deduped');
}
{
  const c = avatarUrlCandidates({ userId: UID, avatarUrl: 'https://other/x.webp' }, CDN);
  ok(c.length === 3 && c[0] === 'https://other/x.webp', 'distinct explicit url leads, then png, jpg');
}
ok(avatarUrlCandidates({ userId: '', avatarUrl: '' }, CDN).length === 0, 'no id + no url → no candidates');

// ── object url builder ────────────────────────────────────────────────────────
ok(avatarObjectUrl(CDN, UID, 'jpg') === `${CDN}/avatars/${UID}.jpg`, 'avatarObjectUrl builds the keyed path');

if (failures.length) {
  console.error(`avatar.test FAILED (${passed} passed):\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`avatar.test OK (${passed} assertions)`);
