export * from './types';
export * from './lifecycle';
export * from './wire';
export * from './svg';
export * from './whiteboard';
export * from './svgSanitize';
export * from './svgAnimate';
export * from './svgClock';
export * from './consume';
export * from './target';
export * from './previewCompat';
// COMPILER-ENFORCED overlay lifecycle (Contract v2.4): the per-kind `OverlayModule`
// contract + its type maps, the per-kind modules, and the EXHAUSTIVE typed registry
// (`OVERLAY_MODULES` / `overlayModule`). The registry compiling IS the enforcement —
// a new kind or a missing callback is a compile error.
export * from './module';
export * from './registry';
export { docModule } from './kinds/doc';
export { whiteboardModule, wbViewPersistKey } from './kinds/whiteboard';
export {
  pollModule,
  quizModule,
  voteButtonModule,
  PARTICIPATION_KINDS,
} from './kinds/participation';
export { svgModule } from './kinds/svg';
export { giftModule, GIFT_WIRE_VERSION, GIFT_FEED_CAP } from './kinds/gift';
