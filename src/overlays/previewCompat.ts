// Studio PREVIEW compatibility — the PURE "which of my saved materials can fill
// THIS slot" filter, shared by web + mobile so the local feel-it-out preview (and
// the live serve panel) agree on what's droppable where without re-deriving the
// rule per platform.
//
// The rule mirrors the live two-slot split (see overlays/target.ts):
//   • a DOC slot  accepts RENDERABLE docs/images  (a paged/synced document).
//   • an OVERLAY slot accepts PARTICIPATION overlays (poll / quiz / vote-button).
// A material that can't render live (a supplementary attachment) is never offered;
// an authored overlay never lands in a doc slot and vice-versa.
//
// Inputs are intentionally MINIMAL shapes (just the fields the rule reads), so a
// caller can pass either its rich material metadata or an authored-overlay blob
// without this module depending on the web data layer. Pure — no DOM, no store.

import type { OverlayKind } from './types';
import type { LayoutItemType } from '../layout/types';

/** The slot kinds a preview material can be dropped into (mirrors the live model:
 *  doc → a synced document; overlay → a participation widget). */
export type PreviewSlotType = Extract<LayoutItemType, 'doc' | 'overlay'>;

/** The minimal shape of a saved doc/image material the compat rule reads. */
export interface PreviewMaterialLike {
  /** Renderable (a PDF/image we can show live) vs a download-only attachment. */
  kind: 'renderable' | 'supplementary';
  mime?: string;
  filename?: string;
}

/** The minimal shape of an authored participation overlay the compat rule reads. */
export interface PreviewOverlayLike {
  kind: OverlayKind;
}

/** Is a saved material compatible with a DOC slot? True only for a RENDERABLE
 *  (image/PDF) material — a supplementary attachment has no live doc render. */
export function isDocPreviewCompatible(m: PreviewMaterialLike): boolean {
  return m.kind === 'renderable';
}

/** Is an authored overlay compatible with an OVERLAY (participation) slot? True for
 *  the interactive participation kinds (poll/quiz/vote-button); a `doc`/`svg`/`gift`
 *  blob is not a participation widget and never fills an overlay slot here. */
export function isOverlayPreviewCompatible(o: PreviewOverlayLike): boolean {
  return o.kind === 'poll' || o.kind === 'quiz' || o.kind === 'vote-button';
}

/** Filter a candidate list to those compatible with `slotType`. Generic over the
 *  caller's row shape: pass a `pick` that extracts the minimal compat shape from
 *  each candidate, get back the candidates (in order) that fit the slot.
 *   • doc slot     → keep RENDERABLE materials (use pickMaterial)
 *   • overlay slot → keep poll/quiz/vote overlays (use pickOverlay)
 *  Pure — returns a new array, never mutates. */
export function compatibleForSlot<T>(
  slotType: PreviewSlotType,
  candidates: readonly T[],
  pick:
    | { kind: 'doc'; material: (c: T) => PreviewMaterialLike }
    | { kind: 'overlay'; overlay: (c: T) => PreviewOverlayLike },
): T[] {
  if (slotType === 'doc') {
    if (pick.kind !== 'doc') return [];
    return candidates.filter((c) => isDocPreviewCompatible(pick.material(c)));
  }
  if (pick.kind !== 'overlay') return [];
  return candidates.filter((c) => isOverlayPreviewCompatible(pick.overlay(c)));
}
