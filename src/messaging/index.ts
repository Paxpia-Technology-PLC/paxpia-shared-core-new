// @paxpia/core/messaging — the DM / group-chat domain. Platform-free wire types +
// pure convergence reducers + the REST/WS transport seams + a headless React
// binding. The rn-web views live in @paxpia/ui/messaging; the fetch + WebSocket
// impl is per-platform behind `MessagingApi` + the socket factory.
export * from './types';
export * from './store';
export * from './client';
export * from './hooks';
