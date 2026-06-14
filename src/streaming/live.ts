// Live two-slot model + live-sync wire — the platform-agnostic core of Paxpia's
// PRODUCER ⇄ VIEWER live session. Web authors this and the future React Native
// app reuses it verbatim (types + pure reducers only; no DOM, no LiveKit).
//
// ── Why two slots (the key model) ────────────────────────────────────────────
// A live session shows AT MOST one DOC (image/PDF) and AT MOST one participation
// OVERLAY (poll / quiz / vote-button) AT THE SAME TIME. They are INDEPENDENT: a
// streamer can have a slide up AND a poll running over it. So the live state is
// two slots, never one "active" instance:
//   • activeDoc     — kind 'doc' only.
//   • activeOverlay — kind poll / quiz / vote-button only.
// `slotForKind(kind)` routes any pushable to exactly one slot, so a poll can
// never land in the doc slot and an image can never land in the overlay slot.
//
// ── Why a separate live-sync wire ────────────────────────────────────────────
// The server overlay bot (services/overlays) is authoritative for ONE
// participation overlay (it aggregates votes) and we do NOT change it. But the
// bot has no concept of (a) a SECOND simultaneous doc slot or (b) which SCENE the
// streamer has selected. So the streamer client broadcasts those two facts over
// the SAME LiveKit data topic using ADDITIVE message types the bot ignores
// (its decoder returns null for unknown `t`). Late joiners catch up because the
// streamer re-broadcasts the full live-sync snapshot when a participant connects.
//
// RN PORTABILITY: everything here is serializable model + pure functions. The
// mobile app imports the identical reducers; only the transport binding (LiveKit
// data channel) and the rendering differ per platform.

import type { OverlayInstance, OverlayKind } from '../overlays/types';

/** Which slot a renderable kind occupies. `doc` → the document slot; every
 *  participation kind (poll/quiz/vote-button) → the overlay slot. `svg`/`gift`
 *  are treated as overlay-slot too (they're not docs). */
export type LiveSlot = 'doc' | 'overlay';

/** Route an overlay kind to its slot. The ONE place the doc-vs-overlay split is
 *  decided, so producer + viewer always agree. */
export function slotForKind(kind: OverlayKind): LiveSlot {
  return kind === 'doc' ? 'doc' : 'overlay';
}

/** The two independent live slots. Either or both may be populated. */
export interface LiveSlots {
  /** The live document (image/PDF), or null. Carries its own synced page. */
  activeDoc: OverlayInstance | null;
  /** The live participation overlay (poll/quiz/vote), or null. */
  activeOverlay: OverlayInstance | null;
}

/** A fresh, empty pair of slots. */
export function emptySlots(): LiveSlots {
  return { activeDoc: null, activeOverlay: null };
}

/** Place an instance into the slot its kind routes to, leaving the other slot
 *  untouched. Pure — returns a new LiveSlots. This is the producer/viewer's
 *  `activate`: a doc replaces the doc slot only, a poll the overlay slot only. */
export function setSlot(slots: LiveSlots, inst: OverlayInstance): LiveSlots {
  return slotForKind(inst.kind) === 'doc'
    ? { ...slots, activeDoc: inst }
    : { ...slots, activeOverlay: inst };
}

/** Clear one slot (close). Pure. */
export function clearSlot(slots: LiveSlots, slot: LiveSlot): LiveSlots {
  return slot === 'doc' ? { ...slots, activeDoc: null } : { ...slots, activeOverlay: null };
}

/** Clear BOTH slots — used when a stream ends so viewers wipe doc + overlay. */
export function clearAllSlots(): LiveSlots {
  return emptySlots();
}

/** Read the instance currently in a slot (or null). */
export function slotInstance(slots: LiveSlots, slot: LiveSlot): OverlayInstance | null {
  return slot === 'doc' ? slots.activeDoc : slots.activeOverlay;
}

// ── Live-sync wire (web-broadcast; the Go bot ignores these `t` values) ───────

/** Wire version for the live-sync envelope (independent of the overlay wire). */
export const LIVESYNC_WIRE_VERSION = 1;

/** Broadcast the full doc-slot + selected-scene snapshot. The streamer sends this
 *  on every doc change / scene switch AND replays it whenever a participant joins,
 *  so a late viewer reconstructs the doc slot (incl. its current page) and renders
 *  the correct scene layout. The participation overlay slot is NOT carried here —
 *  it's owned by the server bot's overlay.changed/request_state replay. */
