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

/** One entry in the room's MATERIAL MANIFEST — the id + size a viewer needs to
 *  show a download-progress bar before it has fetched the bytes, plus the
 *  PRESIGNED GET URL the STREAMER granted so an UNAUTH'd guest (who cannot call
 *  the auth'd /materials/grant) can still fetch the raw file. `pages` is the count
 *  for a PDF (drives a per-page render estimate); absent/1 for an image. */
export interface ManifestEntry {
  /** Material id (stable key for the in-memory preload cache, matches doc ids). */
  id: string;
  /** Display filename (slides.pdf, diagram.png …). */
  filename: string;
  /** MIME so the viewer decides image-vs-PDF render path without a HEAD. */
  mime: string;
  /** Raw size in bytes — the denominator for an honest progress bar. */
  sizeBytes: number;
  /** PDF page count when known (image ⇒ 1/absent). */
  pageCount?: number;
  /** Short-lived presigned GET URL the STREAMER granted for this material. The
   *  guest fetches THIS (it never hits the auth'd grant endpoint). Absent only if
   *  the streamer couldn't grant it (the viewer then renders video-only). */
  url?: string;
}

/** The room's material manifest: every material the running class may show, with
 *  the presigned URLs + total size so a viewer preloads ALL of them behind a
 *  gated progress screen BEFORE entering. The STREAMER assembles this (it owns the
 *  auth'd grant call) and broadcasts it over the data channel — this is what lets
 *  an UNAUTH'd guest get the same preloaded experience. */
export interface LiveManifest {
  entries: ManifestEntry[];
  totalSizeBytes: number;
  count: number;
}

/** The STABLE identity of a manifest asset for dedupe/preload caching — the URL's
 *  ORIGIN + PATH only, with the query string (and fragment) STRIPPED.
 *
 *  Presigned CDN/object-storage URLs carry short-lived `?token=…&X-Amz-…` query
 *  params that the streamer RE-GRANTS on every scene/manifest broadcast, so the
 *  SAME underlying file arrives with a DIFFERENT full URL each time. A viewer that
 *  keys assets on the full URL therefore treats every re-grant as a BRAND-NEW asset
 *  → it re-preloads + the doc/image overlay reloads in a loop (the reported
 *  doc/audio boot-loop). Keying on the path (the object key) is stable across
 *  re-grants, so a re-broadcast of the same material is recognized as already-warm.
 *
 *  PURE + DOM-free (manual scheme/host/path split, no URL ctor — runs on Hermes).
 *  Falls back to the trimmed raw string when there's no `?` to strip. */
export function manifestAssetKey(url: string | undefined | null): string {
  if (!url) return '';
  const raw = String(url).trim();
  if (raw === '') return '';
  // Drop the fragment first, then the query string — the object key is everything
  // before the first '?' (and before any '#'). We intentionally keep scheme+host+
  // path so two different buckets/paths never collide.
  const noFrag = raw.split('#', 1)[0];
  const noQuery = noFrag.split('?', 1)[0];
  return noQuery;
}

/** Dedupe manifest entries by their query-stripped asset key, keeping the FIRST
 *  occurrence of each path (so a re-granted duplicate of an already-listed file is
 *  dropped). Entries with the same `id` are also collapsed (a re-broadcast of the
 *  same material id). Entries with NO url are keyed by id so they aren't lost.
 *  PURE — returns a new array; preserves order. This is what lets the viewer's
 *  preload + first-render dedupe a manifest whose presigned urls changed query
 *  params on a re-grant, killing the reload loop. */
export function dedupeManifestEntries(entries: ManifestEntry[]): ManifestEntry[] {
  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();
  const out: ManifestEntry[] = [];
  for (const e of entries) {
    // Collapse a re-broadcast of the same material id outright.
    if (seenIds.has(e.id)) continue;
    // Collapse a re-granted duplicate of the same file (same path, new query).
    const path = e.url ? manifestAssetKey(e.url) : '';
    if (path && seenPaths.has(path)) continue;
    if (path) seenPaths.add(path);
    seenIds.add(e.id);
    out.push(e);
  }
  return out;
}

/** A manifest with its entries deduped by query-stripped asset key (see
 *  `dedupeManifestEntries`). `count` + `totalSizeBytes` are recomputed off the
 *  deduped set so the preload progress denominator matches what's actually warmed.
 *  Returns the SAME instance when nothing was a duplicate (stable identity for
 *  React deps). Null/undefined passes through unchanged. PURE. */
export function dedupeManifest(m: LiveManifest | null | undefined): LiveManifest | null {
  if (!m) return m ?? null;
  const entries = dedupeManifestEntries(m.entries);
  if (entries.length === m.entries.length) return m; // nothing dropped → same ref
  return {
    entries,
    count: entries.length,
    totalSizeBytes: entries.reduce((sum, e) => sum + (e.sizeBytes || 0), 0),
  };
}

