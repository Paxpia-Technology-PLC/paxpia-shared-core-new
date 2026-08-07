// @paxpia/core/classes — durable, reusable teaching units (see types.ts header).
// Narrow subpath, no React: safe for pure-logic modules (mirrors `/scheduling`).

export type {
  ClassesState,
  ClassVisibility,
  IdGen,
  KitBookItem,
  KitItem,
  KitModuleItem,
  KitOverlayItem,
  KitMaterialItem,
  KitWhiteboardItem,
  LiveClass,
  NewKitItem,
  ScheduledSession,
} from './types';
export { initialClassesState } from './types';

export {
  activeClass,
  addKitItem,
  canGoLive,
  createClass,
  deleteClass,
  duplicateClass,
  findClass,
  kitItemLabel,
  moveKitItem,
  nextSessionFor,
  removeKitItem,
  renameClass,
  rescheduleSession,
  scheduleSession,
  setActiveClass,
  setClassDescription,
  setClassVisibility,
  unscheduleSession,
  updateKitItem,
  upcomingSessions,
} from './ops';
