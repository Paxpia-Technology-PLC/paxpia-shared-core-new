// Self-monetization billing — the account's OWN paid plan (Creator Pro).
//
// DELIBERATELY DISTINCT from ./subscriptions: that module's `Subscription` is a
// viewer's super-subscription to ANOTHER creator (a relationship), whereas
// `AccountSubscription` here is "what I pay for myself" (a tier). Conflating the
// two would let a per-creator super-sub leak into self-tier gating, so they stay
// separate types — see paxpia-docs/RECOVER-PREMIUM-MIGRATION-2026-06-24.md §4.2/R5.
//
// Lifted from the mobile `features/premium/types.ts` (`Subscription`/`PRO_PRICING`)
// so web + mobile share one billing shape. The mobile `PlanTier 'free'|'pro'`
// label collapses into the core `AccountTier 'free'|'premium'` (adapters below).
import type { AccountTier } from './types';

export type BillingPlan = 'monthly' | 'yearly';

export type SubscriptionStatusValue = 'active' | 'trialing' | 'canceled' | 'none';

export interface AccountSubscription {
  tier: AccountTier;
  status: SubscriptionStatusValue;
  plan: BillingPlan | null;
  /** ISO timestamp the current paid period ends, or null when not subscribed. */
  currentPeriodEnd: string | null;
}

export const PRO_PRICING: Record<
  BillingPlan,
  { price: number; per: string; note?: string }
> = {
  monthly: { price: 9.99, per: 'month' },
  yearly: { price: 79.99, per: 'year', note: 'Save 33%' },
};

/** A free (un-subscribed) account subscription — the default. */
export const FREE_SUBSCRIPTION: AccountSubscription = {
  tier: 'free',
  status: 'none',
  plan: null,
  currentPeriodEnd: null,
};

/** Is this an ACTIVE Creator-Pro subscription right now?
 *  - `active` / `trialing` → yes.
 *  - `canceled` → access persists until `currentPeriodEnd` (pass `nowMs` to
 *    enforce; without `nowMs` a canceled sub reads as lapsed).
 *  - anything else / undefined → no. */
export function isProSubscription(
  sub: AccountSubscription | undefined,
  nowMs?: number,
): boolean {
  if (!sub || sub.tier !== 'premium') return false;
  if (sub.status === 'active' || sub.status === 'trialing') return true;
  if (sub.status === 'canceled' && sub.currentPeriodEnd && nowMs != null) {
    return nowMs < Date.parse(sub.currentPeriodEnd);
  }
  return false;
}

/** Mobile "Pro" tier label → the core `AccountTier`. */
export function tierFromPlanLabel(label: 'free' | 'pro'): AccountTier {
  return label === 'pro' ? 'premium' : 'free';
}

/** Core `AccountTier` → the mobile "Pro" UI label. */
export function planLabelFromTier(tier: AccountTier): 'free' | 'pro' {
  return tier === 'premium' ? 'pro' : 'free';
}
