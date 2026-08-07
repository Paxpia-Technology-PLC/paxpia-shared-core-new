// DOC-RENDER MODEL — the platform-agnostic brain that turns a synced `doc` overlay
// (a DocPayload + the room's manifest) into a PLAN the leaf renderer executes. Web
// (DocOverlay: <img> + pdf.js-in-<canvas>) and RN (DocOverlayView: <Image> +
// pdf.js-in-WebView / react-native-pdf) consume THIS so the doc/overlay model
// drives both and only the render PRIMITIVE differs per platform.
//
// ── The problem it solves ────────────────────────────────────────────────────
// A DocPayload.pages[] can hold EITHER pre-rendered page-image URLs (the web
// streamer rasterizes a PDF to JPEGs and ships those) OR — when the bytes weren't
// rasterized for this client — nothing usable, in which case the viewer must fall
// back to the manifest's RAW material URL (an image url, or a raw PDF the viewer
// renders itself). The web DocOverlay had this image-vs-PDF branch inline; the RN
// DocOverlayView only handled the image case, so a raw-PDF room showed a stale
// placeholder ("stale PNG"). Centralizing the decision here means both platforms
// pick the SAME render path for the SAME doc, and the RN renderer finally has a
// real PDF branch to dispatch on.
//
// Pure + serializable: no DOM, no RN, no fetch — it only inspects the payload +
// manifest and returns a descriptor. The leaf renderer reads `kind` and draws.

import type { DocPayload, OverlayInstance } from '../overlays/types';
import type { BookPage } from '../books/types';
import { isPdfEntry, isEpubEntry, isImageEntry } from './preload';
import { manifestEntry } from './viewer';
import type { LiveManifest } from './live';

/** What the leaf renderer should draw for the CURRENT page of a doc.
 *   'image'       — `src` is a directly-displayable image URL (a pre-rendered PDF
 *                   page JPEG, an uploaded slide, or an image material). Draw it
 *                   in an <Image>/<img> with pinch/pan. The common, fast path.
 *   'pdf'         — `src` is a RAW PDF url (the streamer didn't pre-rasterize for
 *                   us). The leaf renderer must rasterize: web pdf.js→canvas, RN
 *                   pdf.js-in-WebView / react-native-pdf. `page` is the page to show.
 *   'epub'        — `src` is a RAW EPUB url. The leaf renderer opens it with an
 *                   epub.js reader (web + RN both via a WebView). Reflowable, so
 *                   `page`/`pageCount` are advisory (the reader owns pagination).
 *   'placeholder' — no usable source yet (a non-URL placeholder page before any
 *                   render pipeline, e.g. a same-machine dev push). Draw the
 *                   labelled card; never a video player.
 *   'book'        — a written book's current chapter (`@paxpia/core/books`). No
 *                   file, no url — `book` on the plan carries the chapter prose
 *                   directly. Renders as scrolling TEXT, no pan/zoom.
 *   'empty'       — no pages at all. */
export type DocRenderKind = 'image' | 'pdf' | 'epub' | 'placeholder' | 'book' | 'empty';

/** The descriptor the leaf renderer executes. `pageCount`/`page` are resolved +
 *  clamped here so neither platform re-derives them (the web off-by-one on an
 *  out-of-range synced page lived in two places before). */
export interface DocRenderPlan {
  kind: DocRenderKind;
  /** The source for the current page: an image URL ('image'), a raw PDF URL
   *  ('pdf'), or undefined ('placeholder'/'empty'/'book'). */
  src?: string;
  /** Clamped current page index (0-based). */
  page: number;
  /** Total pages the renderer should expose for the scrubber/count. For a raw PDF
   *  this comes from the manifest's pageCount (or 1 until the renderer learns it). */
  pageCount: number;
  /** The doc's title (caption/strip extension done upstream). */
  title: string;
  /** Present only when `kind === 'book'` — the chapter the shared `BookPageView`
   *  renders (see `@paxpia/ui/book`). */
  book?: BookPage;
}

/** True if a string looks like a directly-fetchable URL (http(s) or a local
 *  file://blob: object URL the platform produced). Mirrors the web DocOverlay's
 *  `/^https?:/` test, widened for RN file://content:// page renders. */
export function isDisplayableUrl(s: string | undefined): boolean {
  if (!s) return false;
  return /^(https?:|file:|content:|blob:|data:)/i.test(s);
}

/** Resolve the render plan for a doc instance's CURRENT page, given the room's
 *  manifest (which carries the raw material URL + pdf page count for a guest who
 *  renders the PDF itself). Pure — web + RN call this and branch on `kind` ONLY.
 *
 *  Decision order (so the SAME doc renders identically on both platforms):
 *    1. The synced page's payload entry is a displayable URL ⇒ 'image' (the
 *       pre-rendered/uploaded page — the fast path; nothing to rasterize).
 *    2. No usable page URL, but the manifest entry for this doc is a PDF with a
 *       raw url ⇒ 'pdf' (the leaf rasterizes the raw PDF at `page`).
 *    3. No usable page URL, manifest entry is an image with a raw url ⇒ 'image'
 *       on that raw url (a guest who got only the manifest, never page images).
 *    4. A non-URL placeholder page exists ⇒ 'placeholder'.
 *    5. No pages ⇒ 'empty'. */
