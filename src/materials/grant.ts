// MATERIALS GRANT / FRESHNESS — the ONE source of fresh presigned material URLs,
// shared by web + mobile. This is the structural enabler for manifest-derived
// doc-tests + the future mobile materials: lifted verbatim out of
// Paxpia-web/src/data/materialsApi.ts so both platforms derive fresh URLs from one
// path. The manifest / presigned semantics are byte-identical to the web original.
//
// PLATFORM SEAM: the core stays platform-neutral (no DOM/RN, no global `fetch`).
// The caller passes a `MaterialsClient` — { baseUrl, fetch, authHeader } — so the
// SAME logic runs under Vite (browser `fetch`) and Metro (RN `fetch`). The
// web-only PDF→images render (pdf.js) and the RN native render stay in their
// platform layers and consume `MaterialGrant.url` / `buildManifestEntries` output;
// they are NOT part of this neutral core.

import type { ManifestEntry } from '../streaming/live';
import type {
  MaterialGrant,
  MaterialMeta,
  MaterialsManifest,
  RawGrant,
  RawMaterial,
} from './types';

// ── The injected platform seam ───────────────────────────────────────────────

// Core's lib is ES2020 only (no DOM), so we describe the SLICE of `fetch`/`Response`
// this module actually uses with neutral structural shapes. The platform's real
// `fetch` is structurally assignable to `FetchLike` (DOM `Response`/RN `Response`
// both satisfy `FetchResponse`), so callers pass their global `fetch` directly with
// no adapter. The browser/RN `RequestInit` likewise satisfies `FetchRequestInit`.

/** The request-init slice these calls set: method, headers, and a JSON/FormData
 *  body. `headers` is a plain record (what every call here builds); `body` is left
 *  `unknown` so a platform FormData (web FormData / RN FormData) passes through for
 *  the upload path the platform layer owns. */
export interface FetchRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** The response slice these calls read. The platform's real `Response` (DOM or RN)
 *  is structurally assignable to this. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** The minimal `fetch` surface the materials calls need. The platform passes its
 *  global `fetch` directly (no adapter) — it's structurally compatible. */
export type FetchLike = (input: string, init?: FetchRequestInit) => Promise<FetchResponse>;

/** Everything the materials network calls need from the platform, injected so the
 *  core has no global `fetch`, no auth store, and no URL config baked in.
 *    • `baseUrl`     — the materials route root (e.g. `${API_BASE}/v1/videos/materials`),
 *                      WITHOUT a trailing slash.
 *    • `fetch`       — the platform fetch (browser/RN). Same calls, same FormData/JSON.
 *    • `authHeader`  — returns the `Authorization` header map (or {} when unauthed),
 *                      called per-request so a token refresh is picked up. */
export interface MaterialsClient {
  baseUrl: string;
  fetch: FetchLike;
  authHeader: () => Record<string, string>;
}

// ── Wire ⇄ model mapping (pure) ──────────────────────────────────────────────
// The server speaks snake_case; we normalize to the camelCase model so the rest of
// the app (and the RN app) never touches raw wire shapes.

export function mapMaterial(r: RawMaterial): MaterialMeta {
  return {
    id: r.id,
    filename: r.filename,
    kind: r.kind,
    mime: r.mime,
    sizeBytes: Number(r.size_bytes ?? 0),
    pageCount: r.page_count,
  };
}

export function mapGrant(g: RawGrant): MaterialGrant {
  return {
    id: g.material_id,
    filename: g.filename,
    mime: g.mime,
    kind: g.kind,
    sizeBytes: Number(g.size_bytes ?? 0),
    pageCount: g.page_count,
    url: g.url,
    expiresInSeconds: Number(g.expires_in_seconds ?? 0),
  };
}

/** Turn a non-2xx materials response into a human-readable Error. The server may
 *  send `{ error: { message } }` or a bare string; fall back to the status. */
