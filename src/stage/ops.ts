// STAGE reducers + the compiler that turns a `StageSpec` into a `Scene` (the
// SAME wire format the director/compositor/every viewer already speak). Pure,
// no RN/DOM — mirrors `@paxpia/core/layout`'s reducer style.
//
// IDENTITY DISCIPLINE: every reducer below returns the exact SAME `StageSpec`
// object when the requested change is a no-op (clamped split unchanged, hiding
// an already-hidden camera, etc). A caller that republishes + rebroadcasts on
// every write depends on this — see `Paxpia-mobile/src/live/session/sessionStore.ts`.

import type { KitItem } from '../classes/types';
import type { Scene, LayoutItem, LayoutItemType } from '../layout/types';
import {
  MAX_SPLIT,
  MIN_SPLIT,
  defaultCameraRect,
  type PaneSlotId,
  type PaneSource,
  type Rect,
  type StageSpec,
} from './types';

export type { PaneSlotId, PaneSource, StageSpec, Rect } from './types';
export { MIN_SPLIT, MAX_SPLIT, CAMERA_BUBBLE_W, CAMERA_BUBBLE_H } from './types';

const OTHER: Record<PaneSlotId, PaneSlotId> = { pane_a: 'pane_b', pane_b: 'pane_a' };
const SLOT_ORDER: PaneSlotId[] = ['pane_a', 'pane_b'];

function emptySource(): PaneSource {
  return { kind: 'empty' };
}

function hasContent(source: PaneSource): boolean {
  return source.kind !== 'empty';
}

export function initialStage(): StageSpec {
  // A fresh talking-head stage: no panes, camera visible and full-frame (see
  // `cameraRect`). Deliberately not restored from a prior session — see
  // `sessionStore.beginSession`'s note on why.
  return {
    panes: { pane_a: emptySource(), pane_b: emptySource() },
    split: 0.5,
    camera: { visible: true, rect: defaultCameraRect() },
    fullscreen: null,
  };
}

function clampSplit(split: number): number {
  return Math.max(MIN_SPLIT, Math.min(MAX_SPLIT, split));
}

// ── pane placement ────────────────────────────────────────────────────────────

export function setPane(stage: StageSpec, slot: PaneSlotId, source: PaneSource): StageSpec {
  if (stage.panes[slot] === source) return stage;
  const next: StageSpec = { ...stage, panes: { ...stage.panes, [slot]: source } };
  // A pane that just lost its content can't stay fullscreen (nothing to fill the frame).
  if (!hasContent(source) && stage.fullscreen === slot) next.fullscreen = null;
  return next;
}

export function clearPane(stage: StageSpec, slot: PaneSlotId): StageSpec {
  if (!hasContent(stage.panes[slot])) return stage;
  return setPane(stage, slot, emptySource());
}

export function clearAllPanes(stage: StageSpec): StageSpec {
  if (!hasContent(stage.panes.pane_a) && !hasContent(stage.panes.pane_b)) return stage;
  return { ...stage, panes: { pane_a: emptySource(), pane_b: emptySource() }, fullscreen: null };
}

/** Put content in the first sensible pane: the first EMPTY slot, or — when both
 *  are occupied — the LOWER pane (`pane_b`), so what's being taught from (the
 *  top pane) stays put. Returns the slot it went to so the caller can serve the
 *  content to the right item id. */
export function addToStage(stage: StageSpec, source: PaneSource): { stage: StageSpec; slot: PaneSlotId } {
  const target = !hasContent(stage.panes.pane_a) ? 'pane_a' : !hasContent(stage.panes.pane_b) ? 'pane_b' : 'pane_b';
  return { stage: setPane(stage, target, source), slot: target };
}

// ── split + swap + fullscreen ─────────────────────────────────────────────────

export function setSplit(stage: StageSpec, split: number): StageSpec {
  const clamped = clampSplit(split);
  if (clamped === stage.split) return stage;
  return { ...stage, split: clamped };
}

export function resetSplit(stage: StageSpec): StageSpec {
  return setSplit(stage, 0.5);
}

export function swapPanes(stage: StageSpec): StageSpec {
  const next: StageSpec = { ...stage, panes: { pane_a: stage.panes.pane_b, pane_b: stage.panes.pane_a } };
  if (stage.fullscreen) next.fullscreen = OTHER[stage.fullscreen];
  return next;
}

export function toggleFullscreen(stage: StageSpec, slot: PaneSlotId): StageSpec {
  if (!hasContent(stage.panes[slot])) return stage;
  return { ...stage, fullscreen: stage.fullscreen === slot ? null : slot };
}

export function exitFullscreen(stage: StageSpec): StageSpec {
  if (stage.fullscreen === null) return stage;
  return { ...stage, fullscreen: null };
}

// ── camera bubble ─────────────────────────────────────────────────────────────

export function setCameraVisible(stage: StageSpec, visible: boolean): StageSpec {
  if (stage.camera.visible === visible) return stage;
  return { ...stage, camera: { ...stage.camera, visible } };
}

export function toggleCamera(stage: StageSpec): StageSpec {
  return setCameraVisible(stage, !stage.camera.visible);
}

function clampCameraRect(r: Rect): Rect {
  return {
    x: Math.max(0, Math.min(1 - r.w, r.x)),
    y: Math.max(0, Math.min(1 - r.h, r.y)),
    w: r.w,
    h: r.h,
  };
}

