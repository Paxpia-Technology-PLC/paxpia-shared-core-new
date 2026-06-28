// @paxpia/core/feed — the WATCH (VOD / short-form) feed domain. Platform-free post
// model + mapper + the `FeedApi` transport seam + headless React bindings. The
// fetch impl lives per-platform; the rn-web video grid + watch feed live in
// @paxpia/ui/feed. Distinct from the streaming/live-room model.
export * from './types';
export * from './client';
export * from './hooks';
