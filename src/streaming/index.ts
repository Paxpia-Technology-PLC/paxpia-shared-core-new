// Full streaming surface (incl. the legacy flat producer model Scene/SceneInput/
// InputKind) is available via the `@paxpia/core/streaming` subpath. The TOP-level
// barrel (src/index.ts) intentionally re-exports only the consumer-composition
// pieces from here so the canonical `Scene` is the richer one from `layout/`.
export * from './types';
// The two-slot live model + live-sync wire + scene-assignment model. These names
// don't collide with the layout barrel, so the top-level index re-exports them.
export * from './live';
// The live VIEWER state machine (connecting → preloading → live → ended) + the
// in-memory preload cache contract. Web + RN are thin render layers over these.
export * from './viewer';
export * from './preload';
// The doc-viewer LOCAL TAKEOVER state machine (follow ⇄ takeover + resync, with
// scene changes absolute / doc-source changes deferrable). Web + RN share it.
export * from './docTakeover';
// PUBLIC streamer identity (username/displayName/avatar) for live-room + feed
// tiles, and the shared CDN-snippet PREVIEW state machine (refresh/back-off/
// in-flight). Web + RN render layers are thin shells over these.
export * from './identity';
export * from './preview';
