// PURE producer-scenes model — the store-agnostic reducers behind web's
// `store/scenes.ts` zustand wrapper. Every state transition the scenes store made
// inline now lives here as a pure function over `ScenesState`, so web (zustand) and
// the future mobile store (zustand/MMKV) drive byte-identical behaviour. All
// geometry math still flows through the shared `layout/*` reducers (moveItem /
// resizeItem / bumpZ / …); this file only owns the scene-list + active-scene
// orchestration that used to be web-only.
//
// SHAPE: each reducer returns a `(state) => Partial<ScenesState>` updater (or a
// plain partial), exactly what zustand's `set` accepts — so the web wrapper is a
// thin `set(scenesModel.addScene(...))` delegation with no logic of its own.

import {
  bumpZ,
  makeItem,
  makeScene,
  moveItem,
  moveItemZ,
  reorderZ,
  resizeItem,
  setItemFit,
  type FitMode,
  type LayoutItem,
  type LayoutItemType,
  type Rect,
  type ResizeCorner,
  type Scene,
} from '../layout';
import { defaultIdGen, type IdGen, type ScenesState } from './types';

/** Build the initial scenes state — one fresh empty scene, selected. Mirrors the
 *  web store's constructor (`makeScene(rid('scene'), 'Scene 1')`). */
export function initialScenesState(idGen: IdGen = defaultIdGen): ScenesState {
  const first = makeScene(idGen('scene'), 'Scene 1');
  return { scenes: [first], activeId: first.id };
}

/** Map an item mutation over the ACTIVE scene's items, normalizing z afterward.
 *  (The web store's `mapActiveItems`, lifted verbatim.) */
function mapActiveItems(
  st: ScenesState,
  fn: (items: LayoutItem[]) => LayoutItem[],
): Pick<ScenesState, 'scenes'> {
  return {
    scenes: st.scenes.map((s) => (s.id === st.activeId ? { ...s, items: reorderZ(fn(s.items)) } : s)),
  };
}

/** The active scene (or the first as a fallback). */
export function activeScene(st: ScenesState): Scene {
  return st.scenes.find((s) => s.id === st.activeId) ?? st.scenes[0];
}

/** Options for adding an item — same as the web store's `addItem` opts. */
export interface AddItemOpts {
  ref?: string;
  label?: string;
  rect?: Rect;
  fit?: FitMode;
}

// ── Scene-list reducers ──────────────────────────────────────────────────────

export function addScene(idGen: IdGen = defaultIdGen) {
  return (st: ScenesState): Partial<ScenesState> => {
    const s = makeScene(idGen('scene'), `Scene ${st.scenes.length + 1}`);
    return { scenes: [...st.scenes, s], activeId: s.id };
  };
}

export function removeScene(id: string) {
  return (st: ScenesState): Partial<ScenesState> => {
    if (st.scenes.length <= 1) return st;
    const scenes = st.scenes.filter((s) => s.id !== id);
    return { scenes, activeId: st.activeId === id ? scenes[0].id : st.activeId };
  };
}

export function setActive(id: string): Partial<ScenesState> {
  return { activeId: id };
}

// ── Scene-name rules (enforced UI + API, all platforms) ──────────────────────
/** Max VISIBLE characters in a scene name (Noel, 2026-06-29: 1–12). A scene pill is a
 *  small fixed-width chip, so a long name would overflow the live switcher. */
export const SCENE_NAME_MAX_LEN = 12;

/** Clamp a raw scene-name input to the rules: strip leading/trailing control whitespace
 *  and cap at SCENE_NAME_MAX_LEN. May return '' for an in-progress clear — callers show
 *  the `Scene N` fallback for an empty name. Pure; used by the reducer + the API. */
export function clampSceneName(raw: string): string {
  // Drop newlines/tabs (a name is single-line), keep interior spaces while typing, cap len.
  return raw.replace(/[\r\n\t]+/g, ' ').slice(0, SCENE_NAME_MAX_LEN);
}

/** Whether a committed scene name satisfies the 1..12 rule (non-empty after trim). The
 *  API rejects a name that fails this; the UI uses it to gate a rename commit. */
export function isValidSceneName(name: string): boolean {
  const n = name.trim();
  return n.length >= 1 && n.length <= SCENE_NAME_MAX_LEN;
}

export function renameScene(id: string, name: string) {
  const clean = clampSceneName(name);
  return (st: ScenesState): Partial<ScenesState> => ({
    scenes: st.scenes.map((s) => (s.id === id ? { ...s, name: clean } : s)),
  });
}

export function moveScene(id: string, toIndex: number) {
  return (st: ScenesState): Partial<ScenesState> => {
    const i = st.scenes.findIndex((s) => s.id === id);
    if (i < 0) return st;
    const clamped = Math.max(0, Math.min(toIndex, st.scenes.length - 1));
    if (clamped === i) return st;
    const scenes = [...st.scenes];
    const [moved] = scenes.splice(i, 1);
    scenes.splice(clamped, 0, moved);
    return { scenes };
  };
}

// ── Active-scene item reducers ───────────────────────────────────────────────

/** Add an item to the ACTIVE scene; mints the id with `idGen` and returns BOTH the
 *  updater (for `set`) and the new item's `id` (the caller binds a live stream /
 *  overlay ref to it). Mirrors the web `addItem` (which returned the id). */
export function addItem(
  type: LayoutItemType,
  opts: AddItemOpts | undefined,
  idGen: IdGen = defaultIdGen,
): { id: string; update: (st: ScenesState) => Partial<ScenesState> } {
  const id = idGen('item');
  const update = (st: ScenesState): Partial<ScenesState> =>
    mapActiveItems(st, (items) => [
      ...items,
      makeItem(id, type, items.length, {
        ref: opts?.ref,
        label: opts?.label,
        rect: opts?.rect,
        fit: opts?.fit,
      }),
    ]);
  return { id, update };
}

export function removeItem(itemId: string) {
  return (st: ScenesState): Partial<ScenesState> =>
    mapActiveItems(st, (items) => items.filter((i) => i.id !== itemId));
}

export function moveItemBy(itemId: string, dx: number, dy: number) {
  return (st: ScenesState): Partial<ScenesState> =>
    mapActiveItems(st, (items) => items.map((i) => (i.id === itemId ? moveItem(i, dx, dy) : i)));
}

export function resizeItemBy(itemId: string, corner: ResizeCorner, dx: number, dy: number) {
  return (st: ScenesState): Partial<ScenesState> =>
    mapActiveItems(st, (items) => items.map((i) => (i.id === itemId ? resizeItem(i, corner, dx, dy) : i)));
}

export function setItemFitById(itemId: string, fit: FitMode) {
  return (st: ScenesState): Partial<ScenesState> =>
    mapActiveItems(st, (items) => items.map((i) => (i.id === itemId ? setItemFit(i, fit) : i)));
}

export function bumpItemZ(itemId: string, dir: 'up' | 'down') {
  return (st: ScenesState): Partial<ScenesState> => mapActiveItems(st, (items) => bumpZ(items, itemId, dir));
}

export function moveItemZById(itemId: string, toIndex: number) {
  return (st: ScenesState): Partial<ScenesState> => mapActiveItems(st, (items) => moveItemZ(items, itemId, toIndex));
}
