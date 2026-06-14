// Unit tests for the PREVIEW HOT-SWAP GATE (PreviewSwapGate) — the shared ready-gate
// that prevents the avatar (web) / black (mobile) flash when a feed tile's preview
// version changes. No test framework: tiny inline asserts under Node's TS strip:
//     node --experimental-strip-types test/previewSwap.test.ts

import { PreviewSwapGate, type SwapAction } from '../src/streaming/preview.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

// First url: preload into the hidden slot (b), nothing visible yet.
{
  const g = new PreviewSwapGate();
  const a = g.request('u1');
  eq(a, { type: 'preload', url: 'u1', into: 'b' } as SwapAction, 'first url preloads into hidden b');
  eq(g.snapshot().visibleUrl, undefined, 'first url: visibleUrl still undefined pre-ready');
  // Decoded frame → swap b to visible.
  eq(g.onReady('b'), { type: 'swap', slot: 'b' } as SwapAction, 'first url swaps to b on ready');
  eq(g.snapshot().visibleUrl, 'u1', 'first url: visibleUrl=u1 after ready');
  eq(g.snapshot().pendingUrl, undefined, 'first url: pendingUrl cleared after ready');
  eq(g.visibleSlot(), 'b', 'visible slot is b');
}

// URL CHANGE: must preload into the OTHER (hidden) slot and NOT swap until ready.
{
  const g = new PreviewSwapGate();
  g.request('u1');
  g.onReady('b'); // u1 visible on b
  const change = g.request('u2');
  eq(change, { type: 'preload', url: 'u2', into: 'a' } as SwapAction, 'change preloads into hidden a');
  // CRITICAL: before ready, visible slot/url are UNCHANGED → the old frame holds,
  // the avatar/black can never show.
  eq(g.visibleSlot(), 'b', 'change: visible slot unchanged before ready (no flash)');
  eq(g.snapshot().visibleUrl, 'u1', 'change: visibleUrl still u1 before ready');
  eq(g.snapshot().pendingUrl, 'u2', 'change: pendingUrl is u2');
  // Decoded → swap.
  eq(g.onReady('a'), { type: 'swap', slot: 'a' } as SwapAction, 'change swaps to a on ready');
  eq(g.snapshot().visibleUrl, 'u2', 'change: visibleUrl=u2 after ready');
}

// Re-request the SAME visible url → idle (no reload, no flicker).
{
  const g = new PreviewSwapGate();
  g.request('u1');
  g.onReady('b');
  eq(g.request('u1'), { type: 'idle' } as SwapAction, 'same url is idle');
}

// Re-request the SAME pending url → idle (don't restart an in-flight preload).
{
  const g = new PreviewSwapGate();
  g.request('u1');
  g.onReady('b');
  g.request('u2'); // pending u2 into a
  eq(g.request('u2'), { type: 'idle' } as SwapAction, 'same pending url is idle');
  eq(g.snapshot().pendingUrl, 'u2', 'pending unchanged on repeat request');
}

// Preload ERROR on a change → drop pending, KEEP the current visible frame.
{
  const g = new PreviewSwapGate();
  g.request('u1');
  g.onReady('b'); // u1 on b
  g.request('u2'); // pending into a
  eq(g.onError('a'), { type: 'idle' } as SwapAction, 'preload error is idle');
  eq(g.visibleSlot(), 'b', 'error: visible slot unchanged');
  eq(g.snapshot().visibleUrl, 'u1', 'error: keeps current visible url (no fallback)');
  eq(g.snapshot().pendingUrl, undefined, 'error: pending dropped');
}

// Stale onReady (slot already visible) → idle, no disturbance.
{
  const g = new PreviewSwapGate();
  g.request('u1');
  g.onReady('b');
  eq(g.onReady('b'), { type: 'idle' } as SwapAction, 'onReady for already-visible slot is idle');
}

// SAME-url refresh path: setVisible moves the visible slot without a transition.
{
  const g = new PreviewSwapGate();
  g.request('u1');
  g.onReady('b'); // u1 on b
  // refresh reloads the hidden slot (a) with u1 and decodes → setVisible(a).
  g.setVisible('a');
  eq(g.visibleSlot(), 'a', 'refresh setVisible moves visible to a');
  eq(g.snapshot().visibleUrl, 'u1', 'refresh keeps visibleUrl=u1');
  eq(g.hidden(), 'b', 'after refresh, hidden is b');
}

if (failures.length) {
  console.error(`previewSwap: ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`previewSwap: all ${passed} assertions passed`);
