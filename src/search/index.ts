// @paxpia/core/search — unified search domain (accounts + content + DMs).
// Platform-free result model + the `SearchApi` transport seam + a client-side DM
// scan + a headless React binding. The fetch impl lives per-platform; the rn-web
// search bar + results UI live in @paxpia/ui/search.
export * from './types';
export * from './client';
export * from './hooks';
