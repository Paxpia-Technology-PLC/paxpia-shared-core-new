// DIRECTOR LOGIC — the PURE bits of the producer-direction brain, extracted so they
// are unit-testable with no transport, no media, no compositor (no React, no store).
//
// These are the exact decisions `Paxpia-web/src/store/live.ts` made inline:
//   • vote-aggregation reconciliation (which inbound overlay echo / results tick the
//     streamer adopts — the P0.2 streamer-authoritative + never-regress-gen guards),
//   • serve-to-slot target resolution (explicit-drag vs auto-resolve, scene-scoped),
//   • the scene-switch doc rebuild (rebuild the live doc slot from the NEW scene's
//     served-doc fill),
//   • snapshot/projection helpers (LiveScene snapshot, currentSceneSlots, the
//     deriveManifest item projection).
//
// PURE: no DOM/RN/livekit-client; only `@paxpia/core` siblings + plain data.

import { slotForKind, type LiveScene, type LiveSceneItem } from '../streaming/live';
import type { DocPayload, OverlayInstance } from '../overlays/types';
import { isEpubEntry } from '../streaming/preload';
import type { DeriveSceneItem } from '../streaming/prep';
import { type OverlaySlot, resolveOverlayTarget, sceneSlots } from '../overlays/target';
import type { LayoutItemType, Scene } from '../layout/types';

/** The per-scene served-doc map (sceneId → itemId → live doc instance). */
export type ServedDocs = Record<string, Record<string, OverlayInstance>>;

/** Snapshot a producer Scene into the wire `LiveScene` shape (so a viewer renders
 *  the exact layout without sharing the producer store). Mirrors web
 *  `snapshotActiveScene`'s mapping. Pure. */
export function snapshotScene(scene: Scene): LiveScene {
  const items: LiveSceneItem[] = scene.items.map((it) => ({
    id: it.id,
    type: it.type,
    rect: it.rect,
    z: it.z,
    fit: it.fit,
    ref: it.ref,
    label: it.label,
  }));
  return { id: scene.id, name: scene.name, items };
}

/** The CURRENT scene's overlay/doc slots (as the resolver sees them), with `filled`
 *  reflecting the per-scene served-doc fills. Participation slots stay always-empty
 *  for resolution (the bot owns one global poll; a serve targets the overlay slot
 *  regardless of a prior poll). Mirrors web `currentSceneSlots`. Pure. */
export function currentSceneSlots(scene: Scene, servedDocs: ServedDocs): OverlaySlot[] {
  const filledDocItems = servedDocs[scene.id] ?? {};
  const items: { id: string; type: LayoutItemType; z: number }[] = scene.items.map((it) => ({
    id: it.id,
    type: it.type,
    z: it.z,
  }));
  // sceneSlots marks doc slots filled when a served doc occupies them; overlay slots
  // stay empty so a poll always finds the overlay slot to (re)serve into.
  const docAssign: Record<string, { kind: 'doc'; ref: string }> = {};
  for (const itemId of Object.keys(filledDocItems)) docAssign[itemId] = { kind: 'doc', ref: itemId };
  return sceneSlots(scene.id, items, { [scene.id]: docAssign });
}

/** Resolve the OVERLAY-slot target a participation serve (poll/quiz/vote) lands on
 *  in the current scene. Explicit drag (`itemId`) wins — but only when it's an
 *  OVERLAY-type slot in this scene; else the pure scene-scoped resolver (empty
 *  matching → most-recent → NO-OP). Returns null on a no-op. Mirrors web
 *  `serveOverlayToSlot`'s target math. Pure. */
export function resolveOverlayServeTarget(
  slots: readonly OverlaySlot[],
  kind: 'poll' | 'quiz' | 'vote-button' | 'doc',
  itemId: string | undefined,
): string | null {
  if (itemId) return slots.find((s) => s.id === itemId && s.type === 'overlay')?.id ?? null;
  return resolveOverlayTarget(slots, kind, undefined).targetId;
}

/** Resolve the DOC-slot target a material serve lands on in the current scene.
 *  Explicit drag (`itemId`) wins — but only when it's a DOC-type slot in this scene;
 *  else auto-resolve. Returns null on a no-op. Mirrors web `serveMaterialToSlot`'s
 *  target math. Pure. */
export function resolveDocServeTarget(
  slots: readonly OverlaySlot[],
  itemId: string | undefined,
): string | null {
  if (itemId) return slots.find((s) => s.id === itemId && s.type === 'doc')?.id ?? null;
  return resolveOverlayTarget(slots, 'doc', undefined).targetId;
}

/** The doc-slot host item id for the active participation overlay in a scene — the
 *  FIRST overlay-type item in draw order, or null when there's no overlay slot / no
 *  live overlay. The single mapping `broadcastScene` + `publishManifest` share.
 *  Pure. */
export function overlaySlotHostId(
  scene: LiveScene,
  activeOverlay: OverlayInstance | null,
): string | null {
  if (!activeOverlay || activeOverlay.kind === 'doc') return null;
  return (
    [...scene.items].filter((it) => it.type === 'overlay').sort((a, b) => a.z - b.z)[0]?.id ?? null
  );
}

/** The `fillFor` builder `buildRenderedScene` consumes: a doc slot is filled from the
 *  per-scene served docs; the overlay-slot host is filled from the live
 *  `activeOverlay`. Mirrors web `broadcastScene`'s fill closure. Pure. */
