// @paxpia/core/books — a written book rendered live, one chapter at a time.
// Narrow subpath, no React: pure logic + the `DocPayload` wire shape (see
// types.ts / payload.ts headers).

export type { AuthoredBook, AuthoredBookChapter, AuthoredBookImage, BookPage, BookPageImage } from './types';
export { isPortableBookImage } from './types';

export {
  bookPageCount,
  buildBookDocPayload,
  clampBookPage,
  rewriteBookBodyImages,
  type BuiltBookDocPayload,
} from './payload';
