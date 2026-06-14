// Full streaming surface (incl. the legacy flat producer model Scene/SceneInput/
// InputKind) is available via the `@paxpia/core/streaming` subpath. The TOP-level
// barrel (src/index.ts) intentionally re-exports only the consumer-composition
// pieces from here so the canonical `Scene` is the richer one from `layout/`.
export * from './types';
