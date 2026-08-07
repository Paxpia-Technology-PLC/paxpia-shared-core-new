// FULL-REPLACE scene-overlay model — the pure brain behind "a scene switch renders
// ONLY the new scene's overlays at their per-scene positions, with zero remnant of
// the previous scene and never a centered/default snap".
//
// ── The bug this fixes (P0.3) ────────────────────────────────────────────────
// The old viewer held two INDEPENDENT slots (activeDoc + activeOverlay) and drew
// each at the FIRST matching item rect, falling back to a CENTERED default. So:
//   • a scene-1 doc could persist into scene 2 (the doc slot wasn't cleared on a
//     scene switch — only doc-pushes cleared it), leaving a remnant; and
//   • an overlay with no matching slot in the new scene snapped to a centered box.
//
// The fix is a DIFFERENT shape: each scene change carries the COMPLETE overlay set
// for the new scene — every overlay/doc slot, with its per-scene normalized rect
// and its payload — and the viewer does an IDEMPOTENT FULL REPLACE of its overlay
// layer (clear everything, render exactly the new set). A late or missed message
// then cannot leave a remnant: the next full snapshot re-establishes the exact
// current scene. There is no merge/delta, so there is nothing to desync.
//
// Positions come ONLY from the per-scene authored rects carried on the wire; this
// model NEVER invents a centered/default rect. A slot with no rect is simply not
// rendered (the producer always sends a rect for a real slot).
//
// ── What lives here vs per-platform ──────────────────────────────────────────
// Shared (this module): the rendered-overlay shape, the FULL-REPLACE reducer, the
// wire message that carries a complete scene, the encode/decode, and the builders
// that turn (a LiveScene + its slot fills + the bot's participation overlay) into a
// flat rendered set. Per-platform: only the DOM/RN rendering of each entry at its
// rect. Web + mobile import the identical reducer, so they can never diverge.

import type { OverlayInstance, OverlayKind } from '../overlays/types';
import type { Rect } from '../layout/types';
import type { LiveScene, LiveSceneItem } from './live';

/** One overlay/doc the viewer should paint, with WHERE (per-scene rect + z) and
 *  WHAT (the live instance, or null for an empty authored slot the viewer skips).
 *  `itemId` is the scene's layout-item id — the stable key the full-replace reducer
 *  diffs on, and the slot a served material/overlay fills. */
export interface SceneOverlay {
  /** The scene layout-item id this overlay occupies (stable render key). */
  itemId: string;
  /** doc → the doc slot; every participation kind → an overlay slot; whiteboard →
   *  its OWN first-class slot (a placed board is not a doc and not a participation
   *  overlay — it is its own placeable kind, carried to viewers by `scene.sync`). */
  type: 'doc' | 'overlay' | 'whiteboard';
  /** The per-scene normalized rect (0..1) the producer authored for this slot.
   *  The viewer paints here verbatim — never a centered/default fallback. */
  rect: Rect;
  /** Draw order (higher on top). */
  z: number;
  /** The live overlay instance filling this slot, or null when the authored slot is
   *  currently empty (the viewer renders nothing for a null instance). */
  instance: OverlayInstance | null;
}

/** The COMPLETE overlay layer for ONE scene — the unit of FULL REPLACE. `sceneId`
 *  identifies the scene; `nonce` strictly increases per producer so the viewer can
 *  ignore an out-of-order/stale snapshot (idempotent convergence). `overlays` is
 *  the entire set the viewer must render — applying it REPLACES the whole layer. */
export interface RenderedScene {
  sceneId: string | null;
  /** Monotonic per-producer sequence; a higher nonce supersedes a lower one. */
  nonce: number;
  overlays: SceneOverlay[];
}

/** The empty rendered scene — nothing painted (pre-snapshot / stream ended). */
export function emptyRenderedScene(): RenderedScene {
  return { sceneId: null, nonce: 0, overlays: [] };
}

/** FULL-REPLACE reducer: adopt `next` as the viewer's ENTIRE overlay layer, with
 *  zero carry-over from `prev`. Idempotent + monotonic:
 *   • a STALE snapshot (next.nonce < prev.nonce) is ignored — keeps the layer.
 *   • an equal-or-newer snapshot REPLACES the layer wholesale (clear all, render
 *     the new set) — so a previous scene's overlays can never remain.
 *  Pure — returns `prev` unchanged when the snapshot is stale, else a fresh set. */
