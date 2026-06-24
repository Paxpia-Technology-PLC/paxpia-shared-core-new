// Unit tests for the premium-gating reconcile (RECOVER-PREMIUM-MIGRATION Wave 2.2)
// — the SHARED bridge from the mobile Creator-Pro feature catalog to the
// cross-platform capability model. Proves the two gating planes resolve from ONE
// input so web + mobile can't drift, AND documents the deliberate semantic gel:
// education-plane features ride a CAPABILITY (educator grant), self-tier perks ride
// the Creator-Pro SUBSCRIPTION.
//
// Asserts:
//   1. MAP — the education features map to the expected overlay/dashboard caps.
//   2. EDUCATION PLANE ("Educator + Creator-Pro") — multi_page_whiteboard needs
//      BOTH the educator capability AND active Pro: an educator WITH Pro is allowed;
//      an educator WITHOUT Pro is denied; a pro-but-non-educator is denied.
//   3. SELF-TIER PERK — hd_streaming is allowed for an active Pro subscription and
//      denied for a free, non-subscribed account.
//   4. SUBSCRIPTION — isProSubscription: active/trialing yes; none no; canceled
//      honors currentPeriodEnd vs nowMs.
//   5. PRO ACCOUNT — a `premium`-tier account reads as Pro without a sub record.
//   6. CAP — dashboard.analytics is granted to educators by capabilitiesFor.
//   7. ADAPTER — tierFromPlanLabel/planLabelFromTier round-trip the mobile label.
//
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/premiumFeatures.test.ts

import type { Account } from '../src/accounts/types.ts';
import { capabilitiesFor } from '../src/accounts/capabilities.ts';
import {
  FEATURE_CAPABILITY,
  featureAccess,
  hasFeatureAccess,
  isProAccount,
} from '../src/accounts/premiumFeatures.ts';
import {
  isProSubscription,
  tierFromPlanLabel,
  planLabelFromTier,
  type AccountSubscription,
} from '../src/accounts/billing.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

const mkAccount = (over: Partial<Account>): Account => ({
  id: 'u',
  username: 'user_name',
  displayName: 'User',
  tier: 'free',
  grants: [],
  badge: 'none',
  ...over,
});

const educatorFree = mkAccount({ tier: 'free', grants: ['educator'], badge: 'educator' });
const educatorPro = mkAccount({ tier: 'premium', grants: ['educator'], badge: 'educator' });
const proNonEducator = mkAccount({ tier: 'premium', grants: [], badge: 'none' });
const freeUser = mkAccount({ tier: 'free', grants: [], badge: 'none' });

const activeSub: AccountSubscription = { tier: 'premium', status: 'active', plan: 'monthly', currentPeriodEnd: null };
const noSub: AccountSubscription = { tier: 'free', status: 'none', plan: null, currentPeriodEnd: null };

// ── 1. MAP ─────────────────────────────────────────────────────────────────────────
{
  eq(FEATURE_CAPABILITY.multi_page_whiteboard, 'overlay.whiteboard', 'multi_page_whiteboard → overlay.whiteboard');
  eq(FEATURE_CAPABILITY.pdf_annotation, 'overlay.doc', 'pdf_annotation → overlay.doc');
  eq(FEATURE_CAPABILITY.classroom_analytics, 'dashboard.analytics', 'classroom_analytics → dashboard.analytics');
  eq(FEATURE_CAPABILITY.session_setup, 'dashboard.access', 'session_setup → dashboard.access');
  ok(FEATURE_CAPABILITY.hd_streaming === undefined, 'a self-tier perk has NO mapped capability');
}

// ── 2. EDUCATION PLANE ("Educator + Creator-Pro" — needs BOTH) ───────────────────────
{
  const a = featureAccess(educatorPro, 'multi_page_whiteboard', activeSub);
  ok(a.hasAccess && a.capability === 'overlay.whiteboard', 'educator WITH Pro gets the multi-page whiteboard');
  ok(!featureAccess(educatorFree, 'multi_page_whiteboard', noSub).hasAccess, 'educator WITHOUT Pro is denied the premium teaching whiteboard');
  ok(!featureAccess(proNonEducator, 'multi_page_whiteboard', activeSub).hasAccess, 'pro-but-non-educator is DENIED the teaching whiteboard (needs the educator grant)');
  ok(hasFeatureAccess(educatorPro, 'pdf_annotation', activeSub), 'educator+Pro gets pdf annotation');
  ok(!hasFeatureAccess(freeUser, 'pdf_annotation', noSub), 'a plain free user is denied pdf annotation');
}

// ── 3. SELF-TIER PERK (subscription-gated) ───────────────────────────────────────────
{
  ok(hasFeatureAccess(freeUser, 'hd_streaming', activeSub), 'an active Pro subscription unlocks the HD-streaming perk');
  ok(!hasFeatureAccess(freeUser, 'hd_streaming', noSub), 'a free, un-subscribed user is denied the HD perk');
  ok(!hasFeatureAccess(educatorFree, 'hd_streaming', noSub), 'an educator without Pro is still denied the HD perk');
}

// ── 4. SUBSCRIPTION status ───────────────────────────────────────────────────────────
{
  ok(isProSubscription(activeSub), 'active premium sub is Pro');
  ok(isProSubscription({ ...activeSub, status: 'trialing' }), 'trialing premium sub is Pro');
  ok(!isProSubscription(noSub), 'a none/free sub is not Pro');
  ok(!isProSubscription({ tier: 'premium', status: 'canceled', plan: 'monthly', currentPeriodEnd: '2999-01-01T00:00:00.000Z' }), 'canceled without nowMs reads lapsed');
  ok(isProSubscription({ tier: 'premium', status: 'canceled', plan: 'monthly', currentPeriodEnd: '2999-01-01T00:00:00.000Z' }, 0), 'canceled but inside the paid period (nowMs given) still Pro');
  ok(!isProSubscription({ tier: 'premium', status: 'canceled', plan: 'monthly', currentPeriodEnd: '2000-01-01T00:00:00.000Z' }, 1_700_000_000_000), 'canceled past the period end is lapsed');
}

// ── 5. PRO ACCOUNT (tier stamped on account, no sub record) ───────────────────────────
{
  ok(isProAccount(proNonEducator), 'a premium-tier account reads as Pro without a sub record');
  ok(isProAccount(freeUser, activeSub), 'a free-tier account with an active sub reads as Pro');
  ok(!isProAccount(freeUser, noSub), 'a free account with no sub is not Pro');
}

// ── 6. CAPABILITY ─────────────────────────────────────────────────────────────────────
{
  ok(capabilitiesFor(educatorFree).has('dashboard.analytics'), 'educators get the new dashboard.analytics capability');
  ok(!capabilitiesFor(freeUser).has('dashboard.analytics'), 'non-educators do not get dashboard.analytics');
}

// ── 7. TIER LABEL ADAPTER ─────────────────────────────────────────────────────────────
{
  eq(tierFromPlanLabel('pro'), 'premium', "mobile 'pro' label → core 'premium' tier");
  eq(tierFromPlanLabel('free'), 'free', "mobile 'free' label → core 'free' tier");
  eq(planLabelFromTier('premium'), 'pro', "core 'premium' tier → mobile 'pro' label");
}

// ── report ─────────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`premiumFeatures: ${passed} assertions passed`);
