// Unit tests for the shared MATERIALS grant/freshness model (the doc-overlay
// pipeline v2 lifted out of Paxpia-web/src/data/materialsApi.ts): the snake_case
// wire ⇄ camelCase model mappers, the presigned grant/manifest network calls over
// the INJECTED platform fetch seam, and buildManifestEntries' manifest shape.
//
// Runs under Node's native TS type-stripping (same harness as chat.test.ts):
//     node --experimental-strip-types test/materials.test.ts

import {
  mapMaterial,
  mapGrant,
  materialsError,
  listMaterials,
  grantMaterials,
  grantOne,
  getManifest,
  buildManifestEntries,
  type MaterialsClient,
  type FetchLike,
  type FetchResponse,
  type RawMaterial,
  type RawGrant,
} from '../src/materials/index.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}
async function throws(fn: () => Promise<unknown>, name: string): Promise<void> {
  try {
    await fn();
    failures.push(`${name} (did NOT throw)`);
  } catch {
    passed++;
  }
}

// ── A tiny JSON Response stub + a scripted fetch (records the calls) ──────────
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}
function jsonRes(body: unknown, init?: { ok?: boolean; status?: number }): FetchResponse {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  };
}
/** Build a MaterialsClient whose fetch returns canned responses keyed by URL
 *  substring, recording every call so we can assert request shape. */
function fakeClient(routes: Array<{ match: string; res: FetchResponse }>): {
  client: MaterialsClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`unrouted fetch ${url}`);
    return hit.res;
  };
  const client: MaterialsClient = {
    baseUrl: 'http://x/api/v1/videos/materials',
    fetch,
    authHeader: () => ({ Authorization: 'Bearer T' }),
  };
  return { client, calls };
}

const rawMaterial: RawMaterial = {
  id: 'm1',
  filename: 'slides.pdf',
  kind: 'renderable',
  mime: 'application/pdf',
  size_bytes: 2048,
  page_count: 12,
};
const rawGrant: RawGrant = {
  material_id: 'm1',
  filename: 'slides.pdf',
  mime: 'application/pdf',
  kind: 'renderable',
  size_bytes: 2048,
  page_count: 12,
  url: 'https://cdn/slides.pdf?token=abc',
  expires_in_seconds: 600,
};

// ── mapMaterial: snake_case wire → camelCase model, numeric coercion ─────────
{
  eq(
    mapMaterial(rawMaterial),
    { id: 'm1', filename: 'slides.pdf', kind: 'renderable', mime: 'application/pdf', sizeBytes: 2048, pageCount: 12 },
    'mapMaterial maps + camelCases',
  );
  // size_bytes coerced from a string; missing size_bytes → 0; pageCount stays absent
  const coerced = mapMaterial({ ...rawMaterial, size_bytes: '999' as unknown as number, page_count: undefined });
  ok(coerced.sizeBytes === 999 && coerced.pageCount === undefined, 'mapMaterial coerces size_bytes, drops absent pageCount');
  eq(mapMaterial({ ...rawMaterial, size_bytes: undefined as unknown as number }).sizeBytes, 0, 'absent size_bytes → 0');
}

// ── mapGrant: material_id → id, expires_in_seconds → expiresInSeconds ────────
{
  eq(
    mapGrant(rawGrant),
    {
      id: 'm1',
      filename: 'slides.pdf',
      mime: 'application/pdf',
      kind: 'renderable',
      sizeBytes: 2048,
      pageCount: 12,
      url: 'https://cdn/slides.pdf?token=abc',
      expiresInSeconds: 600,
    },
    'mapGrant maps material_id→id + presigned url + expiry',
  );
  eq(mapGrant({ ...rawGrant, expires_in_seconds: undefined as unknown as number }).expiresInSeconds, 0, 'absent expiry → 0');
}

// ── materialsError: friendly status text + detail extraction ─────────────────
await (async () => {
  const e413 = await materialsError(jsonRes(null, { ok: false, status: 413 }), 'upload failed');
  eq(e413.message, 'upload failed: file is too large', '413 → friendly size text');
  const e415 = await materialsError(jsonRes(null, { ok: false, status: 415 }), 'upload failed');
  eq(e415.message, 'upload failed: unsupported file type', '415 → friendly type text');
  const eDetail = await materialsError(jsonRes({ error: { message: 'boom' } }, { ok: false, status: 500 }), 'grant');
  eq(eDetail.message, 'grant: boom', 'server error.message wins');
  const eBare = await materialsError(jsonRes({ message: 'nope' }, { ok: false, status: 500 }), 'grant');
  eq(eBare.message, 'grant: nope', 'bare message field used');
  const eStatus = await materialsError(jsonRes('not json', { ok: false, status: 502 }), 'list');
  eq(eStatus.message, 'list (502)', 'no detail → status fallback');
})();

