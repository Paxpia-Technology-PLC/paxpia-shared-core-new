// eligibility.ts — the cross-platform GO-LIVE CONTRACT for a scheduled class.
//
// ONE predicate, shared by web + mobile UI (button enable/disable + the goLive guard)
// AND the streaming API, so "can this schedule go live?" has a SINGLE definition that
// can't drift between platforms. The rule (Noel, 2026-06-29): a schedule is streamable
// iff it has at least one candidate scene that carries a real VIDEO SOURCE (a camera or
// screen track). Audio is the always-available mic, so it never gates eligibility.
//
// Why this fixes "only the first class's Go-Live button works": the old check was
// `sceneIds.length > 0`, and a freshly-created class is born with NO assigned scenes
// (`makeScheduledStream` → `sceneIds: []`), so every new class was washed out until you
// hand-toggled a scene. `candidateScenes` below treats "no explicit assignment" as "ALL
// scenes", so any class is immediately streamable against the shared scene pool.

import type { Scene } from '../layout';
import type { ScheduledStream } from './types';

/** A scene carries a live VIDEO SOURCE when it has ≥1 camera or screen item. (doc /
 *  overlay / whiteboard are content layers painted over the video, not a capture.) */
export function sceneHasMediaTrack(scene: Pick<Scene, 'items'>): boolean {
  return scene.items.some((i) => i.type === 'camera' || i.type === 'screen');
}

/** The scenes a class may actually RUN live. A class with EXPLICIT assignments runs
 *  exactly those that still exist; a class with NO explicit assignment (`sceneIds` empty)
 *  defaults to ALL scenes — "no selection = all" — so a freshly-created class is
 *  immediately streamable against the shared scene pool. */
export function candidateScenes(
  stream: Pick<ScheduledStream, 'sceneIds'>,
  scenes: readonly Scene[],
): Scene[] {
  if (stream.sceneIds.length === 0) return [...scenes];
  const set = new Set(stream.sceneIds);
  return scenes.filter((s) => set.has(s.id));
}

/** GO-LIVE CONTRACT: a schedule can go live iff ≥1 of its candidate scenes carries a
 *  video source. Enforced IDENTICALLY on every platform's UI + the streaming API. */
export function canGoLiveSchedule(
  stream: Pick<ScheduledStream, 'sceneIds'>,
  scenes: readonly Scene[],
): boolean {
  return candidateScenes(stream, scenes).some(sceneHasMediaTrack);
}

/** The scene a go-live should START on: the first candidate scene that carries video (so
 *  the stream opens on a scene that actually shows something), else the first candidate
 *  scene, else null. Supersedes `initialSceneId` at the go-live entry so an empty-assignment
 *  class still starts on a real media scene. */
export function goLiveStartSceneId(
  stream: Pick<ScheduledStream, 'sceneIds'>,
  scenes: readonly Scene[],
): string | null {
  const cands = candidateScenes(stream, scenes);
  return (cands.find(sceneHasMediaTrack) ?? cands[0])?.id ?? null;
}
