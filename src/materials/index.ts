// MATERIALS — the private class-materials domain (the `doc` overlay pipeline, v2)
// shared by web + mobile. Types (the RN-portable `MaterialMeta`/`MaterialGrant`/
// `MaterialsManifest` model + the snake_case wire shapes) + the grant/freshness
// logic (`mapGrant`/`grantOne`/`buildManifestEntries`/`getManifest`/…), all over
// an INJECTED platform `fetch` seam (`MaterialsClient`) so the core stays
// neutral (no DOM/RN). The platform layer binds its `fetch` + auth token and owns
// the byte-fetch + render (pdf.js / react-native-pdf).
export type {
  MaterialKind,
  MaterialMeta,
  MaterialGrant,
  MaterialsManifest,
  RawMaterial,
  RawGrant,
} from './types';
export type { FetchLike, MaterialsClient } from './grant';
export {
  mapMaterial,
  mapGrant,
  materialsError,
  listMaterials,
  grantMaterials,
  grantOne,
  getManifest,
  buildManifestEntries,
} from './grant';
