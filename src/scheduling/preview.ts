// SCHEDULING preview helper — build a static, non-live OverlayInstance from an
// authored overlay blob (the inline poll/quiz/vote the tutor built). Used by the
// authoring modal's live preview + anywhere a non-live render of an authored
// overlay is needed. Platform-agnostic (no renderer here — the renderer differs
// per app); it just wraps the blob as an `active` gen-0 instance with empty
// results so a renderer can paint it.

import type { OverlayInstance } from '../overlays';
import type { AuthoredKind, AuthoredPayload, TimelineOverlay } from './types';

/** A previewable overlay instance: an `active`, gen-0 instance with empty results
 *  and the fixed id `'preview'`. Carries the authored payload type for the caller. */
export type PreviewOverlayInstance = OverlayInstance<AuthoredPayload> & {
  id: 'preview';
  kind: AuthoredKind;
  phase: 'active';
  gen: 0;
};

/** Build a previewable OverlayInstance from an authored overlay blob. The caller
 *  supplies the kind/title/payload; we wrap it as an `active` gen-0 instance with
 *  empty results. The title is carried by the payload itself (poll/quiz question,
 *  doc title), so it isn't needed on the instance. */
export function previewInstance(o: {
  kind: AuthoredKind;
  title: string;
  payload: AuthoredPayload;
}): PreviewOverlayInstance {
  return { id: 'preview', kind: o.kind, phase: 'active', gen: 0, payload: o.payload, results: {} };
}

// Re-export the blob shape under its scheduling alias for callers that build a
// preview directly off a timeline overlay item.
export type { TimelineOverlay };
