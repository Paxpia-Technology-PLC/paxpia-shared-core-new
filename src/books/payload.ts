// BOOKS payload builder — turning ONE resolved chapter into a servable
// `DocPayload`. Pure: no fetch, no upload, no course store — the platform layer
// resolves picture urls (grants) and hands the result in as an `AuthoredBook`.

import type { DocPayload } from '../overlays/types';
import type { AuthoredBook, AuthoredBookChapter, AuthoredBookImage } from './types';

/** Matches a whole-line inline image reference: `![caption](uri)`. Mirrors the
 *  ONE dialect `@paxpia/ui/book`'s `MarkdownView` renders — an image must be
 *  alone on its line to be recognized as a picture rather than inline prose. */
const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(([^)]+)\)$/;

export function bookPageCount(book: AuthoredBook): number {
  return book.chapters.length;
}

/** Clamp a chapter index into the book's valid range. 0 for an empty book —
 *  callers with a genuinely empty book should check `bookPageCount` first
 *  (mirrors how `buildBookDocPayload` short-circuits on zero chapters). */
export function clampBookPage(book: AuthoredBook, pageIndex: number): number {
  const count = bookPageCount(book);
  if (count === 0) return 0;
  const truncated = Number.isFinite(pageIndex) ? Math.trunc(pageIndex) : 0;
  return Math.max(0, Math.min(truncated, count - 1));
}

/** A resolved picture's url, absolute-ized against `bucketBase` when it's a bare
 *  object key (LOCK: never store an absolute CDN url — the host is prepended at
 *  render time). A grant is already absolute and passes straight through. */
function resolveImageUrl(url: string, bucketBase: string): string {
  if (!bucketBase || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url; // already has a scheme
  return `${bucketBase.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

/**
 * Rewrite a chapter's inline pictures to their resolved urls, dropping any whose
 * picture has no resolved copy — filtering `images[]` alone isn't enough (the
 * chapter body still carries the `![](file:///…)` line the renderer would draw),
 * so the prose itself is rewritten line-by-line. Returns the resolved pictures
 * too (for `BookPage.images` — counts/thumbnails, never re-drawn).
 */
export function rewriteBookBodyImages(
  body: string,
  images: AuthoredBookImage[],
  bucketBase = '',
): { body: string; images: { url: string; caption?: string }[]; dropped: number } {
  const byUri = new Map(images.map((img) => [img.uri, img]));
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  const resolved: { url: string; caption?: string }[] = [];
  let dropped = 0;

  for (const line of lines) {
    const match = IMAGE_LINE_RE.exec(line.trim());
    if (!match) {
      out.push(line);
      continue;
    }
    const [, caption, uri] = match;
    const img = byUri.get(uri);
    if (img?.url) {
      const url = resolveImageUrl(img.url, bucketBase);
      out.push(`![${caption}](${url})`);
      resolved.push(caption ? { url, caption } : { url });
    } else {
      dropped += 1; // unshippable — reported, not silently swallowed
    }
  }

  return { body: out.join('\n'), images: resolved, dropped };
}

export interface BuiltBookDocPayload {
  /** Null only when the book has no chapters at all. */
  payload: DocPayload | null;
  droppedImages: number;
}

/**
 * Build the servable `DocPayload` for ONE page (chapter) of a book. Step 0 of
 * `resolveDocRender` recognizes `payload.book` before any file-based branch, so
 * this is the ONLY thing the shared renderer needs to draw a book page.
 */
export function buildBookDocPayload(
  book: AuthoredBook,
  pageIndex: number,
  bucketBase = '',
): BuiltBookDocPayload {
  const count = bookPageCount(book);
  if (count === 0) return { payload: null, droppedImages: 0 };

  const idx = clampBookPage(book, pageIndex);
  const chapter: AuthoredBookChapter = book.chapters[idx];
  const { body, images, dropped } = rewriteBookBodyImages(chapter.body, chapter.images, bucketBase);

  const payload: DocPayload = {
    title: chapter.title || book.title,
    pages: [],
    page: idx,
    book: { title: chapter.title, body, images },
  };

  return { payload, droppedImages: dropped };
}
