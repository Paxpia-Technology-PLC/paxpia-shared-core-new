// BOOKS — the wire model for a written book rendered live, one chapter at a
// time. See docs/GO-LIVE-REBUILD-PLAN.md §4/§10.
//
// A book is authored IN the app (`useCoursesStore`'s `BookBlock`), not an
// uploaded file — chapters of markdown + inline pictures. Its pictures start as
// device-local paths, which no other device can fetch; the platform layer
// (`Paxpia-mobile/src/features/books/*`) uploads them and resolves short-lived
// urls per serve, and hands this module the result as an `AuthoredBook`. This
// module owns the ONE rule that matters: a picture ships only if another device
// can fetch it — everything else (course storage, upload, grants) is platform.

/** One picture referenced by a chapter, as the platform resolved it. `url` is
 *  present only when a fetchable copy exists (an uploaded + granted material);
 *  absent means the platform couldn't resolve it (not uploaded yet, or the grant
 *  failed) — the payload builder drops it and counts it rather than shipping a
 *  dead `file://` reference nobody else can load. */
export interface AuthoredBookImage {
  /** The AUTHORING uri (device-local `file://`/`content://`, or already-portable
   *  `http(s)`/`data`) — used to match this image against its inline markdown
   *  reference in the chapter body. */
  uri: string;
  /** A directly-fetchable url, when one is available. */
  url?: string;
  caption?: string;
}

export interface AuthoredBookChapter {
  id: string;
  title: string;
  /** Markdown source, in the SAME dialect `@paxpia/ui/book`'s `MarkdownView`
   *  renders — inline pictures are `![caption](uri)` on their own line. */
  body: string;
  images: AuthoredBookImage[];
}

export interface AuthoredBook {
  id: string;
  title: string;
  author?: string;
  chapters: AuthoredBookChapter[];
}

/** A picture on a `BookPage`, already resolved to a fetchable url. Carried for
 *  counts/thumbnails only — the SAME picture already appears inline in `body`
 *  (rewritten by `rewriteBookBodyImages`), so a renderer must not draw this
 *  list too or every plate would show twice. */
export interface BookPageImage {
  url: string;
  caption?: string;
}

/** ONE chapter's worth of a book, ready to ride `scene.sync` as a `DocPayload`
 *  data packet. A whole illustrated book would not fit in one packet — turning
 *  the page re-serves the next chapter (the same shape the slide path already
 *  uses, so no new director machinery is needed). Pagination (which chapter,
 *  how many) rides the doc payload's own generic `page` field — this is just
 *  the one chapter's content. */
export interface BookPage {
  title: string;
  /** Chapter markdown with inline pictures already rewritten to resolved urls
   *  (see `rewriteBookBodyImages`) — the renderer draws this directly. */
  body: string;
  images: BookPageImage[];
}

/** True when a picture uri is ALREADY reachable without an upload — a real
 *  http(s) url, or a self-contained `data:` uri. Anything device-local
 *  (`file://`, `content://`, `ph://`, `assets-library://`) or a same-device-only
 *  `blob:` needs uploading first. */
export function isPortableBookImage(uri: string): boolean {
  return /^(https?:|data:)/i.test(uri);
}
