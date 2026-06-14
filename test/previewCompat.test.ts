// Unit tests for the studio PREVIEW compatibility filter (which saved materials /
// authored overlays can fill a given slot type). Same inline-assert harness as the
// other core tests; run via `node --experimental-strip-types test/previewCompat.test.ts`.

import {
  isDocPreviewCompatible,
  isOverlayPreviewCompatible,
  compatibleForSlot,
} from '../src/overlays/previewCompat.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

// ── single-item predicates ───────────────────────────────────────────────────
ok(isDocPreviewCompatible({ kind: 'renderable', mime: 'application/pdf' }), 'renderable pdf fits doc');
ok(isDocPreviewCompatible({ kind: 'renderable', mime: 'image/png' }), 'renderable image fits doc');
ok(!isDocPreviewCompatible({ kind: 'supplementary', mime: 'application/zip' }), 'supplementary excluded from doc');

ok(isOverlayPreviewCompatible({ kind: 'poll' }), 'poll fits overlay');
ok(isOverlayPreviewCompatible({ kind: 'quiz' }), 'quiz fits overlay');
ok(isOverlayPreviewCompatible({ kind: 'vote-button' }), 'vote fits overlay');
ok(!isOverlayPreviewCompatible({ kind: 'doc' }), 'doc kind not a participation overlay');
ok(!isOverlayPreviewCompatible({ kind: 'gift' }), 'gift not a participation overlay');

// ── list filter: doc slot keeps only renderables ─────────────────────────────
const materials = [
  { id: 'a', kind: 'renderable' as const, mime: 'application/pdf', filename: 'a.pdf' },
  { id: 'b', kind: 'supplementary' as const, mime: 'application/zip', filename: 'b.zip' },
  { id: 'c', kind: 'renderable' as const, mime: 'image/png', filename: 'c.png' },
];
const docFit = compatibleForSlot('doc', materials, {
  kind: 'doc',
  material: (m) => ({ kind: m.kind, mime: m.mime, filename: m.filename }),
});
eq(docFit.map((m) => m.id), ['a', 'c'], 'doc slot filters to renderables, order preserved');

// An overlay-pick against a doc slot yields nothing (wrong pick discriminator).
eq(
  compatibleForSlot('doc', [{ kind: 'poll' as const }], { kind: 'overlay', overlay: (o) => ({ kind: o.kind }) }),
  [],
  'overlay pick against doc slot → empty',
);

// ── list filter: overlay slot keeps only participation overlays ──────────────
const overlays = [
  { kind: 'poll' as const, title: 'P' },
  { kind: 'doc' as const, title: 'D' },
  { kind: 'quiz' as const, title: 'Q' },
];
const ovFit = compatibleForSlot('overlay', overlays, { kind: 'overlay', overlay: (o) => ({ kind: o.kind }) });
eq(ovFit.map((o) => o.title), ['P', 'Q'], 'overlay slot filters out doc, keeps poll+quiz');

if (failures.length) {
  console.error(`previewCompat: ${failures.length} FAILED:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`ok — ${passed} assertions passed`);
