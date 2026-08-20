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

// ─── Migration reporting ────────────────────────────────────────────────────────────
//
// One sentence summarising a legacy `scheduled[]` → classes conversion, for the
// banner on the Classes screen. Returns '' when there is nothing worth saying, so
// the caller can render it unconditionally.
//
// The warnings the result carries are already human-readable (they are written by
// the converter, one per thing it could not carry over) — this only decides how
// many to show before collapsing the rest into a count, because a banner listing
// nine of them stops being read.
import type { ClassMigrationResult } from '../studio/sync';

const MIGRATION_WARNINGS_SHOWN = 2;

export function migrationWarning(result: ClassMigrationResult): string {
  const created = result.createdClassIds.length;
  const warnings = result.warnings ?? [];
  if (warnings.length === 0) {
    // A clean conversion is worth confirming once; nothing at all to convert is
    // not news, so it stays silent.
    return created > 0
      ? `Imported ${created} scheduled ${created === 1 ? 'stream' : 'streams'} as classes.`
      : '';
  }
  const shown = warnings.slice(0, MIGRATION_WARNINGS_SHOWN).join(' ');
  const rest = warnings.length - MIGRATION_WARNINGS_SHOWN;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}
