// Pure curriculum logic — the add/remove/reorder operations the mobile
// CurriculumManager runs inline today, lifted here so the SAME logic backs the
// web educator studio and (later) a server-side curriculum endpoint. Every
// function returns a NEW array and keeps `order` dense + position-aligned, so a
// persisted curriculum with gaps/dupes self-heals on the next edit.
import type { CurriculumItem } from './types';

/** Re-number `order` to match array position (0-based), sharing refs for items
 *  already at their index so callers can cheaply diff. */
function renumber(items: CurriculumItem[]): CurriculumItem[] {
  return items.map((it, i) => (it.order === i ? it : { ...it, order: i }));
}

/** Sort by `order`, then normalize positions — defensive against legacy data. */
export function normalizeCurriculum(items: CurriculumItem[]): CurriculumItem[] {
  return renumber([...items].sort((a, b) => a.order - b.order));
}

/** Append an item to the end; its `order` is forced to the new last position. */
export function addCurriculumItem(
  items: CurriculumItem[],
  item: Omit<CurriculumItem, 'order'>,
): CurriculumItem[] {
  return [...items, { ...item, order: items.length }];
}

/** Remove the item with `id` and re-number the remainder. */
export function removeCurriculumItem(
  items: CurriculumItem[],
  id: string,
): CurriculumItem[] {
  return renumber(items.filter((it) => it.id !== id));
}

/** Patch fields on the item with `id` (id + order are not patchable here). */
export function updateCurriculumItem(
  items: CurriculumItem[],
  id: string,
  patch: Partial<Omit<CurriculumItem, 'id' | 'order'>>,
): CurriculumItem[] {
  return items.map((it) => (it.id === id ? { ...it, ...patch } : it));
}

/** Move the item at index `from` to index `to`, re-numbering `order`. Out-of-range
 *  or no-op moves return the input unchanged (same ref). */
export function reorderCurriculum(
  items: CurriculumItem[],
  from: number,
  to: number,
): CurriculumItem[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  ) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return renumber(next);
}
