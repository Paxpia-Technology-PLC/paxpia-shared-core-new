// Unit tests for the PLATFORM-AGNOSTIC SVG sanitizer (overlays/svgSanitize.ts) — the
// DOM-FREE allowlist sanitizer mobile (+ any RN consumer) runs before handing an
// untrusted SVG overlay to react-native-svg. Asserts the execution/navigation surface
// is stripped and the legitimate presentational surface survives.
//
//     node --experimental-strip-types test/svgSanitize.test.ts

import { sanitizeSvgString } from '../src/overlays/svgSanitize.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}

// ── keeps the legitimate surface ─────────────────────────────────────────────
{
  const safe = '<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="red"/></svg>';
  const out = sanitizeSvgString(safe);
  ok(out.startsWith('<svg'), 'plain svg survives (root kept)');
  ok(out.includes('<rect') && out.includes('fill="red"'), 'shapes + presentation attrs survive');

  const grad =
    '<svg><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><circle r="5" fill="url(#g)"/></svg>';
  const gout = sanitizeSvgString(grad);
  ok(gout.includes('lineargradient') || gout.includes('linearGradient'), 'gradients survive');
  ok(gout.includes('fill="url(#g)"'), 'fragment url() refs survive');

  const anim = '<svg><rect><animate attributeName="x" from="0" to="10" dur="1s"/></rect></svg>';
  ok(sanitizeSvgString(anim).includes('animate'), 'SMIL <animate> survives');

  const img = '<svg><image href="https://cdn.example.com/a.png" width="10" height="10"/></svg>';
  ok(sanitizeSvgString(img).includes('href="https://cdn.example.com/a.png"'), 'https <image> href survives');
}

// ── strips the execution / navigation surface ────────────────────────────────
{
  const script = '<svg><script>alert(1)</script><rect/></svg>';
  const sout = sanitizeSvgString(script);
  ok(!/script/i.test(sout), '<script> subtree removed');
  ok(!sout.includes('alert(1)'), 'script body removed');

  const fo = '<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(1)></body></foreignObject><rect/></svg>';
  const foout = sanitizeSvgString(fo);
  ok(!/foreignobject/i.test(foout), '<foreignObject> subtree removed');
  ok(!/onerror/i.test(foout), 'html inside foreignObject removed');

  const onload = '<svg onload="alert(1)"><rect onclick="steal()"/></svg>';
  const onout = sanitizeSvgString(onload);
  ok(!/onload/i.test(onout), 'on* handler on root removed');
  ok(!/onclick/i.test(onout), 'on* handler on child removed');

  const jsHref = '<svg><a href="javascript:alert(1)"><rect/></a></svg>'; // <a> not allowed anyway
  ok(!/javascript:/i.test(sanitizeSvgString(jsHref)), 'javascript: scheme stripped');

  const jsImg = '<svg><image href="javascript:alert(1)"/></svg>';
  ok(!/javascript:/i.test(sanitizeSvgString(jsImg)), 'javascript: href on <image> stripped');

  const dataHtml = '<svg><image href="data:text/html,<script>alert(1)</script>"/></svg>';
  ok(!/data:text\/html/i.test(sanitizeSvgString(dataHtml)), 'data:text/html href stripped');

  const styleTag = '<svg><style>* { background: url(javascript:alert(1)); }</style><rect/></svg>';
  const styleOut = sanitizeSvgString(styleTag);
  ok(!/javascript:/i.test(styleOut), '<style> body with url(javascript:) dropped');
}

// ── rejects non-svg / oversized → empty ──────────────────────────────────────
{
  ok(sanitizeSvgString('') === '', 'empty input → empty');
  ok(sanitizeSvgString('not svg') === '', 'non-svg text → empty');
  ok(sanitizeSvgString('<div>hi</div>') === '', 'non-svg root → empty');
  // Oversized (> 15 KiB) → empty.
  const huge = '<svg>' + '<rect/>'.repeat(5000) + '</svg>';
  ok(sanitizeSvgString(huge) === '', 'oversized svg → empty (byte cap)');
}

if (failures.length) {
  console.error(`svgSanitize: ${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`svgSanitize: ${passed} passed`);
