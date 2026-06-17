// In-memory PRELOAD model — the platform-agnostic contract for the lag-free
// hot-swap cache used by BOTH the streamer and every viewer. The KEYING, the
// "what's already warm", and the doc-payload shape live here; the actual byte
// fetch + PDF→image rasterization are the per-platform seam (web: fetch +
// pdf.js + object URLs; RN: react-native-blob-util + react-native-pdf).
//
// ── The idea (one cache, two roles) ──────────────────────────────────────────
// On go-live (streamer) and on stream-entry (viewer) we preload ALL of the running
// class's materials into an in-memory map keyed by material id, each entry holding
// the already-rendered DocPayload (image URLs / object URLs). Displaying or
// hot-swapping a material then reads the cache → INSTANT. The broadcast to viewers
// carries only the material id (which the viewer already has warm), so it's instant
// for them too. Nothing is fetched on the display path.
//
// RN PORTABILITY: a `PreloadCache` is just a Map<id, CachedDoc>; the render layer
// fills it via a platform `renderDoc(entry) → DocPayload`. The selection logic
// (`materialsToPreload`, `isWarm`, `getCachedDoc`) is shared here verbatim.

import type { DocPayload } from '../overlays/types';
import type { LiveManifest, ManifestEntry } from './live';

/** A material warmed into memory: its ready-to-render DocPayload (page image URLs)
 *  keyed by the material id. `bytes` is what we actually fetched (for the progress
 *  total reconciliation). */
export interface CachedDoc {
  id: string;
  doc: DocPayload;
  bytes: number;
}

/** The in-memory cache — a plain map so it serializes nowhere and both platforms
 *  implement it identically. The render layer owns the object-URL lifetime; this
 *  is just the keyed store. */
export type PreloadCache = Map<string, CachedDoc>;

/** A fresh, empty cache. */
export function newPreloadCache(): PreloadCache {
  return new Map<string, CachedDoc>();
}

/** Is a material already warm in the cache? The display/hot-swap path checks this
 *  to decide read-from-cache (instant) vs (the slow path) fetch-and-render. */
export function isWarm(cache: PreloadCache, id: string): boolean {
  return cache.has(id);
}

/** Read a warmed DocPayload, or undefined if not yet cached. */
export function getCachedDoc(cache: PreloadCache, id: string): DocPayload | undefined {
  return cache.get(id)?.doc;
}

/** Put a freshly-rendered doc into the cache (replacing any prior entry). */
export function putCachedDoc(cache: PreloadCache, id: string, doc: DocPayload, bytes: number): void {
  cache.set(id, { id, doc, bytes });
}

/** Which manifest entries still need warming, given what's already cached. Pure —
 *  used by both producer and viewer so the preload loop only fetches misses.
 *  Only RENDERABLE materials (image/PDF) are returned; a supplementary attachment
 *  (no usable doc render) is skipped. */
export function materialsToPreload(manifest: LiveManifest | null, cache: PreloadCache): ManifestEntry[] {
  if (!manifest) return [];
  return manifest.entries.filter((e) => !cache.has(e.id) && isRenderableMime(e.mime, e.filename));
}

/** True for a MIME/filename we can show live as a synced doc (image, PDF, or
 *  EPUB). The same predicate the materials API uses, kept here so the preload
 *  planner doesn't depend on the web data layer. EPUB is renderable now that both
 *  platforms have an epub.js reader leaf (resolveDocRender → 'epub'); without it an
 *  EPUB material was silently dropped from materialsToPreload + the manifest. */
export function isRenderableMime(mime: string | undefined, filename: string | undefined): boolean {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return true;
  if (m === 'application/pdf') return true;
  if (m === 'application/epub+zip') return true;
  const f = (filename ?? '').toLowerCase();
  return f.endsWith('.pdf') || f.endsWith('.epub') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(f);
}

/** True if a manifest entry is a PDF (drives the render-path branch). */
export function isPdfEntry(e: Pick<ManifestEntry, 'mime' | 'filename'>): boolean {
  return (e.mime ?? '').toLowerCase() === 'application/pdf' || (e.filename ?? '').toLowerCase().endsWith('.pdf');
}

/** True if a manifest entry is an EPUB — by mime (application/epub+zip) or a .epub
 *  filename. Mirrors isPdfEntry so the shared docRender plan can route it to the
 *  epub leaf renderer (an epub.js-in-WebView reader on each platform). */
export function isEpubEntry(e: Pick<ManifestEntry, 'mime' | 'filename'>): boolean {
  return (e.mime ?? '').toLowerCase() === 'application/epub+zip' || (e.filename ?? '').toLowerCase().endsWith('.epub');
}

/** True if a manifest entry is a directly-displayable IMAGE — by an `image/*` mime
 *  (covers image/webp, image/png, image/jpeg, image/gif, …) OR a recognized image
 *  filename extension. This is what classifies WEBP (and every other image format)
 *  as the IMAGE leaf so it can NEVER fall through to the PDF leaf.
 *
 *  WHY: the doc-kind classifiers in prep.ts (parse/deriveManifest) historically
 *  collapsed to `pdf` for anything not the literal string `'image'`. A webp tagged
 *  by its raw mime (`image/webp`) or carried only as a `.webp` url would then be
 *  mislabeled `pdf`, routed to the pdf.js-in-WebView leaf, fail to render, and leave
 *  the PREVIOUSLY-mounted doc on screen (the reported "webp doesn't render — overlay
 *  stays on the previous doc"). Making image classification explicit + format-aware
 *  closes that — an image is an image regardless of which image codec it uses. */
export function isImageEntry(e: Pick<ManifestEntry, 'mime' | 'filename'>): boolean {
  const m = (e.mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return true;
  const f = (e.filename ?? '').toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(\?|#|$)/.test(f);
}