export function applyFullScene(prev: RenderedScene, next: RenderedScene): RenderedScene {
  // Reject a strictly older snapshot (out-of-order delivery) so we never regress to
  // a previous scene. An equal nonce for the SAME scene is an idempotent re-apply
  // (e.g. a join replay) → adopt it (it's the authoritative current layer).
  if (next.nonce < prev.nonce) return prev;
  // Replace semantics: the returned layer is EXACTLY `next.overlays`, nothing merged.
  return { sceneId: next.sceneId, nonce: next.nonce, overlays: next.overlays };
}

/** Only overlays with a live instance actually paint; this is the render list the
 *  platform maps over (each entry → a positioned box at `rect`). Empty authored
 *  slots (instance null) are dropped here, never rendered. */
export function visibleOverlays(scene: RenderedScene): SceneOverlay[] {
  return scene.overlays.filter((o) => o.instance !== null);
}

/** Look up the rendered entry for a given scene layout-item id (or undefined). */
export function sceneOverlayFor(scene: RenderedScene, itemId: string): SceneOverlay | undefined {
  return scene.overlays.find((o) => o.itemId === itemId);
}

// ── Building a RenderedScene from the producer's authored scene + its fills ────
// The producer holds a LiveScene (layout items + per-item rects) plus, per slot, an
// optional live instance (a served doc, or the bot's participation overlay). This
// builder flattens those into the complete set the wire carries. It is the SINGLE
// place "scene + fills → rendered set" is computed, so producer and viewer agree.

/** The placement slot-types a rendered scene carries: `doc`, `overlay`, and the
 *  first-class `whiteboard` slot (a placed board paints at its own authored rect,
 *  not in the doc or participation slot). The render key the full-replace reducer
 *  diffs on and the `fillFor` callback keys against. */
export type SceneSlotType = SceneOverlay['type'];

/** The slot-type a kind occupies (mirrors target.itemTypeForKind, but kept local so
 *  this module needs no overlay-target import). A `whiteboard` is its OWN slot — it
 *  is placed, not served, so it never lands in the doc or participation slot. */
function slotTypeForKind(kind: OverlayKind): SceneSlotType {
  if (kind === 'doc') return 'doc';
  if (kind === 'whiteboard') return 'whiteboard';
  return 'overlay';
}

/** Build the COMPLETE rendered overlay set for a scene from its authored layout
 *  items + the instance (if any) filling each overlay/doc slot. `fillFor(itemId)`
 *  returns the live instance occupying that slot, or null/undefined when empty.
 *
 *  EVERY overlay/doc/whiteboard layout item becomes a SceneOverlay (so the viewer's
 *  full replace clears any previously-filled slot that is now empty); the rect is the
 *  item's authored per-scene rect — never defaulted. A `whiteboard` item is a
 *  first-class placement: it becomes a `type:'whiteboard'` entry whose `instance` is
 *  the operator's `kind:'whiteboard'` board (filled by `fillFor`), so the director's
 *  authoritative `scene.sync` carries the placed board to viewers — previously a
 *  whiteboard item was silently dropped here (the §0.1 bug). Non-overlay items
 *  (camera/screen) are excluded (they ride the composited video, not this layer). Pure. */
export function buildRenderedScene(
  scene: LiveScene | null,
  nonce: number,
  fillFor: (itemId: string, type: SceneSlotType) => OverlayInstance | null | undefined,
): RenderedScene {
  if (!scene) return { sceneId: null, nonce, overlays: [] };
  const overlays: SceneOverlay[] = [];
  for (const it of scene.items) {
    if (it.type !== 'doc' && it.type !== 'overlay' && it.type !== 'whiteboard' && it.type !== 'slide') continue;
    // A `slide` item is filled + rendered through the SAME `doc` pipeline (it steps
    // through its ordered materials, each served as a normal doc fill) — remap its
    // slot type to 'doc' here so every downstream consumer (which keys off
    // `SceneOverlay.type`, not the raw LayoutItemType) needs no changes of its own.
    const slotType: SceneSlotType = it.type === 'slide' ? 'doc' : it.type;
    const inst = fillFor(it.id, slotType) ?? null;
    overlays.push({ itemId: it.id, type: slotType, rect: it.rect, z: it.z, instance: inst });
  }
  overlays.sort((a, b) => a.z - b.z);
  return { sceneId: scene.id, nonce, overlays };
}

