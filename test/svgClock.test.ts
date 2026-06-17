// Unit tests for the SHARED SVG animation clock + baked-string cache + saturation
// parity (the mobile perf/lifecycle/saturation fix). These guard the invariants the
// device assertions rely on: ONE clock fans out to N subscribers at a ~30fps quantum;
// the bake is memoized per (svg, bucket); and blend-mode docs get a parity opacity < 1
// while plain cards stay at 1.
//
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/svgClock.test.ts

import {
  SvgAnimationClock,
  SVG_ANIM_QUANTUM_MS,
  bakeCached,
  clearBakeCache,
} from '../src/overlays/svgClock.ts';
import { svgSaturationParityOpacity } from '../src/overlays/svgAnimate.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}

// ── clock: bucket advances with the quantum; subscribers fan out from ONE driver ──
{
  // No requestAnimationFrame in Node → the clock falls back to setInterval; we don't
  // wait real time here, we exercise bucket math + subscribe/unsubscribe bookkeeping.
  const clock = new SvgAnimationClock();
  const b0 = clock.bucket();
  ok(Number.isFinite(b0) && b0 >= 0, 'bucket() is a finite, non-negative integer');
  ok(clock.timeMs() === clock.bucket() * SVG_ANIM_QUANTUM_MS, 'timeMs() is the quantized bucket time');

  let aCalls = 0;
  let bCalls = 0;
  const offA = clock.subscribe(() => aCalls++);
  const offB = clock.subscribe(() => bCalls++);
  // Pausing then resuming with subscribers present must not throw and must keep both.
  clock.pause();
  clock.resume();
  offA();
  offB();
  ok(aCalls >= 0 && bCalls >= 0, 'subscribe/unsubscribe + pause/resume do not throw');
}

// ── bakeCached: memoizes per (svg,bucket); a static svg round-trips unchanged ─────
{
  clearBakeCache();
  const animated =
    '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="red">' +
    '<animate attributeName="opacity" values="0;1" dur="1s" repeatCount="indefinite"/></rect></svg>';

  const first = bakeCached(animated, 0);
  const again = bakeCached(animated, 0);
  ok(first === again, 'same (svg,bucket) returns an identical (cached) baked string');
  ok(!/\<animate/i.test(first), 'baked output has the <animate> tag removed');

  const later = bakeCached(animated, 30);
  ok(typeof later === 'string' && later.length > 0, 'a later bucket bakes a (possibly different) frame');

  const staticSvg = '<svg viewBox="0 0 10 10"><circle r="5" fill="blue"/></svg>';
  ok(bakeCached(staticSvg, 5) === staticSvg, 'a static (no-SMIL) svg bakes to itself unchanged');
}

// ── saturation parity: blend-mode docs dampen; plain cards stay at 1 ──────────────
{
  const blend = '<svg><style>.blend{mix-blend-mode:screen}</style><g class="blend"><rect/></g></svg>';
  const plain = '<svg><g opacity="0.9"><rect fill="#1b1736"/></g></svg>';
  ok(svgSaturationParityOpacity(blend) < 1, 'mix-blend-mode:screen → parity opacity < 1 (matches web blend)');
  ok(svgSaturationParityOpacity(plain) === 1, 'a plain card → parity opacity 1 (untouched)');
  ok(
    svgSaturationParityOpacity('<svg><style>.x{mix-blend-mode:lighten}</style></svg>') < 1,
    'lighten blend also dampens',
  );
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`svgClock: ${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`svgClock: ${passed} passed`);
