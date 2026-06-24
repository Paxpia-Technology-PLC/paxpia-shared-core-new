// Unit tests for the lifted @paxpia/core/teaching domain (RECOVER-PREMIUM-MIGRATION
// Wave 2.1) — the session factory + the pure curriculum reducers that back the
// mobile CurriculumManager and (later) the web educator studio + a server endpoint.
//
// Asserts:
//   1. FACTORY — createEmptySession seeds the defaults incl. an EMPTY curriculum +
//      both default checklists (stable ids), and is pure (id/now passed in).
//   2. ADD — addCurriculumItem appends with order = previous length.
//   3. REMOVE — removeCurriculumItem drops by id AND re-numbers the remainder dense.
//   4. REORDER — reorderCurriculum moves + re-numbers; an out-of-range / no-op move
//      returns the SAME ref (cheap to diff).
//   5. UPDATE — updateCurriculumItem patches only the targeted item's fields.
//   6. NORMALIZE — normalizeCurriculum sorts by order then densifies positions
//      (self-heals legacy gaps/dupes).
//
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/teaching.test.ts

import {
  createEmptySession,
  makeChecklist,
} from '../src/teaching/factory.ts';
import {
  addCurriculumItem,
  removeCurriculumItem,
  reorderCurriculum,
  updateCurriculumItem,
  normalizeCurriculum,
} from '../src/teaching/curriculum.ts';
import type { CurriculumItem } from '../src/teaching/types.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

const item = (id: string, order: number, over: Partial<CurriculumItem> = {}): CurriculumItem => ({
  id,
  category: 'academic',
  title: id,
  order,
  ...over,
});

// ── 1. FACTORY ───────────────────────────────────────────────────────────────────
{
  const s = createEmptySession('sess_1', '2026-06-24T00:00:00Z');
  eq(s.id, 'sess_1', 'factory uses the supplied id');
  eq(s.curriculum, [], 'a fresh session starts with an empty curriculum');
  eq(s.status, 'draft', 'a fresh session is a draft');
  eq(s.createdAt, '2026-06-24T00:00:00Z', 'factory uses the supplied now (pure)');
  ok(s.teachingChecklist.length === 5 && s.materialsChecklist.length === 4, 'both default checklists seed');
  eq(makeChecklist(['Alpha', 'Beta']).map((c) => c.id), ['c_0_Alpha', 'c_1_Beta'], 'checklist ids are stable + positional');
}

// ── 2. ADD ───────────────────────────────────────────────────────────────────────
{
  let c: CurriculumItem[] = [];
  c = addCurriculumItem(c, { id: 'a', category: 'academic', title: 'A' });
  c = addCurriculumItem(c, { id: 'b', category: 'skill', title: 'B' });
  eq(c.map((x) => [x.id, x.order]), [['a', 0], ['b', 1]], 'add appends with order = prior length');
}

// ── 3. REMOVE (re-numbers) ─────────────────────────────────────────────────────────
{
  const c = [item('a', 0), item('b', 1), item('c', 2)];
  const out = removeCurriculumItem(c, 'b');
  eq(out.map((x) => [x.id, x.order]), [['a', 0], ['c', 1]], 'remove drops by id + densifies order');
}

// ── 4. REORDER ─────────────────────────────────────────────────────────────────────
{
  const c = [item('a', 0), item('b', 1), item('c', 2)];
  const out = reorderCurriculum(c, 0, 2);
  eq(out.map((x) => [x.id, x.order]), [['b', 0], ['c', 1], ['a', 2]], 'reorder moves + re-numbers');
  ok(reorderCurriculum(c, 1, 1) === c, 'a no-op move returns the SAME ref');
  ok(reorderCurriculum(c, 5, 0) === c, 'an out-of-range move returns the SAME ref');
}

// ── 5. UPDATE ──────────────────────────────────────────────────────────────────────
{
  const c = [item('a', 0, { title: 'A' }), item('b', 1, { title: 'B' })];
  const out = updateCurriculumItem(c, 'b', { title: 'B!', description: 'desc' });
  eq(out.find((x) => x.id === 'b'), { id: 'b', category: 'academic', title: 'B!', order: 1, description: 'desc' }, 'update patches only the target');
  ok(out.find((x) => x.id === 'a') === c[0], 'update leaves other items by ref');
}

// ── 6. NORMALIZE ────────────────────────────────────────────────────────────────────
{
  const messy = [item('c', 9), item('a', 2), item('b', 2)];
  const out = normalizeCurriculum(messy);
  eq(out.map((x) => [x.id, x.order]), [['a', 0], ['b', 1], ['c', 2]], 'normalize sorts by order then densifies');
}

// ── report ─────────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`teaching: ${passed} assertions passed`);
