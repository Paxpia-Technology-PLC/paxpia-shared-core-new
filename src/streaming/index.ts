// Full streaming surface (incl. the legacy flat producer model Scene/SceneInput/
// InputKind) is available via the `@paxpia/core/streaming` subpath. The TOP-level
// barrel (src/index.ts) intentionally re-exports only the consumer-composition
// pieces from here so the canonical `Scene` is the richer one from `layout/`.
export * from './types';
// The two-slot live model + live-sync wire + scene-assignment model. These names
// don't collide with the layout barrel, so the top-level index re-exports them.
export * from './live';
// The FULL-REPLACE scene-overlay model + scene-sync wire: a scene switch carries
// the COMPLETE overlay set (per-scene rects + payloads) and the viewer replaces its
// whole overlay layer (no deltas → no remnants, never a centered/default snap).
export * from './scene';
// The live VIEWER state machine (connecting → preloading → live → ended) + the
// in-memory preload cache contract. Web + RN are thin render layers over these.
export * from './viewer';
export * from './preload';
// The VIEWER-ENTRY GATE: the ordered fetch-manifest → preload → THEN-connect state
// machine the room connection hangs on, so the manifest can never race the media
// (the mobile "PC manager closed / stale PNG" fix). Distinct from viewer.ts's
// IN-ROOM lifecycle — this gates ENTRY, before any connect.
export * from './entry';
// The PRE-JOIN PREP machine: a CLOCKLESS state machine driven by the room-LISTING
// manifest (v1), run BEFORE connect — release background media → settle/yield beat
// → preload docs → hold a min-floor → ready. deriveManifest builds the manifest the
// producer publishes; createEntryPrep gates the viewer's connect. Web + RN share it.
export * from './prep';
// The DOC-RENDER MODEL: turns a synced `doc` overlay + the manifest into a render
// PLAN (image / pdf / placeholder) so web + RN pick the SAME path; only the leaf
// primitive (canvas vs WebView/native) differs.
export * from './docRender';
// The DOC VIEWPORT MATH: pure zoom-at-point / clamp-scale / clamp-pan helpers the
// doc/image viewer uses so wheel/pinch zoom (centred on the cursor) + arrow/drag
// pan are identical on web (DocOverlay) and mobile (DocPdfRenderer).
export * from './docViewport';
// The UNIFIED room-join handshake: canonical viewer Room/connect options (the
// adaptiveStream-off churn fix, made the single source of truth), the
// connect/reuse/defer-teardown reconciler (focus-blip vs real navigation), the
// viewer-identity invariants (own-stream-as-viewer never collides), and the
// muted-on-open resolution from a cached preference. Web + RN share ALL of it.
export * from './join';
// The doc-viewer LOCAL TAKEOVER state machine (follow ⇄ takeover + resync, with
// scene changes absolute / doc-source changes deferrable). Web + RN share it.
export * from './docTakeover';
// The CONNECTION LIFECYCLE: a cancellable connect-generation guard + the benign-
// error classifier (incl. "PC manager is closed") so a teardown/room-switch/
// unmount that races an in-flight connect is SWALLOWED, never surfaced. The second
// half of the "PC manager closed" fix — pairs with join.ts (connect decision) +
// entry.ts (manifest gate). Web + RN classify the same set of strings.
export * from './connection';
// PUBLIC streamer identity (username/displayName/avatar) for live-room + feed
// tiles, and the shared CDN-snippet PREVIEW state machine (refresh/back-off/
// in-flight). Web + RN render layers are thin shells over these.
export * from './identity';
export * from './preview';
// EPHEMERAL LIVE CHAT: the flat LiveComment model, the ring-buffer reducer + cap,
// and the reliable-data-track wire (CHAT_TOPIC). A viewer publishes a chat.msg;
// the streamer dashboard AND every viewer fold it through appendComment. No
// backend — fan-out only. Web + RN share the model + encode/decode.
export * from './chat';
// LIVE VIEWERS: derive a LiveViewer from a room participant (identity → user id;
// neutral guest until enriched from their chat profile), the gifter-pinned /
// newest-first ordering helper, the deposit-bump, and the P1.6 stage-interactivity
// SCAFFOLD (raise-hand/invite/opt-in/promote types + topic + no-op handler).
export * from './viewers';
