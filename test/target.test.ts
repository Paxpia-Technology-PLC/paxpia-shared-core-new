// Unit tests for the overlay-target RESOLUTION rules + per-scene assignment model.
//
// No test framework is installed in this package, so this file ships a tiny inline
// assert harness and runs under Node's native TS type-stripping:
//     node --experimental-strip-types test/target.test.ts
// (wired as `npm test`). It exits non-zero on the first failure so it's CI-able
// without adding a dependency. Lives OUTSIDE src/ so the tsc build never emits it.

import {
  resolveOverlayTarget,
  markInteracted,
  itemTypeForKind,
  sceneSlots,
  assignToSlot,
  clearSlotAssignment,
  slotAssignment,
  type OverlaySlot,
  type SceneAssignments,
} from '../src/overlays/target.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

// Helpers to build slots.
const docSlot = (id: string, z: number, filled = false): OverlaySlot => ({ id, type: 'doc', z, filled });
const ovSlot = (id: string, z: number, filled = false): OverlaySlot => ({ id, type: 'overlay', z, filled });

// ── kind → item type mapping ─────────────────────────────────────────────────
eq(itemTypeForKind('doc'), 'doc', 'doc kind → doc item');
eq(itemTypeForKind('poll'), 'overlay', 'poll kind → overlay item');
eq(itemTypeForKind('quiz'), 'overlay', 'quiz kind → overlay item');
eq(itemTypeForKind('vote-button'), 'overlay', 'vote kind → overlay item');

// ── Rule 2: NO matching slot → NO-OP (null target, never create) ──────────────
eq(
  resolveOverlayTarget([ovSlot('o1', 0)], 'doc', undefined),
  { targetId: null, reason: 'no-matching-slot' },
  'no doc slot present → no-op for a doc material',
);
eq(
  resolveOverlayTarget([docSlot('d1', 0)], 'poll', undefined),
  { targetId: null, reason: 'no-matching-slot' },
  'no overlay slot present → no-op for a poll (the reported bug)',
);
eq(
  resolveOverlayTarget([], 'doc', undefined),
  { targetId: null, reason: 'no-matching-slot' },
  'empty scene → no-op',
);

// All matching slots FILLED → still no-op (never clobber an existing fill).
eq(
  resolveOverlayTarget([docSlot('d1', 0, true)], 'doc', undefined),
  { targetId: null, reason: 'no-matching-slot' },
  'only matching slot is filled → no-op',
);

// ── Rule 3: exactly one empty matching slot → use it ──────────────────────────
eq(
  resolveOverlayTarget([docSlot('d1', 0), ovSlot('o1', 1)], 'doc', undefined),
  { targetId: 'd1' },
  'one empty doc slot → that slot',
);
eq(
  resolveOverlayTarget([docSlot('d1', 0), ovSlot('o1', 1)], 'poll', undefined),
  { targetId: 'o1' },
  'one empty overlay slot → that slot (poll never lands in a doc slot)',
);
// A filled doc + an empty doc → the empty one.
eq(
  resolveOverlayTarget([docSlot('d1', 0, true), docSlot('d2', 1)], 'doc', undefined),
  { targetId: 'd2' },
  'one filled + one empty doc → the empty one',
);

// ── Rule 4: multiple empty matching slots → most-recently-interacted ──────────
const twoDocs = [docSlot('d1', 0), docSlot('d2', 1)];
eq(
  resolveOverlayTarget(twoDocs, 'doc', { doc: 'd2' }),
  { targetId: 'd2' },
  'two empty docs, last-interacted d2 → d2',
);
eq(
  resolveOverlayTarget(twoDocs, 'doc', { doc: 'd1' }),
  { targetId: 'd1' },
  'two empty docs, last-interacted d1 → d1',
);
// Last-interacted points at a now-FILLED/absent slot → fall back to draw order.
eq(
  resolveOverlayTarget([docSlot('d1', 5), docSlot('d2', 2)], 'doc', { doc: 'gone' }),
  { targetId: 'd2' },
  'two empty docs, stale last-interacted → lowest-z (d2 @ z=2)',
);
// last-interacted for the OTHER type must not cross over.
eq(
  resolveOverlayTarget([ovSlot('o1', 3), ovSlot('o2', 1)], 'poll', { doc: 'd1' }),
  { targetId: 'o2' },
  'overlay resolution ignores doc last-interacted → lowest-z overlay',
);

