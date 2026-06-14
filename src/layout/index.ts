// @paxpia/shared-core/layout — the resizable/reorderable scene + inputs + overlay
// LAYOUT MODEL. A normalized (0..1) description of a 9:16 composition plus the
// pure reducers that move/resize/reorder/fit items inside it. Web and React
// Native both import this; only the rendering differs (see per-file RN notes).
export * from './types';
export * from './ops';
export * from './factory';
