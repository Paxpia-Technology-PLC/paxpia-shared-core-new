// THE TYPED OVERLAY MODULE REGISTRY (Contract v2.4.2) — the SINGLE enforcement point.
//
// `OVERLAY_MODULES` is an EXHAUSTIVE `{ [K in OverlayKind]: OverlayModule<K> }` with NO
// optional members. That mapped type means:
//   • a NEW `OverlayKind` without a module here is a COMPILE error (missing property);
//   • a module missing ANY `OverlayModule` member is a COMPILE error (the value does
//     not satisfy `OverlayModule<K>`);
//   • a module whose callbacks don't match the per-kind type maps (wrong state/delta
//     shape) is a COMPILE error.
// So "forgot to wire the whiteboard's presence / snapshot / resync" can NEVER ship —
// the registry compiling IS the enforcement.
//
// The render-brain, the director, and the viewer drive overlays ONLY through
// `overlayModule(inst.kind)` — never an ad-hoc `if (kind === 'whiteboard')`.

import type { OverlayKind } from './types';
import type { OverlayModule } from './module';
import { docModule } from './kinds/doc';
import { whiteboardModule } from './kinds/whiteboard';
import { pollModule, quizModule, voteButtonModule } from './kinds/participation';
import { svgModule } from './kinds/svg';
import { giftModule } from './kinds/gift';

/** The EXHAUSTIVE registry. The mapped type `{ [K in OverlayKind]: OverlayModule<K> }`
 *  forces every kind to supply a module that satisfies the full per-kind contract —
 *  forgetting a kind or omitting a callback does not type-check. */
export const OVERLAY_MODULES: { [K in OverlayKind]: OverlayModule<K> } = {
  svg: svgModule,
  poll: pollModule,
  'vote-button': voteButtonModule,
  quiz: quizModule,
  doc: docModule,
  gift: giftModule,
  whiteboard: whiteboardModule,
};

/** Resolve a module by kind — total by construction (the registry is exhaustive).
 *  The single dispatch point: callers `overlayModule(kind).applyRemote(...)` etc.
 *  rather than an ad-hoc per-kind branch. */
export function overlayModule<K extends OverlayKind>(kind: K): OverlayModule<K> {
  return OVERLAY_MODULES[kind];
}

/** Every overlay kind, derived from the registry's keys — the single list a test/
 *  consumer iterates to assert exhaustiveness. Typed as `OverlayKind[]`. */
export const OVERLAY_KINDS: OverlayKind[] = Object.keys(OVERLAY_MODULES) as OverlayKind[];
