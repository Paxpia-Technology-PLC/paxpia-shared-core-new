// PRIVATE class-materials domain model — the `doc` overlay pipeline (v2), shared
// once by web + mobile.
//
// DESIGN (the private-bucket + presigned-grant pipeline this models):
//   • Educators upload the RAW file (PDF / image / EPUB) ONCE to a PRIVATE bucket.
//     The server stores the raw bytes — it does NOT pre-render PDF pages. Nothing
//     is publicly reachable.
//   • To use a material live (or let a viewer preload it), the client asks for a
//     short-lived presigned GET URL via POST /grant, scoped to a room.
//   • IMAGE materials → the granted URL IS the page.
//   • PDF materials  → the client downloads the raw PDF from the presigned URL and
//     renders each page locally (pdf.js on web, react-native-pdf on mobile). The
//     server never sees rendered pages.
//   • EPUB materials → a reflowable book opened live by the epub.js reader; no
//     per-page rasterization.
//
// PLATFORM NEUTRALITY: this module has NO DOM/RN/fetch dependency. Every type here
// is a plain data shape; the network calls in `grant.ts` take an INJECTED
// `fetch`-like function + auth token so the same code runs under Vite and Metro.
// The web byte-fetch + pdf.js render and the RN file fetch + native render stay in
// their respective platform layers.

/** A material's kind. `renderable` = a PDF / image / EPUB we can show live as a
 *  synced `doc` overlay. `supplementary` = any other allowed attachment (e.g. a
 *  zip, a spreadsheet) that viewers download but the streamer CANNOT push live. */
export type MaterialKind = 'renderable' | 'supplementary';

/** Caller-facing metadata for a stored material. Mirrors the server row but with
 *  camelCased / numeric fields. `pageCount` is only meaningful for PDFs and is
 *  populated by the server when it can cheaply count pages; it may be absent. */
export interface MaterialMeta {
  id: string;
  filename: string;
  kind: MaterialKind;
  mime: string;
  sizeBytes: number;
  pageCount?: number;
}

/** A presigned grant for one material — a short-lived GET URL plus the metadata a
 *  client needs to decide HOW to consume it (image vs PDF vs download-only). */
export interface MaterialGrant {
  id: string;
  filename: string;
  mime: string;
  kind: MaterialKind;
  sizeBytes: number;
  pageCount?: number;
  /** Short-lived presigned GET URL for the RAW file. */
  url: string;
  expiresInSeconds: number;
}

/** Aggregate manifest for a set of material ids — used by the stream preloader to
 *  know the TOTAL bytes it will warm before it starts streaming them. */
export interface MaterialsManifest {
  materials: MaterialMeta[];
  totalSizeBytes: number;
  count: number;
}

// ── Wire shapes ──────────────────────────────────────────────────────────────
// The server speaks snake_case; the mappers in `grant.ts` normalize to the
// camelCase model above so the rest of the app (web AND mobile) never touches raw
// wire shapes. Exported so a platform layer that hand-rolls a request (or a test)
// can reference the exact wire contract.

export interface RawMaterial {
  id: string;
  filename: string;
  kind: MaterialKind;
  mime: string;
  size_bytes: number;
  page_count?: number;
}

export interface RawGrant {
  material_id: string;
  filename: string;
  mime: string;
  kind: MaterialKind;
  size_bytes: number;
  page_count?: number;
  url: string;
  expires_in_seconds: number;
}
