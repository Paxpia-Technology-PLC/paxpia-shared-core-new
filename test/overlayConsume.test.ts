// Unit tests for the UNIFIED overlay-channel consumption (overlays/consume.ts) — the
// single decode→classify ladder web + mobile share. Asserts every on-topic envelope
// resolves to its event, and an unknown/foreign payload becomes an explicit
// `unsupported` event (never silently dropped) carrying the raw `t` tag.
//
//     node --experimental-strip-types test/overlayConsume.test.ts

import {
  decodeOverlayChannelMsg,
  unsupportedOverlayLabel,
} from '../src/overlays/consume.ts';
import { encodeOverlayMsg } from '../src/overlays/wire.ts';
import { encodeSvgOverlayMsg } from '../src/overlays/svg.ts';
import { encodeLiveSyncMsg } from '../src/streaming/live.ts';
import { encodeSceneSyncMsg } from '../src/streaming/scene.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}

const enc = (s: string) => new TextEncoder().encode(s);

// ── each on-topic envelope classifies to its event ───────────────────────────
{
  const changed = encodeOverlayMsg({ t: 'overlay.changed', v: 1, roomName: 'r', overlay: null });
  ok(decodeOverlayChannelMsg(changed).kind === 'overlay.changed', 'overlay.changed classifies');

  const results = encodeOverlayMsg({
    t: 'overlay.results', v: 1, roomName: 'r', overlayId: 'o', gen: 0, phase: 'active', tallies: {}, total: 0,
  });
  ok(decodeOverlayChannelMsg(results).kind === 'overlay.results', 'overlay.results classifies');

  const response = encodeOverlayMsg({ t: 'overlay.response', v: 1, overlayId: 'o', gen: 0, choice: 'a' });
  ok(decodeOverlayChannelMsg(response).kind === 'overlay.response', 'overlay.response classifies');

  const control = encodeOverlayMsg({ t: 'overlay.control', v: 1, action: 'request_state' });
  ok(decodeOverlayChannelMsg(control).kind === 'overlay.control', 'overlay.control classifies');

  const sync = encodeLiveSyncMsg({ t: 'live.sync', v: 1, doc: null });
  ok(decodeOverlayChannelMsg(sync).kind === 'live.sync', 'live.sync classifies');

  const scene = encodeSceneSyncMsg({
    t: 'scene.sync', v: 1, scene: { sceneId: 's', nonce: 1, overlays: [] },
  });
  ok(decodeOverlayChannelMsg(scene).kind === 'scene.sync', 'scene.sync classifies');

  const svg = encodeSvgOverlayMsg({ t: 'overlay.svg', v: 1, id: 'a', svg: '<svg><rect/></svg>' });
  ok(decodeOverlayChannelMsg(svg).kind === 'overlay.svg', 'overlay.svg classifies');

  const svgDel = encodeSvgOverlayMsg({ t: 'overlay.svg.delete', v: 1, id: 'a' });
  ok(decodeOverlayChannelMsg(svgDel).kind === 'overlay.svg', 'overlay.svg.delete classifies as overlay.svg');
}

// ── unknown / foreign / malformed → explicit `unsupported` (never silent) ─────
{
  const unknown = decodeOverlayChannelMsg(enc('{"t":"overlay.future-kind","v":1}'));
  ok(unknown.kind === 'unsupported', 'unknown overlay t → unsupported');
  ok(unknown.kind === 'unsupported' && unknown.t === 'overlay.future-kind', 'unsupported carries the raw t');
  ok(
    unsupportedOverlayLabel({ kind: 'unsupported', t: 'overlay.future-kind' }) === 'unsupported overlay event: overlay.future-kind',
    'label names the unknown t',
  );

  const garbage = decodeOverlayChannelMsg(enc('not json at all'));
  ok(garbage.kind === 'unsupported', 'garbage → unsupported');
  ok(garbage.kind === 'unsupported' && garbage.t === undefined, 'garbage has no t');

  const foreign = decodeOverlayChannelMsg(enc('{"hello":"world"}'));
  ok(foreign.kind === 'unsupported', 'foreign object → unsupported');
}

if (failures.length) {
  console.error(`overlayConsume: ${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`overlayConsume: ${passed} passed`);
