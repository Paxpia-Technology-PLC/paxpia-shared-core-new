// Teaching-session domain — the SHARED model for Creator-Pro / educator teaching
// sessions (curriculum, materials, resources, checklists). Lifted verbatim from
// the mobile `features/premium/sessions` so the web educator studio and the
// coming mobile creator studio author ONE shape and can never drift.
//
// Pure data — NO React, NO zustand. The presentation tables (status colors,
// material/resource icons) stay per-platform; only the domain lives here.
//
// Maps onto the director producer brain (@paxpia/core/director): a session's
// `materials` become DirectorMaterial / LiveManifest entries and a session
// "go live" maps onto DirectorSession.serveMaterialToSlot — see
// paxpia-docs/RECOVER-PREMIUM-MIGRATION-2026-06-24.md §4.1 / Wave 4.

export type SessionStatus = 'draft' | 'scheduled' | 'live' | 'completed';

export type MaterialKind = 'pdf' | 'image' | 'document';

export type ResourceType = 'website' | 'youtube' | 'article' | 'reference';

export type CurriculumCategory =
  | 'academic'
  | 'religious'
  | 'skill'
  | 'business'
  | 'personal'
  | 'custom';

export interface CurriculumItem {
  id: string;
  category: CurriculumCategory;
  /** Free-text label, only meaningful when `category === 'custom'`. */
  customCategory?: string;
  title: string;
  description?: string;
  /** 0-based position; kept dense by the curriculum helpers. */
  order: number;
}

export interface LearningMaterial {
  id: string;
  kind: MaterialKind;
  title: string;
  /** Local/remote URI once a real picker is wired (optional today). */
  uri?: string | null;
}

export interface ExternalResource {
  id: string;
  type: ResourceType;
  title: string;
  url: string;
}

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

export interface TeachingSession {
  id: string;
  title: string;
  description: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** 24h time (HH:MM). */
  time: string;
  durationMins: number;
  capacity: number;
  notes: string;
  status: SessionStatus;
  materials: LearningMaterial[];
  resources: ExternalResource[];
  teachingChecklist: ChecklistItem[];
  materialsChecklist: ChecklistItem[];
  /** Lesson curriculum/outline — the branch's Creator-Pro add. */
  curriculum: CurriculumItem[];
  createdAt: string;
  updatedAt: string;
}
