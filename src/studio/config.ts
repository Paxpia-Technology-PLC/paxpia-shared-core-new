// STUDIO CONFIG API SEAM — account-backed persistence for the educator/streamer
// studio (producer scenes + scheduled-class timelines + per-scene assignments),
// lifted verbatim out of `Paxpia-web/src/data/studioApi.ts` behind an injected
// platform `fetch` seam (mirroring `MaterialsClient`). The wire shape is ONE opaque
// JSON blob keyed server-side by the gateway-verified user id (X-User-ID); the
// server never interprets `config`, the client owns the schema + forward-migration.
// Routes (unchanged):
//   GET /api/v1/social/studio/config → { config, version, updated_at_unix }
//   PUT /api/v1/social/studio/config ← { config, version }
//
// PLATFORM SEAM: like the materials module, the core stays neutral (no DOM/RN, no
// global `fetch`, no auth store). The platform passes a `StudioConfigClient`
// — { url, fetch, authHeader, isAuthed } — so the SAME calls run under Vite and
// Metro. `url` is the fully-resolved config endpoint (the platform owns API_BASE).

import type { RawStudioConfigBlob, StudioConfigBlob } from './types';

// Reuse the SAME structural fetch slice the materials module describes (core's lib
// is ES2020 only; the platform's real `fetch`/`Response` are assignable to these).

/** The request-init slice these calls set. */
export interface FetchRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** The response slice these calls read. The platform's real `Response` satisfies it. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** The minimal `fetch` surface the config calls need; the platform passes its global
 *  `fetch` directly (structurally compatible). */
export type FetchLike = (input: string, init?: FetchRequestInit) => Promise<FetchResponse>;

/** Everything the studio-config calls need from the platform, injected so the core
 *  has no global `fetch`, no auth store, and no URL config baked in.
 *    • `url`        — the fully-resolved config endpoint
 *                     (e.g. `${API_BASE}/v1/social/studio/config`).
 *    • `fetch`      — the platform fetch (browser/RN). Same calls, same JSON.
 *    • `authHeader` — returns the `Authorization` header map (or {} when unauthed),
 *                     called per-request so a token refresh is picked up.
 *    • `isAuthed`   — whether there's a usable token; a logged-out GET is skipped
 *                     (the gateway would 401) and a logged-out PUT is a no-op. */
export interface StudioConfigClient {
  url: string;
  fetch: FetchLike;
  authHeader: () => Record<string, string>;
  isAuthed: () => boolean;
}

/** The normalized config response. */
export interface StudioConfigResponse {
  config: RawStudioConfigBlob;
  /** Server-side blob version (0 = never saved). */
  version: number;
  /** Server write time (unix seconds); 0 when never saved. */
  updatedAtUnix: number;
}

interface RawStudioConfig {
  config: RawStudioConfigBlob;
  version: number;
  updated_at_unix: number;
}

/** Fetch the signed-in user's studio config. Returns null when logged out (no token
 *  → the gateway would 401) so callers can skip a doomed request. A brand-new user
 *  gets `{ config: {}, version: 0 }`. Throws on a transport/HTTP error so the
 *  coordinator can fall back to its offline cache. */
export async function getStudioConfig(client: StudioConfigClient): Promise<StudioConfigResponse | null> {
  if (!client.isAuthed()) return null;
  const res = await client.fetch(client.url, { headers: { ...client.authHeader() } });
  if (!res.ok) throw new Error(`studio config GET ${res.status}`);
  const d = (await res.json()) as RawStudioConfig;
  return {
    config: (d.config ?? {}) as RawStudioConfigBlob,
    version: Number(d.version ?? 0),
    updatedAtUnix: Number(d.updated_at_unix ?? 0),
  };
}

/** Persist the studio config blob for the signed-in user. No-op (returns false) when
 *  logged out. Returns true on a 2xx write, throws on a transport/HTTP error so the
 *  caller can retry / surface it. */
export async function putStudioConfig(
  client: StudioConfigClient,
  // The serialized studio document. Typed broadly (the concrete `StudioConfigBlob`
  // the coordinator snapshots, or a raw passthrough) — it's opaque to the server,
  // JSON-stringified as-is.
  config: StudioConfigBlob | RawStudioConfigBlob,
  version: number,
): Promise<boolean> {
  if (!client.isAuthed()) return false;
  const res = await client.fetch(client.url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...client.authHeader() },
    body: JSON.stringify({ config, version }),
  });
  if (!res.ok) throw new Error(`studio config PUT ${res.status}`);
  return true;
}