export function sceneFillFor(
  sceneId: string,
  servedDocs: ServedDocs,
  activeOverlay: OverlayInstance | null,
  overlaySlotId: string | null,
): (itemId: string, type: 'doc' | 'overlay') => OverlayInstance | null {
  const sceneDocs = servedDocs[sceneId] ?? {};
  return (itemId, type) => {
    if (type === 'doc') return sceneDocs[itemId] ?? null;
    return overlaySlotId && itemId === overlaySlotId ? activeOverlay : null;
  };
}

/** Project a LiveScene + its fills into the `deriveManifest` item shape: doc slots
 *  from the per-scene served docs (with first-page URL + pdf/image/epub kind),
 *  overlay slot host from the live participation overlay. Mirrors web
 *  `publishManifest`'s item projection. Pure. */
export function deriveSceneItems(
  scene: LiveScene,
  servedDocs: ServedDocs,
  activeOverlay: OverlayInstance | null,
  overlaySlotId: string | null,
): DeriveSceneItem[] {
  const sceneDocs = servedDocs[scene.id] ?? {};
  return scene.items.map((it): DeriveSceneItem => {
    if (it.type === 'doc') {
      const inst = sceneDocs[it.id];
      if (!inst) return { type: 'doc' };
      const p = inst.payload as DocPayload;
      // EPUB ships with EMPTY pages[]; detect it FIRST off the source MIME/filename so
      // it routes to the epub leaf rather than being misclassified as a single image.
      const isEpub = isEpubEntry({ mime: p.sourceMime ?? '', filename: p.sourceUrl ?? '' });
      const isPdf = !isEpub && (p.pages?.length ?? 0) > 1;
      return {
        type: 'doc',
        instanceId: inst.id,
        // The viewer-resolvable SOURCE url (presigned), not pages[0] (a local blob).
        docUrl: p.sourceUrl ?? p.pages?.[0],
        docKind: isEpub ? 'epub' : isPdf ? 'pdf' : 'image',
        ...(isPdf ? { docPages: p.pages.length } : {}),
      };
    }
    if (it.type === 'overlay') {
      return overlaySlotId && it.id === overlaySlotId && activeOverlay
        ? { type: 'overlay', instanceId: activeOverlay.id, overlayType: activeOverlay.kind }
        : { type: 'overlay' };
    }
    return { type: it.type } as DeriveSceneItem;
  });
}

/** The live doc slot a scene SWITCH lands on — the first served-doc fill in the new
 *  scene, or null when the new scene has none. Mirrors web's scenes-subscription
 *  rebuild (`Object.values(sceneDocs)[0] ?? null`). Pure. */
export function docForSceneSwitch(sceneId: string, servedDocs: ServedDocs): OverlayInstance | null {
  const sceneDocs = servedDocs[sceneId] ?? {};
  return Object.values(sceneDocs)[0] ?? null;
}

// ── Vote-aggregation reconciliation (P0.2 streamer-authoritative) ─────────────

/** The decision an inbound overlay.changed echo drives, given the producer's local
 *  state. The streamer OWNS which overlay is live; an echo may only advance the SAME
 *  id's gen — never flash the slot back to a superseded overlay. Mirrors web
 *  `onChanged`'s guard ladder. */
export type OverlayChangedDecision =
  | { action: 'ignore' }
  | { action: 'clear' } // bot cleared + streamer has no local selection → drop + rebroadcast
  | { action: 'adopt'; overlay: OverlayInstance }; // accept the echo into the slot

/** Reconcile an inbound participation-overlay echo against the producer's state.
 *  PURE — returns the decision; the caller applies it (set state + rebroadcast).
 *
 *   • echo null (bot cleared): honor ONLY when the streamer has no local selection
 *     AND a prev overlay exists (a clear must not yank a just-chosen overlay).
 *   • non-overlay kind: ignore (defensive — the bot only knows participation kinds).
 *   • streamer has a local selection for a DIFFERENT id: ignore (never flash back).
 *   • same id but the echo's gen REGRESSES: ignore (never regress gen).
 *   • else adopt. */
export function reconcileOverlayChanged(
  echo: OverlayInstance | null,
  prev: OverlayInstance | null,
  localOverlayId: string | null,
): OverlayChangedDecision {
  if (!echo) {
    if (prev && localOverlayId === null) return { action: 'clear' };
    return { action: 'ignore' };
  }
  if (slotForKind(echo.kind) !== 'overlay') return { action: 'ignore' };
  if (localOverlayId !== null && echo.id !== localOverlayId) return { action: 'ignore' };
  if (prev && prev.id === echo.id && echo.gen < prev.gen) return { action: 'ignore' };
  return { action: 'adopt', overlay: echo };
}

/** Reconcile an inbound `overlay.results` tick against the producer's active overlay.
 *  When our locally-activated overlay still carries a STALE local gen for THIS id,
 *  adopt the bot's authoritative gen (so the results filter stops discarding valid
 *  tallies — the "votes never reach the dashboard" root cause). Mirrors web
 *  `onResults`'s adopt logic. PURE — returns whether to adopt + the bumped gen. */
export function reconcileResultsGen(
  active: OverlayInstance | null,
  resultsOverlayId: string,
  resultsGen: number,
): { adopt: boolean; gen: number } {
  const adopt = !!active && active.id === resultsOverlayId && resultsGen > active.gen;
  return { adopt, gen: resultsGen };
}
