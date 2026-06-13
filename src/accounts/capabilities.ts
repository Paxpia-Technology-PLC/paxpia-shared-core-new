// Capability gating — every gated action in the product, resolved in ONE place.
// Web + mobile both call `can(account, capability)`; adding a feature means
// adding a capability + wiring it into `capabilitiesFor`, so the two platforms
// can't drift on who's allowed to do what.
import { Account, isEducator, isPremium } from './types';

export type Capability =
  // ── streaming — every account ──
  | 'stream.go_live' // phone/web go-live (record + publish)
  | 'stream.filters' // camera filters/effects
  // ── overlays — FREE for everyone (the "fun" plane) ──
  | 'overlay.games' // collaborative games (e.g. two-sided vote button)
  | 'overlay.gifts' // gift toasts
  // ── overlays — EDUCATOR only (the "education" plane) ──
  | 'overlay.poll'
  | 'overlay.quiz'
  | 'overlay.doc' // synced document presentation
  | 'overlay.whiteboard'
  // ── dashboard / course planning — EDUCATOR only ──
  | 'dashboard.access'
  | 'dashboard.scenes' // scene/layout editor + multi-input (webcam + screen)
  | 'dashboard.schedule' // calendar + scheduled streams + queue manager
  | 'dashboard.materials' // document uploads
  | 'dashboard.quizzes' // quiz authoring
  | 'dashboard.members' // view paying members / super-followers
  // ── stream types — EDUCATOR only (start simple: a class, a paid class) ──
  | 'stream.private' // private streams to community/super-followers
  | 'stream.paid_class'
  // ── moderation / admin ──
  | 'admin.approve_educator'
  | 'moderation.tools';

const EDUCATOR_CAPS: Capability[] = [
  'overlay.poll',
  'overlay.quiz',
  'overlay.doc',
  'overlay.whiteboard',
  'dashboard.access',
  'dashboard.scenes',
  'dashboard.schedule',
  'dashboard.materials',
  'dashboard.quizzes',
  'dashboard.members',
  'stream.private',
  'stream.paid_class',
];

const BASELINE_CAPS: Capability[] = [
  'stream.go_live',
  'stream.filters',
  'overlay.games',
  'overlay.gifts',
];

/** The full capability set for an account. */
export function capabilitiesFor(a: Account): Set<Capability> {
  const caps = new Set<Capability>(BASELINE_CAPS);
  if (isEducator(a)) for (const c of EDUCATOR_CAPS) caps.add(c);
  if (a.grants.includes('moderator')) caps.add('moderation.tools');
  if (a.grants.includes('admin')) {
    caps.add('admin.approve_educator');
    caps.add('moderation.tools');
  }
  // Premium (non-educator) currently unlocks no education features — those are
  // educator-gated by design. Reserved for future premium-only perks.
  void isPremium;
  return caps;
}

export function can(a: Account, cap: Capability): boolean {
  return capabilitiesFor(a).has(cap);
}

/** Can this account reach the educator dashboard at all (web + mobile)? */
export function canAccessDashboard(a: Account): boolean {
  return can(a, 'dashboard.access');
}
