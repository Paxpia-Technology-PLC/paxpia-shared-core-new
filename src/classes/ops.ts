// CLASSES reducers — pure transforms over `ClassesState`. Every function returns
// a NEW value (immutable) and takes no platform dependency, so any store
// (zustand on web/mobile) can delegate to them — mirrors `@paxpia/core/scheduling`.
//
// Functions that MINT ids (`createClass`, `duplicateClass`, `addKitItem`,
// `scheduleSession`) take an `IdGen` so each platform keeps its own scheme.

import type {
  ClassesState,
  ClassVisibility,
  KitItem,
  LiveClass,
  NewKitItem,
  ScheduledSession,
} from './types';
import type { IdGen } from './types';

// ── reads ─────────────────────────────────────────────────────────────────────

export function findClass(state: ClassesState, id: string): LiveClass | null {
  return state.classes.find((c) => c.id === id) ?? null;
}

export function activeClass(state: ClassesState): LiveClass | null {
  return state.activeClassId ? findClass(state, state.activeClassId) : null;
}

/** A nameless class can't be taught (viewers would have nothing to identify it
 *  by) — the one thing that gates "Go live". */
export function canGoLive(cls: LiveClass): boolean {
  return cls.name.trim().length > 0;
}

/** A human label for a kit item, for the "Prepared" list / Creator Tools. */
export function kitItemLabel(item: KitItem): string {
  switch (item.kind) {
    case 'material':
      return item.material.filename || 'Untitled file';
    case 'module':
      return item.label;
    case 'book':
      return item.label;
    case 'whiteboard':
      return item.label;
    case 'overlay':
      return item.overlay.title || (item.overlay.kind === 'quiz' ? 'Quiz' : item.overlay.kind === 'vote-button' ? 'Vote' : 'Poll');
    default:
      return 'Item';
  }
}

// ── internal helpers ──────────────────────────────────────────────────────────

function touchClass(cls: LiveClass): LiveClass {
  return { ...cls, updatedAt: Date.now() };
}

function mapClass(
  classes: LiveClass[],
  id: string,
  fn: (cls: LiveClass) => LiveClass,
): LiveClass[] {
  return classes.map((c) => (c.id === id ? touchClass(fn(c)) : c));
}

function renumberKit(kit: KitItem[]): KitItem[] {
  return kit.map((item, i) => ({ ...item, order: i })) as KitItem[];
}

// ── class CRUD ────────────────────────────────────────────────────────────────

export function createClass(
  state: ClassesState,
  patch: Partial<Pick<LiveClass, 'name' | 'description' | 'visibility'>> | undefined,
  idGen: IdGen,
): { id: string; update: Partial<ClassesState> } {
  const now = Date.now();
  const id = idGen('class');
  const cls: LiveClass = {
    id,
    name: patch?.name ?? 'New class',
    description: patch?.description,
    visibility: patch?.visibility ?? 'public',
    kit: [],
    createdAt: now,
    updatedAt: now,
  };
  return { id, update: { classes: [...state.classes, cls] } };
}

export function renameClass(state: ClassesState, id: string, name: string): Partial<ClassesState> {
  return { classes: mapClass(state.classes, id, (c) => ({ ...c, name })) };
}

export function setClassDescription(
  state: ClassesState,
  id: string,
  description: string,
): Partial<ClassesState> {
  return { classes: mapClass(state.classes, id, (c) => ({ ...c, description })) };
}

export function setClassVisibility(
  state: ClassesState,
  id: string,
  visibility: ClassVisibility,
): Partial<ClassesState> {
  return { classes: mapClass(state.classes, id, (c) => ({ ...c, visibility })) };
}

export function deleteClass(state: ClassesState, id: string): Partial<ClassesState> {
  return {
    classes: state.classes.filter((c) => c.id !== id),
    // Sessions pointing at a deleted class are orphaned — drop them too, or the
    // schedule would show a session for a class that no longer exists.
    sessions: state.sessions.filter((s) => s.classId !== id),
    activeClassId: state.activeClassId === id ? null : state.activeClassId,
  };
}