export function setCameraRect(stage: StageSpec, rect: Rect): StageSpec {
  const clamped = clampCameraRect(rect);
  const cam = stage.camera;
  if (cam.rect.x === clamped.x && cam.rect.y === clamped.y && cam.rect.w === clamped.w && cam.rect.h === clamped.h) {
    return stage;
  }
  return { ...stage, camera: { ...cam, rect: clamped } };
}

export function moveCameraBy(stage: StageSpec, dx: number, dy: number): StageSpec {
  if (dx === 0 && dy === 0) return stage;
  const { rect } = stage.camera;
  return setCameraRect(stage, { ...rect, x: rect.x + dx, y: rect.y + dy });
}

/** Snap the bubble to its nearest corner after a drag ends — the D6 "corner
 *  snapping" behaviour. A no-op reducer otherwise (the drag itself already
 *  committed the live position via `setCameraRect`/`moveCameraBy`). */
export function releaseCameraDrag(stage: StageSpec): StageSpec {
  const { rect } = stage.camera;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const nearestX = cx < 0.5 ? 0.03 : 1 - rect.w - 0.03;
  const nearestY = cy < 0.5 ? 0.03 : 1 - rect.h - 0.03;
  return setCameraRect(stage, { ...rect, x: nearestX, y: nearestY });
}

// ── derived geometry (the SAME functions the compiled scene used) ────────────

/** Slots with content, in stable (`pane_a` then `pane_b`) order. */
export function visiblePanes(stage: StageSpec): PaneSlotId[] {
  return SLOT_ORDER.filter((slot) => hasContent(stage.panes[slot]));
}

/** Each visible pane's normalized rect. Stacked top (`pane_a`) / bottom
 *  (`pane_b`) per D4; a `fullscreen` pane takes the whole frame alone. Empty
 *  when there are no visible panes (the camera is the frame then — see
 *  `cameraRect`). */
export function paneRects(stage: StageSpec): Partial<Record<PaneSlotId, Rect>> {
  if (stage.fullscreen && hasContent(stage.panes[stage.fullscreen])) {
    return { [stage.fullscreen]: { x: 0, y: 0, w: 1, h: 1 } };
  }
  const panes = visiblePanes(stage);
  if (panes.length === 0) return {};
  if (panes.length === 1) return { [panes[0]]: { x: 0, y: 0, w: 1, h: 1 } };
  const split = clampSplit(stage.split);
  return {
    pane_a: { x: 0, y: 0, w: 1, h: split },
    pane_b: { x: 0, y: split, w: 1, h: 1 - split },
  };
}

/** The camera's normalized rect, or null when hidden. The camera can NEVER
 *  black out the class: with no panes up it is the only thing on screen, so it
 *  stays full-frame regardless of `visible` — only the floating BUBBLE (once
 *  panes exist) can actually be hidden. */
export function cameraRect(stage: StageSpec): Rect | null {
  if (visiblePanes(stage).length === 0) return { x: 0, y: 0, w: 1, h: 1 };
  if (!stage.camera.visible) return null;
  return stage.camera.rect;
}

// ── labels + kit integration ──────────────────────────────────────────────────

export function paneSourceLabel(source: PaneSource): string {
  switch (source.kind) {
    case 'empty':
      return 'Empty';
    case 'material':
      return source.material.filename || 'Document';
    case 'book':
      return 'Book';
    case 'whiteboard':
      return 'Whiteboard';
    case 'screen':
      return 'Screen';
    default:
      return '';
  }
}

/** Convert a kit item into what it shows on the stage, or null when it has
 *  nothing to show yet (an unresolved module reading). Overlay items (polls/
 *  quizzes) never reach here — they overlay the stage rather than fill a pane;
 *  callers branch on `kind === 'overlay'` before calling this. */
export function paneSourceForKitItem(item: KitItem): PaneSource | null {
  switch (item.kind) {
    case 'material':
      return { kind: 'material', material: item.material };
    case 'module':
      return item.material ? { kind: 'material', material: item.material } : null;
    case 'book':
      return { kind: 'book', courseId: item.courseId, moduleId: item.moduleId, blockId: item.blockId };
    case 'whiteboard':
      return { kind: 'whiteboard' };
    case 'overlay':
      return null;
    default:
      return null;
  }
}

// ── compile → Scene ────────────────────────────────────────────────────────────

function paneItemType(source: PaneSource): LayoutItemType {
  if (source.kind === 'whiteboard') return 'whiteboard';
  if (source.kind === 'screen') return 'screen';
  return 'doc'; // material | book — both ride the shared doc-serve pipeline.
}

/** Compile the current stage into the ONE live scene. Pure — `sceneId` is the
 *  caller's constant scene id (so served content survives every recompile);
 *  `name` defaults to a neutral label since a session never authors one. */
export function compileStage(stage: StageSpec, sceneId: string, name = 'Live'): Scene {
  const items: LayoutItem[] = [];
  const rects = paneRects(stage);
  let z = 0;

  for (const slot of visiblePanes(stage)) {
    const rect = rects[slot];
    if (!rect) continue; // fullscreen mode hides the sibling pane entirely
    const source = stage.panes[slot];
    items.push({
      id: slot,
      type: paneItemType(source),
      rect,
      z: z++,
      fit: 'contain',
    });
  }

  const cam = cameraRect(stage);
  if (cam) {
    items.push({
      id: 'cam_pip',
      type: 'camera',
      rect: cam,
      // Floating PiP draws over the panes; when it's the full-frame talking-head
      // shot there's nothing under it anyway, so the z is moot either way.
      z: items.length,
      fit: 'cover',
    });
  }

  return { id: sceneId, name, items };
}
