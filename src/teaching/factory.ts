// Pure factories + domain constants for teaching sessions. NO theme, NO store —
// the mobile `sessions/constants.ts` keeps the presentation tables (STATUS_META
// colors, MATERIAL_KINDS / RESOURCE_TYPES icons) that couple to its palette; the
// platform-agnostic pieces (the empty-session factory + the default checklists +
// the status ORDER) live here so web + mobile build identical sessions.
import type { ChecklistItem, SessionStatus, TeachingSession } from './types';

/** Canonical status progression (used for ordering/columns by both clients). */
export const SESSION_STATUS_ORDER: SessionStatus[] = [
  'draft',
  'scheduled',
  'live',
  'completed',
];

export const DEFAULT_TEACHING_CHECKLIST: string[] = [
  'Define learning objectives',
  'Prepare lesson outline',
  'Rehearse key explanations',
  'Plan interactive activities',
  'Test camera & microphone',
];

export const DEFAULT_MATERIALS_CHECKLIST: string[] = [
  'Slides ready',
  'Reference docs uploaded',
  'Worksheets attached',
  'Backup links saved',
];

/** Deterministic checklist from labels (stable ids; no randomness). */
export function makeChecklist(labels: string[]): ChecklistItem[] {
  return labels.map((label, i) => ({
    id: `c_${i}_${label.slice(0, 6)}`,
    label,
    done: false,
  }));
}

/** A fresh draft session. `id` + `now` are supplied by the caller (store/server)
 *  so the factory stays pure — no `Date.now()` / uuid inside. */
export function createEmptySession(id: string, now: string): TeachingSession {
  return {
    id,
    title: '',
    description: '',
    date: '',
    time: '',
    durationMins: 60,
    capacity: 30,
    notes: '',
    status: 'draft',
    materials: [],
    resources: [],
    teachingChecklist: makeChecklist(DEFAULT_TEACHING_CHECKLIST),
    materialsChecklist: makeChecklist(DEFAULT_MATERIALS_CHECKLIST),
    curriculum: [],
    createdAt: now,
    updatedAt: now,
  };
}
