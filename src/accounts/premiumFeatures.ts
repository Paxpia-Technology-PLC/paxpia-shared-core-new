// Premium feature gating — the SHARED bridge between the mobile "Creator Pro"
// feature catalog and the cross-platform capability model (./capabilities).
//
// Two planes meet here, resolved from ONE input so web + mobile gate identically:
//
//   • EDUCATION-plane features (multi-page whiteboard, PDF annotation, classroom
//     analytics, session setup) RIDE an overlay/dashboard CAPABILITY. They require
//     BOTH that capability (the educator grant — the gate to the teaching surface
//     at all) AND an active Creator-Pro subscription (which unlocks the premium
//     tools within that surface). A feature listed in FEATURE_CAPABILITY is
//     education-plane.
//
//   • SELF-TIER perks (HD streaming, co-host, recording, feed scheduling, AI
//     tools, audience insights) are NOT in the map; they unlock purely on an
//     active Creator-Pro subscription (./billing).
//
// GATING MODEL (Noel's call 2026-06-24, RECOVER-PREMIUM-MIGRATION §6): "Educator +
// Creator-Pro". The mobile branch gated EVERY premium feature on the `pro` tier
// alone; the overlay contract gates education on the educator grant. The resolved
// gel keeps BOTH for teaching tools — educator opens the plane, Pro unlocks the
// premium tools — so a non-approved user can't teach AND Creator-Pro still buys
// something on the education plane. Presentation (titles/icons/descriptions) stays
// per-platform; only the KEYS + the gating decision live here.
import type { Account } from './types';
import { isPremium } from './types';
import type { Capability } from './capabilities';
import { can } from './capabilities';
import type { AccountSubscription } from './billing';
import { isProSubscription } from './billing';

export type PremiumFeatureKey =
  // Insights (self-tier analytics perks)
  | 'audience_retention'
  | 'growth_forecast'
  | 'best_posting_time'
  | 'content_performance_score'
  // Sessions (teaching — education plane)
  | 'session_setup'
  | 'multi_page_whiteboard'
  | 'pdf_annotation'
  | 'classroom_analytics'
  | 'ai_lesson_tools'
  // Live session (self-tier perks)
  | 'session_recording'
  | 'recording_library'
  | 'hd_streaming'
  | 'cohost_support'
  // Feed (self-tier perks)
  | 'scheduled_posts'
  | 'pinned_posts'
  | 'featured_content';

/** Education-plane features → the capability they ride. A key ABSENT from this
 *  map is a pure self-tier (Creator-Pro) perk. */
export const FEATURE_CAPABILITY: Partial<Record<PremiumFeatureKey, Capability>> = {
  multi_page_whiteboard: 'overlay.whiteboard',
  pdf_annotation: 'overlay.doc', // annotation rides the doc overlay
  classroom_analytics: 'dashboard.analytics',
  session_setup: 'dashboard.access',
};

export interface PremiumAccess {
  /** Final allow decision for this feature. */
  hasAccess: boolean;
  /** Whether the account holds an active Creator-Pro subscription (tier perk). */
  isPro: boolean;
  /** The capability this feature rides, or null for a self-tier perk. */
  capability: Capability | null;
}

/** Is the account on an active Creator-Pro plan? Either an active subscription
 *  record OR a `premium` tier already stamped on the account (seed/test users
 *  carry the tier directly). */
export function isProAccount(
  account: Account,
  sub?: AccountSubscription,
  nowMs?: number,
): boolean {
  return isProSubscription(sub, nowMs) || isPremium(account);
}

/** The single gating resolver for web + mobile ("Educator + Creator-Pro").
 *  - Education-plane feature (mapped capability): allowed iff the account holds
 *    that capability (educator grant) AND Creator-Pro is active.
 *  - Self-tier perk (no mapped capability): allowed iff Creator-Pro is active. */
export function featureAccess(
  account: Account,
  feature: PremiumFeatureKey,
  sub?: AccountSubscription,
  nowMs?: number,
): PremiumAccess {
  const capability = FEATURE_CAPABILITY[feature] ?? null;
  const isPro = isProAccount(account, sub, nowMs);
  const hasAccess = capability ? can(account, capability) && isPro : isPro;
  return { hasAccess, isPro, capability };
}

/** Convenience boolean form of {@link featureAccess}. */
export function hasFeatureAccess(
  account: Account,
  feature: PremiumFeatureKey,
  sub?: AccountSubscription,
  nowMs?: number,
): boolean {
  return featureAccess(account, feature, sub, nowMs).hasAccess;
}