// ── listMaterials: GET / with auth header; maps rows ─────────────────────────
await (async () => {
  const { client, calls } = fakeClient([{ match: '/materials/', res: jsonRes({ materials: [rawMaterial] }) }]);
  const list = await listMaterials(client);
  eq(list.length, 1, 'listMaterials returns the rows');
  eq(list[0].sizeBytes, 2048, 'listMaterials maps row to model');
  eq(calls[0].headers.Authorization, 'Bearer T', 'listMaterials sends injected auth header');
  // empty/missing materials → []
  const { client: c2 } = fakeClient([{ match: '/materials/', res: jsonRes({}) }]);
  eq((await listMaterials(c2)).length, 0, 'missing materials field → []');
})();

// ── grantMaterials: POST /grant with snake_case body; maps grants ────────────
await (async () => {
  const { client, calls } = fakeClient([{ match: '/grant', res: jsonRes({ grants: [rawGrant] }) }]);
  const grants = await grantMaterials(client, ['m1'], 'room-7');
  eq(grants[0].id, 'm1', 'grant material_id mapped to id');
  eq(grants[0].url, 'https://cdn/slides.pdf?token=abc', 'grant carries the presigned url');
  eq(calls[0].method, 'POST', 'grant is a POST');
  eq(JSON.parse(calls[0].body as string), { material_ids: ['m1'], room_name: 'room-7' }, 'grant body is snake_case ids + room');
  ok((calls[0].headers['Content-Type'] ?? '') === 'application/json', 'grant sets JSON content-type');
})();

// ── grantMaterials: non-ok throws a mapped error ─────────────────────────────
await throws(async () => {
  const { client } = fakeClient([{ match: '/grant', res: jsonRes(null, { ok: false, status: 403 }) }]);
  await grantMaterials(client, ['m1'], 'room-7');
}, 'grantMaterials throws on non-2xx (the 403 stale-token path)');

// ── grantOne: returns the matching grant, or throws when none ────────────────
await (async () => {
  const { client } = fakeClient([{ match: '/grant', res: jsonRes({ grants: [rawGrant] }) }]);
  eq((await grantOne(client, 'm1', 'r')).id, 'm1', 'grantOne returns the requested id');
})();
await throws(async () => {
  const { client } = fakeClient([{ match: '/grant', res: jsonRes({ grants: [] }) }]);
  await grantOne(client, 'm1', 'r');
}, 'grantOne throws when no grant returned');

// ── getManifest: query string ids + size reconciliation ──────────────────────
await (async () => {
  const { client, calls } = fakeClient([
    { match: '/manifest', res: jsonRes({ materials: [rawMaterial], total_size_bytes: 2048, count: 1 }) },
  ]);
  const man = await getManifest(client, ['m1', 'm2']);
  eq(man, { materials: [mapMaterial(rawMaterial)], totalSizeBytes: 2048, count: 1 }, 'getManifest maps + carries totals');
  ok(calls[0].url.includes(encodeURIComponent('m1,m2')), 'getManifest encodes the ids into the query string');
  // totals fall back to summing mapped sizes / counting rows when the server omits them
  const { client: c2 } = fakeClient([{ match: '/manifest', res: jsonRes({ materials: [rawMaterial] }) }]);
  const m2 = await getManifest(c2, ['m1']);
  ok(m2.totalSizeBytes === 2048 && m2.count === 1, 'getManifest derives totals when server omits them');
})();

// ── buildManifestEntries: grants → broadcastable ManifestEntry[] ─────────────
await (async () => {
  // empty ids → no grant call at all, empty result
  const { client, calls } = fakeClient([{ match: '/grant', res: jsonRes({ grants: [rawGrant] }) }]);
  eq(await buildManifestEntries(client, [], 'r'), [], 'empty ids → [] (no network)');
  eq(calls.length, 0, 'empty ids does not hit the network');

  const { client: c2 } = fakeClient([{ match: '/grant', res: jsonRes({ grants: [rawGrant] }) }]);
  const entries = await buildManifestEntries(c2, ['m1'], 'room-7');
  eq(
    entries,
    [{ id: 'm1', filename: 'slides.pdf', mime: 'application/pdf', sizeBytes: 2048, pageCount: 12, url: 'https://cdn/slides.pdf?token=abc' }],
    'buildManifestEntries projects the manifest entry (with presigned url)',
  );
})();

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`materials: ${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`materials: ${passed} passed`);