/** How a doc is laid out: a single server-synced page (prev/next) vs the whole
 *  document as one continuous scroll. Lives in the synced presenter state so a
 *  streamer's mode mirrors to every viewer (web + mobile share the SAME control). */
export type DocViewMode = 'single' | 'scroll';

/** The PRESENTER's transform on the active doc — the page (already synced via the
 *  doc instance) PLUS the pan/zoom the streamer is showing, so a joiner lands on
 *  EXACTLY the streamer's view (then may locally adjust). Normalized so it's
 *  resolution-independent: `zoom` is a scale ≥1; `panX`/`panY` are the translation
 *  in CSS px at zoom (mirrors the renderer's offset).
 *
 *  BACKWARD COMPATIBLE: `mode`/`scrollPos` are OPTIONAL — an old presenter struct
 *  (no mode field) reads as `mode:'single', scrollPos:0` via `docViewModeOf` /
 *  `docScrollPosOf` below, so a V1 streamer still drives a V2 viewer. */
export interface DocPresenterState {
  /** Synced page index (redundant with doc.payload.page; carried for clarity).
   *  In scroll mode this is DERIVED from scrollPos (the page at the viewport top). */
  page: number;
  /** Zoom scale (1 = fit). */
  zoom: number;
  /** Pan offset in px (renderer's translate(x,y)). */
  panX: number;
  panY: number;
  /** The active view mode — the streamer's single/scroll toggle, mirrored to viewers.
   *  Optional for wire back-compat (absent ⇒ 'single'). */
  mode?: DocViewMode;
  /** Scroll-mode position as a NORMALIZED "pages-as-float" coordinate (e.g. 4.5 =
   *  halfway down page index 4). Resolution-independent so a 1080p streamer and a
   *  720p phone land on the same logical position. Absent ⇒ 0. */
  scrollPos?: number;
}

/** Read the view mode off a (possibly V1) presenter struct, defaulting to 'single'.
 *  The single place the back-compat default lives so web + mobile agree. */
export function docViewModeOf(p: DocPresenterState | null | undefined): DocViewMode {
  return p?.mode === 'scroll' ? 'scroll' : 'single';
}

/** Read the normalized scroll position off a (possibly V1) presenter struct (0 when
 *  absent / not in scroll mode). */
export function docScrollPosOf(p: DocPresenterState | null | undefined): number {
  const v = p?.scrollPos;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Broadcast the full doc-slot + selected-scene snapshot. The streamer sends this
 *  on every doc change / scene switch AND replays it whenever a participant joins,
 *  so a late viewer reconstructs the doc slot (incl. its current page + the
 *  presenter's pan/zoom) and renders the correct scene layout. The participation
 *  overlay slot is NOT carried here — it's owned by the server bot's
 *  overlay.changed/request_state replay.
 *
 *  It ALSO carries the room's MATERIAL MANIFEST (ids + sizes + presigned URLs) so
 *  an UNAUTH'd guest, who can't call the auth'd grant endpoint, still has
 *  everything to preload behind the gate and render docs. */
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
  /** The presenter's pan/zoom on the active doc (so a joiner mirrors the streamer's
   *  view, not just the page). Absent ⇒ fit/no-pan default. */
  docPresenter?: DocPresenterState | null;
  /** The room's material manifest (ids + sizes + presigned URLs). Present on the
   *  go-live announce + every participant-join replay so a guest can preload +
   *  render materials. Absent ⇒ this stream has no materials (no preload gate). */
  manifest?: LiveManifest | null;
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
  // Mirrors @paxpia/core LayoutItemType (kept inline to avoid a layout-barrel import
  // cycle); 'whiteboard' is a first-class positionable scene source (see layout/types).
  type: 'camera' | 'screen' | 'overlay' | 'doc' | 'whiteboard';
  rect: { x: number; y: number; w: number; h: number };
  z: number;
  fit: 'contain' | 'cover';
  ref?: string;
  label?: string;
}

/** Does a synced scene place at least one VIDEO source (a camera/screen tile)? The
 *  in-room authoritative answer to "should the viewer expect a video track?" — fed to
 *  the track-recovery `expectVideo` so an audio+doc-only scene (no camera/screen item)
 *  never triggers the "reconnecting video" hint. A null scene carries no signal →
 *  false (we only assert video when a scene positively places a camera/screen). PURE. */
export function sceneHasVideoSource(scene: LiveScene | null | undefined): boolean {
  if (!scene) return false;
  return scene.items.some((it) => it.type === 'camera' || it.type === 'screen');
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