export function resolveDocRender(
  overlay: OverlayInstance<DocPayload>,
  manifest: LiveManifest | null,
): DocRenderPlan {
  const payload = overlay.payload;

  // 0. A written book's current chapter. Checked FIRST: a book has no file, no
  // `pages`, no `sourceUrl` — every branch below would land on 'empty' otherwise.
  // Pagination rides the payload's own generic `page`; the shared chrome shows a
  // single page (the REAL chapter nav is the host's own control — see
  // `Paxpia-mobile/src/live/session/useBookPane.ts` — not this shell's chrome).
  if (payload.book) {
    return {
      kind: 'book',
      page: payload.page ?? 0,
      pageCount: 1,
      title: payload.book.title,
      book: payload.book,
    };
  }

  const pages = payload.pages ?? [];
  const title = payload.title ?? '';
  const entry = manifestEntry(manifest, overlay.id);

  // pageCount: prefer the rendered page array, else the manifest's PDF page count,
  // else 1. Used for the scrubber/count + clamping.
  const pageCount = pages.length > 0 ? pages.length : entry?.pageCount && entry.pageCount > 0 ? entry.pageCount : 1;
  const page = Math.max(0, Math.min(payload.page ?? 0, pageCount - 1));

  // 1. A PORTABLE pre-rendered page image (http(s)/data) — the fast path. A `blob:`
  // page is DELIBERATELY excluded here: a web streamer rasterizes a PDF to `blob:` object
  // URLs that are valid ONLY in the document that created them, so a SYNCED doc's viewer
  // on another device (or browser tab) physically cannot fetch them — it would render
  // blank (THE long-standing "PDFs don't render on mobile" bug). We instead fall through
  // to the device-portable raw source (manifest/sourceUrl → pdf.js/epub.js renders it),
  // and only use a `blob:` page as a SAME-DEVICE last resort below (step 3b).
  const pageSrc = pages[page];
  const pageIsPortable = isDisplayableUrl(pageSrc) && !/^blob:/i.test(pageSrc ?? '');
  if (pageIsPortable) {
    return { kind: 'image', src: pageSrc, page, pageCount, title };
  }

  // 2/3. Fall back to the raw material url from the manifest. Order is
  // EPUB → PDF → IMAGE, and IMAGE is now matched EXPLICITLY (isImageEntry: any
  // image/* mime or image extension incl. .webp) BEFORE the catch-all so a webp can
  // never be mistaken for a PDF and routed to the pdf.js leaf (which fails → the
  // previous doc lingers). The final `image` fallback stays for an url with no mime
  // and no extension (a presigned image whose type we can't sniff but still IS the
  // page) — better a direct <Image> attempt than the PDF leaf.
  if (entry?.url) {
    if (isEpubEntry(entry)) {
      return { kind: 'epub', src: entry.url, page, pageCount, title };
    }
    if (isImageEntry(entry)) {
      return { kind: 'image', src: entry.url, page, pageCount, title };
    }
    if (isPdfEntry(entry)) {
      return { kind: 'pdf', src: entry.url, page, pageCount, title };
    }
    // No mime/extension we recognize: treat the raw url as the image page.
    return { kind: 'image', src: entry.url, page, pageCount, title };
  }

  // 2b. NO manifest (the studio PREVIEW path), but the payload carries its own
  // sourceUrl + sourceMime. Same branch as 2/3 but off the payload, so a previewed
  // EPUB (empty pages[], no room manifest) still routes to the epub.js reader instead
  // of falling through to 'empty'. PDF/image previews keep working off pages[] above;
  // this matters for the page-less EPUB case.
  if (isDisplayableUrl(payload.sourceUrl)) {
    const src = payload.sourceUrl as string;
    const hint = { mime: payload.sourceMime ?? '', filename: src };
    if (isEpubEntry(hint)) {
      return { kind: 'epub', src, page, pageCount, title };
    }
    // IMAGE matched explicitly (incl. image/webp + .webp urls) before PDF so a webp
    // preview never routes to the pdf.js leaf and strands the prior doc on screen.
    if (isImageEntry(hint)) {
      return { kind: 'image', src, page, pageCount, title };
    }
    if (isPdfEntry(hint)) {
      return { kind: 'pdf', src, page, pageCount, title };
    }
    return { kind: 'image', src, page, pageCount, title };
  }

  // 3b. SAME-DEVICE last resort: a `blob:` page (the producing device's own freshly
  // rasterized cache). Reached only when there was no portable raw source above, so it's
  // the producer previewing its OWN doc — where the blob IS loadable. A remote viewer
  // never lands here (it always has the manifest/sourceUrl raw source).
  if (isDisplayableUrl(pageSrc)) {
    return { kind: 'image', src: pageSrc, page, pageCount, title };
  }

  // 4. A non-URL placeholder page (dev push before a render pipeline).
  if (pages.length > 0) {
    return { kind: 'placeholder', page, pageCount, title };
  }

  // 5. Nothing.
  return { kind: 'empty', page: 0, pageCount: 0, title };
}

// The zoom clamp (DOC_MIN_ZOOM / DOC_MAX_ZOOM / clampDocZoom) now lives in
// docViewport.ts alongside the rest of the pan/zoom math (single source of truth);
// re-exported here so the long-standing `from './docRender'` imports keep working.
export { DOC_MIN_ZOOM, DOC_MAX_ZOOM, clampDocZoom } from './docViewport';