export async function materialsError(res: FetchResponse, fallback: string): Promise<Error> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string }; message?: string } | null;
    detail = body?.error?.message ?? body?.message ?? '';
  } catch {
    /* non-JSON body */
  }
  // Map the documented status codes to friendly text for the uploader UI.
  if (!detail) {
    if (res.status === 413) detail = 'file is too large';
    else if (res.status === 415) detail = 'unsupported file type';
    else if (res.status === 400) detail = 'file type did not match its contents';
  }
  return new Error(detail ? `${fallback}: ${detail}` : `${fallback} (${res.status})`);
}

// ── CRUD / grant calls (over the injected client) ────────────────────────────

/** List the caller's materials (newest first), as returned by GET /. */
export async function listMaterials(client: MaterialsClient): Promise<MaterialMeta[]> {
  const res = await client.fetch(`${client.baseUrl}/`, { headers: { ...client.authHeader() } });
  if (!res.ok) throw await materialsError(res, 'list materials failed');
  const d = (await res.json()) as { materials?: RawMaterial[] };
  return (d.materials ?? []).map(mapMaterial);
}

/** Grant short-lived presigned GET URLs for `ids`, scoped to `roomName`. The
 *  server checks the caller is allowed to share these into that room. */
export async function grantMaterials(
  client: MaterialsClient,
  ids: string[],
  roomName: string,
): Promise<MaterialGrant[]> {
  const res = await client.fetch(`${client.baseUrl}/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...client.authHeader() },
    body: JSON.stringify({ material_ids: ids, room_name: roomName }),
  });
  if (!res.ok) throw await materialsError(res, 'grant materials failed');
  const d = (await res.json()) as { grants?: RawGrant[] };
  return (d.grants ?? []).map(mapGrant);
}

/** Grant + return exactly one material's presigned URL (convenience for the
 *  preloader / doc builder, which work one material at a time). Throws if the
 *  server didn't return a grant for the id. */
export async function grantOne(
  client: MaterialsClient,
  id: string,
  roomName: string,
): Promise<MaterialGrant> {
  const grants = await grantMaterials(client, [id], roomName);
  const g = grants.find((x) => x.id === id) ?? grants[0];
  if (!g) throw new Error('no grant returned for material');
  return g;
}

/** Fetch the aggregate manifest (sizes) for a set of ids — the preloader's first
 *  call so it knows the TOTAL bytes before warming them. */
export async function getManifest(client: MaterialsClient, ids: string[]): Promise<MaterialsManifest> {
  const qs = encodeURIComponent(ids.join(','));
  const res = await client.fetch(`${client.baseUrl}/manifest?ids=${qs}`, {
    headers: { ...client.authHeader() },
  });
  if (!res.ok) throw await materialsError(res, 'manifest failed');
  const d = (await res.json()) as { materials?: RawMaterial[]; total_size_bytes?: number; count?: number };
  const materials = (d.materials ?? []).map(mapMaterial);
  return {
    materials,
    totalSizeBytes: Number(d.total_size_bytes ?? materials.reduce((a, m) => a + m.sizeBytes, 0)),
    count: Number(d.count ?? materials.length),
  };
}

/** STREAMER: grant presigned URLs for `materialIds` in `roomName` and assemble the
 *  broadcastable manifest entries (id + filename + mime + size + presigned URL).
 *  This is the ONLY place the auth'd /grant is called for the room manifest; the
 *  result rides the live-sync wire so UNAUTH'd guests get the URLs too. */
export async function buildManifestEntries(
  client: MaterialsClient,
  materialIds: string[],
  roomName: string,
): Promise<ManifestEntry[]> {
  if (materialIds.length === 0) return [];
  const grants = await grantMaterials(client, materialIds, roomName);
  return grants.map((g) => ({
    id: g.id,
    filename: g.filename,
    mime: g.mime,
    sizeBytes: g.sizeBytes,
    pageCount: g.pageCount,
    url: g.url,
  }));
}