// markInteracted updates the right axis without disturbing the other.
eq(markInteracted({ doc: 'd1' }, 'overlay', 'o9'), { doc: 'd1', overlay: 'o9' }, 'markInteracted keeps doc, sets overlay');
eq(markInteracted(undefined, 'doc', 'd5'), { doc: 'd5' }, 'markInteracted from empty');

// ── Rule 6: SCENE-SCOPED — resolver only ever sees the passed scene's slots ───
// (Construction guarantee, exercised via sceneSlots: a slot from another scene's
//  items can never enter the candidate set because the caller passes one scene.)
const sceneAItems = [
  { id: 'a-doc', type: 'doc' as const, z: 0 },
  { id: 'a-ov', type: 'overlay' as const, z: 1 },
  { id: 'a-cam', type: 'camera' as const, z: 2 },
];
const sceneBItems = [{ id: 'b-doc', type: 'doc' as const, z: 0 }];
let assigns: SceneAssignments = {};
// Fill scene B's doc slot — it must NOT affect scene A resolution.
assigns = assignToSlot(assigns, 'sceneB', 'b-doc', { kind: 'doc', ref: 'matB' });
const aSlots = sceneSlots('sceneA', sceneAItems, assigns);
eq(aSlots.length, 2, 'sceneSlots drops non-overlay/doc items (camera excluded)');
eq(
  resolveOverlayTarget(aSlots, 'doc', undefined),
  { targetId: 'a-doc' },
  'scene-scoped: sceneA doc resolves to a-doc, never b-doc from another scene',
);

// ── Assignment model: assign / read / clear, fill state reflected by sceneSlots ─
let a2: SceneAssignments = {};
a2 = assignToSlot(a2, 'sceneA', 'a-doc', { kind: 'doc', ref: 'mat1' });
eq(slotAssignment(a2, 'sceneA', 'a-doc')?.ref, 'mat1', 'assignToSlot then read back ref');
// Now a-doc is filled → a doc click resolves to NO-OP (the only doc slot is full).
eq(
  resolveOverlayTarget(sceneSlots('sceneA', sceneAItems, a2), 'doc', undefined),
  { targetId: null, reason: 'no-matching-slot' },
  'after assigning a-doc, a doc click no-ops (sole slot filled)',
);
// Switching scenes must not lose the assignment: re-reading sceneA still has it.
eq(slotAssignment(a2, 'sceneA', 'a-doc')?.ref, 'mat1', 'assignment persists across scene reads');
// Clear it → slot empty again, resolves back to a-doc.
a2 = clearSlotAssignment(a2, 'sceneA', 'a-doc');
eq(slotAssignment(a2, 'sceneA', 'a-doc'), undefined, 'clearSlotAssignment removes the fill');
eq(Object.keys(a2).length, 0, 'clearing the last fill drops the scene key (tidy blob)');
eq(
  resolveOverlayTarget(sceneSlots('sceneA', sceneAItems, a2), 'doc', undefined),
  { targetId: 'a-doc' },
  'after clearing, a-doc is targetable again',
);

// Multiple scenes coexist independently (no bleed).
let a3: SceneAssignments = {};
a3 = assignToSlot(a3, 's1', 'i1', { kind: 'poll', ref: 'p1' });
a3 = assignToSlot(a3, 's2', 'i1', { kind: 'doc', ref: 'd1' });
eq(slotAssignment(a3, 's1', 'i1')?.kind, 'poll', 's1 keeps its poll');
eq(slotAssignment(a3, 's2', 'i1')?.kind, 'doc', 's2 keeps its doc (same itemId, different scene)');

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`ok — ${passed} assertions passed`);