/** Pick the scene layout-item id a live instance should occupy, given the scene's
 *  items + an explicit assignment map (itemId the producer served it into). The
 *  served slot wins; otherwise the FIRST item of the instance's slot type in draw
 *  order is used. Returns null when the scene has no slot of that type — the
 *  instance is then NOT rendered (it has nowhere authored to go; we never center
 *  it). This is the producer-side mapping used to build `fillFor`. Pure. */
export function slotItemForInstance(
  items: readonly LiveSceneItem[],
  inst: Pick<OverlayInstance, 'kind'>,
  servedItemId: string | null | undefined,
): string | null {
  const want = slotTypeForKind(inst.kind);
  if (servedItemId && items.some((i) => i.id === servedItemId && i.type === want)) return servedItemId;
  const ordered = [...items].filter((i) => i.type === want).sort((a, b) => a.z - b.z);
  return ordered.length > 0 ? ordered[0].id : null;
}

// ── Wire message: a COMPLETE scene snapshot (web-broadcast; bot ignores it) ────
// Rides the SAME LiveKit data topic as live-sync + overlay control, RELIABLE +
// ordered (the channel publishes it with {reliable:true}); the Go bot's decoder
// returns null for this unknown `t`, so it's a safe additive message. The viewer
// folds it through applyFullScene → idempotent full replace.

/** Wire version for the scene-replace envelope. */
export const SCENE_WIRE_VERSION = 1;

/** A complete-scene snapshot the producer broadcasts on every scene switch / serve
 *  / participant-join. Carries the ENTIRE rendered overlay set so the viewer can
 *  full-replace its layer (no deltas → no remnants). `nonce` strictly increases so
 *  a late/duplicate packet is idempotent. */
export interface SceneSyncMsg {
  t: 'scene.sync';
  v: number;
  roomName?: string;
  scene: RenderedScene;
}

/** True if a decoded object is a scene-sync envelope. */
export function isSceneSyncMsg(obj: unknown): obj is SceneSyncMsg {
  return !!obj && typeof obj === 'object' && (obj as { t?: unknown }).t === 'scene.sync';
}

// TextEncoder/TextDecoder feature-detection (same contract as the overlay/live-sync
// wires) so this module runs on web + RN/Hermes without pulling lib.dom in.
function te(): { encode(s: string): Uint8Array } | null {
  const g = globalThis as unknown as { TextEncoder?: new () => { encode(s: string): Uint8Array } };
  return g.TextEncoder ? new g.TextEncoder() : null;
}
function td(): { decode(b: Uint8Array): string } | null {
  const g = globalThis as unknown as { TextDecoder?: new () => { decode(b: Uint8Array): string } };
  return g.TextDecoder ? new g.TextDecoder() : null;
}

/** Encode a scene-sync message to UTF-8 JSON bytes for the (reliable) data channel. */
export function encodeSceneSyncMsg(msg: SceneSyncMsg): Uint8Array {
  const withV = { ...msg, v: msg.v ?? SCENE_WIRE_VERSION };
  const json = JSON.stringify(withV);
  const enc = te();
  if (enc) return enc.encode(json);
  const out = new Uint8Array(json.length);
  for (let i = 0; i < json.length; i++) out[i] = json.charCodeAt(i) & 0xff;
  return out;
}

/** Decode bytes into a scene-sync message, or null if they aren't one (so an
 *  overlay/live-sync packet or foreign payload on the shared topic is ignored). */
export function decodeSceneSyncMsg(bytes: Uint8Array): SceneSyncMsg | null {
  const dec = td();
  let json: string;
  if (dec) json = dec.decode(bytes);
  else {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    json = s;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  return isSceneSyncMsg(obj) ? (obj as SceneSyncMsg) : null;
}
