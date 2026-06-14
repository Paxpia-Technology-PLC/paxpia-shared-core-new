// Full streaming surface (incl. the legacy flat producer model Scene/SceneInput/
// InputKind) is available via the `@paxpia/core/streaming` subpath. The TOP-level
// barrel (src/index.ts) intentionally re-exports only the consumer-composition
// pieces from here so the canonical `Scene` is the richer one from `layout/`.
export * from './types';
// The two-slot live model + live-sync wire + scene-assignment model. These names
// don't collide with the layout barrel, so the top-level index re-exports them.
export * from './live';