export interface LiveSyncMsg {
  t: 'live.sync';
  v: number;
  /** The scene the streamer currently has selected (drives the layout mirror).
   *  null/undefined ⇒ no scene info (viewer falls back to its local default). */
  sceneId?: string | null;
  /** The full active scene definition, so a viewer that doesn't share the
   *  producer's persisted store can still render the exact layout. */
  scene?: LiveScene | null;
  /** The live document instance (kind 'doc'), or null when no doc is shown.
   *  Carries payload.page so the late joiner lands on the streamer's page. */
  doc: OverlayInstance | null;
}

/** A minimal, serializable scene snapshot ridden over the wire so viewers render
 *  the producer's exact layout without sharing its store. Mirrors layout/Scene
 *  but kept local to avoid a hard import cycle through the layout barrel. */
export interface LiveScene {
  id: string;
  name: string;
  items: LiveSceneItem[];
}
export interface LiveSceneItem {
  id: string;
  type: 'camera' | 'screen' | 'overlay' | 'doc';
  rect: { x: number; y: number; w: number; h: number };
  z: number;
  fit: 'contain' | 'cover';
  ref?: string;
  label?: string;
}

/** Any live-sync message a client publishes. (Only one type today; kept as a
 *  union so adding e.g. a viewer-presence ping later is non-breaking.) */
export type LiveSyncWireMsg = LiveSyncMsg;

/** True if a decoded object is a live-sync envelope. Used by the channel to
 *  separate live-sync packets from overlay packets on the shared topic. */
export function isLiveSyncMsg(obj: unknown): obj is LiveSyncMsg {
  return !!obj && typeof obj === 'object' && (obj as { t?: unknown }).t === 'live.sync';
}

/** Encode a live-sync message to UTF-8 JSON bytes for the data channel. Uses the
 *  same TextEncoder feature-detection contract as the overlay wire so it runs on
 *  web + RN/Hermes without pulling lib.dom into this package. */
export function encodeLiveSyncMsg(msg: LiveSyncWireMsg): Uint8Array {
  const withV = { ...msg, v: (msg as { v?: number }).v ?? LIVESYNC_WIRE_VERSION };
  const json = JSON.stringify(withV);
  const g = globalThis as unknown as { TextEncoder?: new () => { encode(s: string): Uint8Array } };
  if (g.TextEncoder) return new g.TextEncoder().encode(json);
  const out = new Uint8Array(json.length);
  for (let i = 0; i < json.length; i++) out[i] = json.charCodeAt(i) & 0xff;
  return out;
}

/** Decode bytes into a live-sync message, or null if they aren't one (so an
 *  overlay packet or foreign payload on the shared topic is safely ignored). */
export function decodeLiveSyncMsg(bytes: Uint8Array): LiveSyncWireMsg | null {
  const g = globalThis as unknown as { TextDecoder?: new () => { decode(b: Uint8Array): string } };
  let json: string;
  if (g.TextDecoder) json = new g.TextDecoder().decode(bytes);
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
  return isLiveSyncMsg(obj) ? (obj as LiveSyncMsg) : null;
}

// ── Scene-assignment model (which scenes a scheduled class may run) ───────────
// A scheduled class carries the IDS of the producer scenes it's allowed to run
// live. The streamer hot-swaps among exactly these during the class — there is NO
// implicit "default" scene; the visible output is purely
// (selected assigned scene) × (activeDoc / activeOverlay / inputs the scene places).

/** A class's scene assignment: the ordered list of scene ids it can run live. The
 *  first id is the one a run STARTS on (not a privileged "default" — just the
 *  initial selection; the streamer can switch immediately). */
export interface SceneAssignment {
  /** Scene ids (from the producer scenes store) this class may hot-swap between. */
  sceneIds: string[];
}

/** Add a scene id to an assignment (no duplicates). Pure. */
export function assignScene(a: SceneAssignment, sceneId: string): SceneAssignment {
  return a.sceneIds.includes(sceneId) ? a : { sceneIds: [...a.sceneIds, sceneId] };
}

/** Remove a scene id from an assignment. Pure. */
export function unassignScene(a: SceneAssignment, sceneId: string): SceneAssignment {
  return { sceneIds: a.sceneIds.filter((id) => id !== sceneId) };
}

/** The scene id a run should START on, given an assignment and the scenes that
 *  actually still exist. Returns the first assigned-and-existing id, or null when
 *  the class has no usable assigned scene. */
export function initialSceneId(a: SceneAssignment | undefined, existingIds: readonly string[]): string | null {
  if (!a) return null;
  return a.sceneIds.find((id) => existingIds.includes(id)) ?? null;
}