export function duplicateClass(
  state: ClassesState,
  id: string,
  idGen: IdGen,
): { id: string | null; update: Partial<ClassesState> } {
  const source = findClass(state, id);
  if (!source) return { id: null, update: {} };
  const now = Date.now();
  const newId = idGen('class');
  const copy: LiveClass = {
    ...source,
    id: newId,
    name: `${source.name} copy`,
    kit: source.kit.map((item) => ({ ...item, id: idGen('kit') })) as KitItem[],
    createdAt: now,
    updatedAt: now,
  };
  return { id: newId, update: { classes: [...state.classes, copy] } };
}

export function setActiveClass(_state: ClassesState, id: string | null): Partial<ClassesState> {
  return { activeClassId: id };
}

// ── kit ───────────────────────────────────────────────────────────────────────

export function addKitItem(
  state: ClassesState,
  classId: string,
  item: NewKitItem,
  idGen: IdGen,
): { id: string; update: Partial<ClassesState> } {
  const id = idGen('kit');
  const cls = findClass(state, classId);
  const order = cls ? cls.kit.length : 0;
  const full = { ...item, id, order } as KitItem;
  return {
    id,
    update: { classes: mapClass(state.classes, classId, (c) => ({ ...c, kit: [...c.kit, full] })) },
  };
}

export function removeKitItem(
  state: ClassesState,
  classId: string,
  itemId: string,
): Partial<ClassesState> {
  return {
    classes: mapClass(state.classes, classId, (c) => ({
      ...c,
      kit: renumberKit(c.kit.filter((it) => it.id !== itemId)),
    })),
  };
}

export function moveKitItem(
  state: ClassesState,
  classId: string,
  itemId: string,
  toIndex: number,
): Partial<ClassesState> {
  return {
    classes: mapClass(state.classes, classId, (c) => {
      const from = c.kit.findIndex((it) => it.id === itemId);
      if (from < 0) return c;
      const clampedTo = Math.max(0, Math.min(toIndex, c.kit.length - 1));
      if (clampedTo === from) return c;
      const next = [...c.kit];
      const [moved] = next.splice(from, 1);
      next.splice(clampedTo, 0, moved);
      return { ...c, kit: renumberKit(next) };
    }),
  };
}

export function updateKitItem(
  state: ClassesState,
  classId: string,
  itemId: string,
  patch: Partial<KitItem>,
): Partial<ClassesState> {
  return {
    classes: mapClass(state.classes, classId, (c) => ({
      ...c,
      kit: c.kit.map((it) => (it.id === itemId ? ({ ...it, ...patch } as KitItem) : it)),
    })),
  };
}

// ── sessions ──────────────────────────────────────────────────────────────────

export function scheduleSession(
  state: ClassesState,
  classId: string,
  startUnix: number,
  idGen: IdGen,
): { id: string | null; update: Partial<ClassesState> } {
  if (!findClass(state, classId)) return { id: null, update: {} };
  const id = idGen('sess');
  const session: ScheduledSession = { id, classId, startUnix };
  return { id, update: { sessions: [...state.sessions, session] } };
}

export function unscheduleSession(state: ClassesState, sessionId: string): Partial<ClassesState> {
  return { sessions: state.sessions.filter((s) => s.id !== sessionId) };
}

export function rescheduleSession(
  state: ClassesState,
  sessionId: string,
  startUnix: number,
): Partial<ClassesState> {
  return {
    sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, startUnix } : s)),
  };
}

/** Sessions that haven't started yet (a small grace window covers a session that
 *  just started but is still "upcoming" for display), soonest first. */
const UPCOMING_GRACE_MS = 5 * 60 * 1000;

export function upcomingSessions(state: ClassesState, nowUnix: number): ScheduledSession[] {
  return state.sessions
    .filter((s) => s.startUnix >= nowUnix - UPCOMING_GRACE_MS)
    .sort((a, b) => a.startUnix - b.startUnix);
}

export function nextSessionFor(
  state: ClassesState,
  classId: string,
  nowUnix: number,
): ScheduledSession | null {
  return upcomingSessions(state, nowUnix).find((s) => s.classId === classId) ?? null;
}
