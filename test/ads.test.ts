// Unit tests for @paxpia/core/ads — the pure advertising rules. Same harness as the
// sibling tests:
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/ads.test.ts
//
// Asserts:
//   weave         · cadence, id derivation, reserved-slot skip, purity, slot counting,
//                   and the arithmetic of the ad/course collision (i ≡ 20 mod 30)
//   frequencyCap  · session cap, per-campaign cap, minGap, the simulated-clock advance
//   targeting     · THE STRICT MINOR RULE — interests and audiences inert under 18,
//                   exclusions still honoured, unknown age fails closed, restricted
//                   categories clamp to 18+, and the policy is genuinely data-driven
//   matrix        · legal goal/billing/bid combinations, and edit-resets-learning
//   money         · integer santim, VAT split, undefined-not-NaN rate metrics, eCPM

import {
  weaveAds, sponsoredItemId, isSponsoredItemId, slotCountFor, CADENCE,
} from '../src/ads/weave.ts';
import {
  emptyFrequencyState, canShow, recordShown, applyCaps, DEFAULT_RULES,
} from '../src/ads/frequencyCap.ts';
import {
  resolveTargetingPolicy, isViewerEligible, targetsMinors, hasClampedPersonalization,
  clampToAdults, STRICT_POLICY, MODERATE_POLICY_FOR_TESTS,
} from '../src/ads/targeting.ts';
import {
  validateDeliveryConfig, isGoalLegal, isBillingLegal, bidStrategiesFor,
  defaultGoalFor, defaultBillingFor, editResetsLearning, editsResettingLearning,
} from '../src/ads/matrix.ts';
import {
  birrToSantim, santimToBirr, fmtETB, vatFromGross, vatFromNet,
  ctr, cpm, cpc, cpa, roas, frequency, eCPM, fmtPct,
} from '../src/ads/money.ts';
import {
  estimateReach, lifetimeFromDaily, snapDailyBudget, validateBudget,
  DAILY_BUDGET_STEPS, MIN_DAILY_BUDGET,
} from '../src/ads/estimate.ts';
import { expandBoost, BOOST_GOALS, BOOST_AUDIENCES } from '../src/ads/boost.ts';
import type { AdFill, AdTargeting, Santim, AgeBand } from '../src/ads/types.ts';
import type { BoostInput, BoostContext } from '../src/ads/boost.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

// ─── fixtures ────────────────────────────────────────────────────────────────────

type Item = { id: string; ad?: AdFill };

const organic = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));

function fill(n: number, over: Partial<AdFill> = {}): AdFill {
  return {
    adId: `ad${n}` as AdFill['adId'],
    campaignId: `camp${n}` as AdFill['campaignId'],
    fillToken: `tok${n}` as AdFill['fillToken'],
    placement: 'precept',
    advertiser: { id: `adv${n}`, name: `Advertiser ${n}`, avatar: '', verified: false },
    creative: {
      media: { kind: 'image', url: 'https://cdn/x.jpg' },
      headline: `Headline ${n}`,
      cta: { label: 'learn_more', target: { kind: 'url', url: 'https://x' } },
    },
    disclosure: { reasons: ['You are in Ethiopia'] },
    ...over,
  };
}

const WEAVE_OPTS = {
  toItem: (f: AdFill, anchorId: string): Item => ({ id: sponsoredItemId(f.adId, anchorId), ad: f }),
  idOf: (i: Item) => i.id,
};

// ─── weave ───────────────────────────────────────────────────────────────────────

{
  // Precept cadence: firstAfter 3, everyN 6 → ads sit after organic index 2, 8, 14…
  const out = weaveAds(organic(20), [fill(1), fill(2), fill(3)], 'precept', WEAVE_OPTS);
  const adPositions = out.map((it, i) => (it.ad ? i : -1)).filter(i => i >= 0);
  // Position in the OUTPUT array shifts by the ads already inserted before it.
  eq(adPositions, [3, 10, 17], 'weave: precept ads land at output 3/10/17');
  eq(out.length, 23, 'weave: output length = organic + ads');
  eq(out[3].id, 'ad:ad1:p2', 'weave: id is derived from the anchor organic id');
  ok(isSponsoredItemId(out[3].id), 'weave: sponsored id is recognisable');
  ok(!isSponsoredItemId(out[0].id), 'weave: organic id is not mistaken for sponsored');
}

{
  // Determinism: the same inputs must produce the same ids, so a re-derive after an
  // append doesn't remount an ad or fire a second impression.
  const a = weaveAds(organic(20), [fill(1), fill(2)], 'precept', WEAVE_OPTS);
  const b = weaveAds(organic(20), [fill(1), fill(2)], 'precept', WEAVE_OPTS);
  eq(a.map(i => i.id), b.map(i => i.id), 'weave: deterministic across calls');
}

{
  // Appending organic items must not move the ads already placed above the append.
  const short = weaveAds(organic(12), [fill(1), fill(2)], 'precept', WEAVE_OPTS);
  const long = weaveAds(organic(30), [fill(1), fill(2)], 'precept', WEAVE_OPTS);
  const shortAds = short.filter(i => i.ad).map(i => i.id);
  const longAds = long.filter(i => i.ad).map(i => i.id);
  eq(shortAds, longAds.slice(0, shortAds.length), 'weave: appending does not move existing ads');
}

{
  // Purity: the input array is never mutated, and a no-op returns it by reference so a
  // downstream memo sees an unchanged identity.
  const src = organic(10);
  const copy = src.map(i => ({ ...i }));
  weaveAds(src, [fill(1)], 'precept', WEAVE_OPTS);
  eq(src, copy, 'weave: does not mutate input');
  ok(weaveAds(src, [], 'precept', WEAVE_OPTS) === src, 'weave: no fills returns input by reference');
  ok(weaveAds([], [fill(1)], 'precept', WEAVE_OPTS).length === 0, 'weave: empty organic stays empty');
}

{
  // Reserved slots. Course cards sit at index % 5 === 0 (0, 5, 10, 15, 20…) and ad
  // anchors at i ≡ 2 (mod 6) (2, 8, 14, 20, 26…). The first genuine collision is 20.
  const isCourseSlot = (i: number) => i % 5 === 0;
  const collisions: number[] = [];
  for (let i = 0; i < 120; i++) if (isCourseSlot(i) && i % 6 === 2) collisions.push(i);
  eq(collisions, [20, 50, 80, 110], 'weave: ad/course collisions are i ≡ 20 (mod 30)');

  const out = weaveAds(organic(40), [fill(1), fill(2), fill(3), fill(4)], 'precept', {
    ...WEAVE_OPTS, isReservedSlot: isCourseSlot,
  });
  // Anchor 20 is skipped, so the 4th ad slides to the next interval (26) rather than
  // sliding by one — which would have knocked every later slot off cadence.
  const anchors = out.filter(i => i.ad).map(i => i.id.split(':')[2]);
  eq(anchors, ['p2', 'p8', 'p14', 'p26'], 'weave: reserved slot is skipped, cadence preserved');
}

{
  // Fewer fills than slots is the normal case, not an error.
  const out = weaveAds(organic(40), [fill(1)], 'precept', WEAVE_OPTS);
  eq(out.filter(i => i.ad).length, 1, 'weave: runs out of fills gracefully');
}

{
  eq(slotCountFor(0, 'precept'), 0, 'slotCount: empty feed');
  eq(slotCountFor(2, 'precept'), 0, 'slotCount: below firstAfter');
  eq(slotCountFor(3, 'precept'), 1, 'slotCount: exactly firstAfter');
  eq(slotCountFor(20, 'precept'), 3, 'slotCount: 20 organic → 3 precept slots');
  eq(slotCountFor(20, 'reels'), 3, 'slotCount: 20 organic → 3 reels slots');
  eq(CADENCE.reels.firstAfter, 4, 'cadence: reels never shows an ad before the 5th video');
}

// ─── frequency cap ───────────────────────────────────────────────────────────────

{
  let s = emptyFrequencyState();
  const f = fill(1);
  ok(canShow(s, f, 0).allowed, 'freqCap: first ad allowed');

  // Session cap.
  for (let i = 0; i < DEFAULT_RULES.precept.maxPerSession; i++) {
    s = recordShown(s, fill(100 + i, { campaignId: `c${i}` as AdFill['campaignId'] }), i * 1000);
  }
  const capped = canShow(s, f, 99_999);
  eq(capped, { allowed: false, reason: 'session_cap' }, 'freqCap: session cap blocks');
}

{
  // Per-campaign cap fires before the session cap when one advertiser dominates.
  let s = emptyFrequencyState();
  const same = { campaignId: 'camp-same' as AdFill['campaignId'] };
  s = recordShown(s, fill(1, same), 0);
  s = recordShown(s, fill(2, same), 1000);
  eq(canShow(s, fill(3, same), 2000),
     { allowed: false, reason: 'campaign_cap' }, 'freqCap: per-campaign cap blocks');
}

{
  // Reels minimum gap.
  let s = emptyFrequencyState();
  const r = fill(1, { placement: 'reels' });
  s = recordShown(s, r, 1_000_000);
  eq(canShow(s, fill(2, { placement: 'reels' }), 1_000_000 + 10_000),
     { allowed: false, reason: 'too_soon' }, 'freqCap: reels 90s gap blocks a close second');
  ok(canShow(s, fill(2, { placement: 'reels' }), 1_000_000 + 91_000).allowed,
     'freqCap: reels allows after the gap');
}

{
  // applyCaps advances a simulated clock, otherwise minGapMs would reject every ad
  // after the first in a single weave.
  const fills = [1, 2, 3, 4, 5, 6].map(n =>
    fill(n, { placement: 'reels', campaignId: `c${n}` as AdFill['campaignId'] }));
  const kept = applyCaps(emptyFrequencyState(), fills, 0);
  eq(kept.length, DEFAULT_RULES.reels.maxPerSession, 'applyCaps: trims to the session cap');
  ok(kept.every(k => k.placement === 'reels'), 'applyCaps: preserves placement');

  // Purity — the caller's state is untouched.
  const s0 = emptyFrequencyState();
  applyCaps(s0, fills, 0);
  eq(s0, emptyFrequencyState(), 'applyCaps: does not mutate the passed state');
}

// ─── targeting: THE STRICT MINOR RULE ────────────────────────────────────────────

const ET = { country: 'ET' };

function targeting(over: Partial<AdTargeting> = {}): AdTargeting {
  return { geo: ET, ageBands: [], ...over };
}

{
  // An adult matching an interest is eligible.
  const t = targeting({ ageBands: ['18-24'], interests: ['math'] });
  eq(resolveTargetingPolicy(t, { age: 20, country: 'ET', interests: ['math'] }),
     { outcome: 'eligible' }, 'targeting: adult interest match is eligible');
}

{
  // THE RULE: a minor's interests are IGNORED, not matched.
  const t = targeting({ ageBands: ['13-17'], interests: ['math'] });
  const v = resolveTargetingPolicy(t, { age: 15, country: 'ET', interests: ['math'] });
  eq(v, { outcome: 'clamped', ignored: ['interests'] },
     'targeting: minor interest targeting is clamped, not honoured');

  // And a minor who does NOT match the interest is treated identically — proving the
  // interest genuinely had no effect either way, rather than being matched loosely.
  const v2 = resolveTargetingPolicy(t, { age: 15, country: 'ET', interests: ['history'] });
  eq(v2, { outcome: 'clamped', ignored: ['interests'] },
     'targeting: minor non-matching interest behaves identically (inert)');
}

{
  // Custom audiences and lookalikes are equally inert for minors.
  const t = targeting({ ageBands: ['13-17'], includeAudiences: ['aud1' as never] });
  eq(resolveTargetingPolicy(t, { age: 16, country: 'ET', audienceIds: ['aud1'] }),
     { outcome: 'clamped', ignored: ['includeAudiences'] },
     'targeting: minor custom-audience include is clamped');
  // A minor who is NOT in the audience is still clamped rather than blocked — the
  // audience simply is not part of the decision.
  eq(resolveTargetingPolicy(t, { age: 16, country: 'ET', audienceIds: [] }),
     { outcome: 'clamped', ignored: ['includeAudiences'] },
     'targeting: minor non-member behaves identically (inert)');
}

{
  // Exclusions ARE honoured for minors — an exclusion can only narrow reach, so
  // ignoring it would mean serving somebody the advertiser explicitly excluded.
  const t = targeting({ ageBands: ['13-17'], excludeAudiences: ['bad' as never] });
  eq(resolveTargetingPolicy(t, { age: 15, country: 'ET', audienceIds: ['bad'] }),
     { outcome: 'blocked', reason: 'excluded_audience' },
     'targeting: exclusions still apply to minors');
}

{
  // Unknown age fails CLOSED — treated as a minor, not as an adult.
  const t = targeting({ interests: ['math'] });
  const v = resolveTargetingPolicy(t, { country: 'ET', interests: ['math'] });
  ok(v.outcome !== 'eligible', 'targeting: unknown age is not treated as an adult');
}

{
  // Below the absolute floor, nothing is served at all.
  eq(resolveTargetingPolicy(targeting(), { age: 11, country: 'ET' }),
     { outcome: 'blocked', reason: 'under_minimum_age' }, 'targeting: under 13 gets nothing');
}

{
  // A restricted category clamps to 18+ regardless of targeting.
  const t = targeting({ ageBands: ['13-17', '18-24'] });
  eq(resolveTargetingPolicy(t, { age: 15, country: 'ET' }, { restrictedCategories: ['financial_services'] }),
     { outcome: 'blocked', reason: 'restricted_category_minor' },
     'targeting: restricted category blocks minors');
  // age 20 — inside the 18-24 band the ad set actually targets.
  ok(isViewerEligible(t, { age: 20, country: 'ET' }, { restrictedCategories: ['financial_services'] }),
     'targeting: restricted category still serves adults');
}

{
  // Personalization that was the ONLY narrowing must not silently widen to every minor.
  const t = targeting({ interests: ['math'] }); // no bands, no geo narrowing, no language
  eq(resolveTargetingPolicy(t, { age: 15, country: 'ET', interests: ['math'] }),
     { outcome: 'blocked', reason: 'no_targeting_match_after_clamp' },
     'targeting: clamping that would widen the audience blocks instead');
}

{
  // The predicate is genuinely policy-driven, not hard-coded to 18.
  const t = targeting({ ageBands: ['13-17'], interests: ['math'] });
  eq(resolveTargetingPolicy(t, { age: 15, country: 'ET', interests: ['math'] }, {}, MODERATE_POLICY_FOR_TESTS),
     { outcome: 'eligible' }, 'targeting: policy is data-driven (moderate honours interests)');
  eq(STRICT_POLICY.personalizedTargetingMinAge, 18, 'targeting: shipped policy is strict at 18');
}

{
  // Geo and language gates.
  const t = targeting({ geo: { country: 'ET', regions: ['Addis Ababa'] } });
  eq(resolveTargetingPolicy(t, { age: 30, country: 'ET', region: 'Oromia' }),
     { outcome: 'blocked', reason: 'geo_mismatch' }, 'targeting: region mismatch blocks');
  const tl = targeting({ languages: ['am'] });
  eq(resolveTargetingPolicy(tl, { age: 30, country: 'ET', language: 'en' }),
     { outcome: 'blocked', reason: 'language_mismatch' }, 'targeting: language mismatch blocks');
}

{
  // Builder helpers.
  ok(targetsMinors(targeting({ ageBands: ['13-17', '25-34'] })), 'targetsMinors: band including 13-17');
  ok(!targetsMinors(targeting({ ageBands: ['25-34'] })), 'targetsMinors: adult-only bands');
  ok(targetsMinors(targeting({ ageBands: [] })), 'targetsMinors: unspecified means everyone');

  ok(hasClampedPersonalization(targeting({ ageBands: ['13-17'], interests: ['x'] })),
     'hasClampedPersonalization: warns when personalization will be ignored');
  ok(!hasClampedPersonalization(targeting({ ageBands: ['25-34'], interests: ['x'] })),
     'hasClampedPersonalization: silent for adult-only');

  const clamped = clampToAdults(targeting({ ageBands: ['13-17', '18-24', '25-34'] as AgeBand[] }));
  eq(clamped.ageBands, ['18-24', '25-34'], 'clampToAdults: drops the minor band');
  const clampedAll = clampToAdults(targeting({ ageBands: [] }));
  ok(!clampedAll.ageBands.includes('13-17' as AgeBand), 'clampToAdults: expands then drops minors');
}

// ─── matrix ──────────────────────────────────────────────────────────────────────

{
  ok(isGoalLegal('course_sales', 'purchase'), 'matrix: purchase is legal for course_sales');
  ok(!isGoalLegal('awareness', 'purchase'), 'matrix: purchase is illegal for awareness');
  ok(isBillingLegal('link_clicks', 'link_click'), 'matrix: CPC legal for link_clicks');
  ok(!isBillingLegal('reach', 'link_click'), 'matrix: CPC illegal for reach');
  ok(bidStrategiesFor('value').includes('highest_value'), 'matrix: ROAS bidding needs a value goal');
  ok(!bidStrategiesFor('reach').includes('highest_value'), 'matrix: no ROAS bidding without value');
  eq(defaultGoalFor('followers'), 'follows', 'matrix: default goal for followers');
  eq(defaultBillingFor('purchase'), 'impression', 'matrix: purchase is billed per impression');

  // Every objective has at least one goal, and every goal at least one billing event.
  const objectives = ['awareness', 'traffic', 'engagement', 'followers', 'course_sales', 'leads'] as const;
  ok(objectives.every(o => (defaultGoalFor(o) as string).length > 0), 'matrix: every objective has a goal');
}

{
  eq(validateDeliveryConfig({
    objective: 'course_sales', optimizationGoal: 'purchase',
    billingEvent: 'impression', bidStrategy: 'highest_volume',
  }), [], 'matrix: a valid config has no problems');

  const bad = validateDeliveryConfig({
    objective: 'awareness', optimizationGoal: 'purchase',
    billingEvent: 'link_click', bidStrategy: 'highest_value', bidAmount: 500,
  });
  ok(bad.length >= 3, 'matrix: reports EVERY problem, not just the first');
  ok(bad.some(p => p.code === 'goal_illegal_for_objective'), 'matrix: catches illegal goal');
  ok(bad.some(p => p.code === 'bid_amount_forbidden'), 'matrix: catches a bid amount that should not be there');

  eq(validateDeliveryConfig({
    objective: 'traffic', optimizationGoal: 'link_clicks',
    billingEvent: 'impression', bidStrategy: 'bid_cap',
  }), [{ code: 'bid_amount_required', strategy: 'bid_cap' }], 'matrix: bid cap requires an amount');
}

{
  // Learning phase resets.
  ok(editResetsLearning('targeting'), 'learning: targeting edit resets');
  ok(editResetsLearning('creative'), 'learning: creative edit resets');
  ok(!editResetsLearning('name'), 'learning: renaming does not reset');
  ok(!editResetsLearning('schedule'), 'learning: schedule change does not reset');
  ok(!editResetsLearning('budget', 1000, 1100), 'learning: a 10% budget change does not reset');
  ok(editResetsLearning('budget', 1000, 1300), 'learning: a 30% budget change resets');
  eq(editsResettingLearning([
    { field: 'name' }, { field: 'targeting' }, { field: 'budget', oldValue: 100, newValue: 400 },
  ]), ['targeting', 'budget'], 'learning: names exactly which edits reset');
}

// ─── money ───────────────────────────────────────────────────────────────────────

{
  eq(birrToSantim(12.34), 1234, 'money: birr → integer santim');
  eq(birrToSantim(0.1 + 0.2), 30, 'money: float noise rounds to an exact integer');
  eq(santimToBirr(1234 as Santim), 12.34, 'money: santim → birr');
  eq(fmtETB(150_000 as Santim, { compact: true }), 'ETB 1.5K', 'money: compact format');
  eq(fmtETB(1234 as Santim), 'ETB 12.34', 'money: exact format keeps both decimals');
  // `whole` keeps a row of budget choices in ONE format — 'ETB 500' next to 'ETB 1,000',
  // never 'ETB 500' next to 'ETB 1.0K'.
  eq(fmtETB(100_000 as Santim, { whole: true }), 'ETB 1,000', 'money: whole format for choices');
  eq(fmtETB(2_500 as Santim, { whole: true }), 'ETB 25', 'money: whole format, small rung');
  eq(fmtETB(100_000 as Santim, { compact: true }), 'ETB 1.0K', 'money: compact is unchanged');
}

{
  const v = vatFromGross(11_500 as Santim);
  eq(v.net + v.vat, 11_500, 'money: VAT split reconciles exactly to the gross');
  eq(v.net, 10_000, 'money: 15% VAT out of a 115 birr gross');
  const n = vatFromNet(10_000 as Santim);
  eq(n.gross, 11_500, 'money: VAT added to net');
  eq(n.ratePct, 15, 'money: rate is reported for the receipt line');
}

{
  // Rate metrics return undefined — NOT 0 and NOT NaN — on an empty denominator.
  // "No clicks yet" and "a 0% click rate" mean different things to someone deciding
  // whether to keep spending.
  eq(ctr(0, 0), undefined, 'money: CTR with no impressions is undefined');
  eq(ctr(100, 10_000), 0.01, 'money: CTR of 100/10000 is 1%');
  eq(cpm(0 as Santim, 0), undefined, 'money: CPM with no impressions is undefined');
  eq(cpm(50_000 as Santim, 10_000), 5_000, 'money: CPM');
  eq(cpc(0 as Santim, 0), undefined, 'money: CPC with no clicks is undefined');
  eq(cpa(10_000 as Santim, 4), 2_500, 'money: CPA');
  eq(cpa(10_000 as Santim, 0), undefined, 'money: CPA with no conversions is undefined');
  eq(roas(40_000 as Santim, 10_000 as Santim), 4, 'money: ROAS is a multiple');
  eq(frequency(1000, 250), 4, 'money: frequency = impressions / reach');
  eq(frequency(1000, 0), undefined, 'money: frequency with no reach is undefined');
  eq(fmtPct(undefined), '—', 'money: undefined renders as an em dash, never NaN%');
  eq(fmtPct(0.0123), '1.23%', 'money: percentage formatting');
}

{
  // The auction insight: the lower per-click bid wins on eCPM because its ad is better.
  const a = eCPM(200 as Santim, 0.01); // 2.00 birr/click at 1% CTR
  const b = eCPM(100 as Santim, 0.05); // 1.00 birr/click at 5% CTR
  eq(a, 2_000, 'money: eCPM of the high bid / poor ad = 20 birr');
  eq(b, 5_000, 'money: eCPM of the low bid / good ad = 50 birr');
  ok(b > a, 'money: relevance beats bid — the lower bidder wins the slot');
}

// ─── estimate ────────────────────────────────────────────────────────────────────

{
  eq(lifetimeFromDaily(10_000 as Santim, 3), 30_000, 'estimate: lifetime = daily x days');
  eq(snapDailyBudget(9_000), DAILY_BUDGET_STEPS[2], 'estimate: snaps to the nearest rung');
  eq(validateBudget(1_000 as Santim, 3, 999_999 as Santim)[0]?.code, 'below_minimum',
     'estimate: below the floor is rejected');
  eq(validateBudget(10_000 as Santim, 30, 5_000 as Santim).some(p => p.code === 'insufficient_credit'),
     true, 'estimate: insufficient credit is caught');
  eq(validateBudget(MIN_DAILY_BUDGET, 1, 999_999 as Santim), [], 'estimate: the minimum is legal');
}

{
  const base = { budgetSantim: 100_000 as Santim, placement: 'precept' as const,
                 targeting: { geo: { country: 'ET' }, ageBands: ['25-34'] as AgeBand[] } };
  const e = estimateReach(base);
  ok(e.min < e.max, 'estimate: returns a RANGE, never a point');
  ok(e.impressions > 0, 'estimate: derives impressions from budget and CPM');
  ok(!e.minorClamped, 'estimate: adult-only targeting is not clamped');

  // Zero budget must not produce a fantasy reach.
  eq(estimateReach({ ...base, budgetSantim: 0 as Santim }).max, 0, 'estimate: no budget, no reach');

  // A bigger budget reaches more people.
  ok(estimateReach({ ...base, budgetSantim: 400_000 as Santim }).max > e.max,
     'estimate: more budget, more reach');

  // Personalised targeting that includes minors is discounted AND flagged, because the
  // auction cannot reach them that way and the advertiser must be told.
  // A budget large enough that the AUDIENCE is the binding constraint, not the money —
  // otherwise both estimates are capped by spend and the clamp is invisible.
  const bigBudget = 2_000_000 as Santim;
  const withMinors = estimateReach({
    ...base,
    budgetSantim: bigBudget,
    targeting: { geo: { country: 'ET' }, ageBands: ['13-17', '25-34'] as AgeBand[], interests: ['math'] },
    audienceSize: 100_000,
  });
  ok(withMinors.minorClamped, 'estimate: flags that personalisation is clamped');
  const withoutMinors = estimateReach({
    ...base,
    budgetSantim: bigBudget,
    targeting: { geo: { country: 'ET' }, ageBands: ['25-34'] as AgeBand[], interests: ['math'] },
    audienceSize: 100_000,
  });
  ok(withMinors.max < withoutMinors.max, 'estimate: minors are subtracted from the promise');
}

// ─── boost ───────────────────────────────────────────────────────────────────────

{
  const input: BoostInput = {
    postId: 'p123',
    goal: 'more_sales',
    audience: 'automatic',
    dailyBudget: 10_000 as Santim,
    durationDays: 3,
    creative: {
      media: { kind: 'image', url: 'https://cdn/x.jpg' },
      headline: 'Grade 12 Physics, taught in Amharic',
      cta: { label: 'view_course', target: { kind: 'url', url: 'https://x' } },
    },
  };
  const ctx: BoostContext = {
    accountId: 'acct1' as never, campaignId: 'c1' as never,
    adSetId: 'as1' as never, adId: 'ad1' as never,
    nowUnix: 1_760_000_000, country: 'ET',
  };
  const out = expandBoost(input, ctx);

  // Boost produces the SAME four objects the full builder does — that is what lets a
  // boosted post be opened and edited in the manager later.
  eq(out.campaign.objective, 'course_sales', 'boost: goal maps to a real objective');
  eq(out.adSet.campaignId, 'c1', 'boost: ad set is linked to its campaign');
  eq(out.ad.adSetId, 'as1', 'boost: ad is linked to its ad set');
  eq(out.totalSantim, 30_000, 'boost: total = daily x days');
  eq(out.adSet.budget?.kind, 'lifetime', 'boost: uses a lifetime budget with a definite end');
  eq(out.campaign.state, 'in_review', 'boost: starts in review, never live instantly');
  eq(out.adSet.bidStrategy, 'highest_volume', 'boost: never exposes a bid input');
  ok(out.adSet.bidAmount === undefined, 'boost: sends no bid amount');
  eq(out.campaign.fromPostId, 'p123', 'boost: records where it came from');

  // THE SAFETY PROPERTY: Boost is 18+ only. A three-tap flow is exactly where somebody
  // reaches a 14-year-old by accident.
  ok(!out.adSet.targeting.ageBands.includes('13-17' as AgeBand),
     'boost: never targets under-18s');

  // The name is recognisable six weeks later, not "Campaign 4".
  ok(out.campaign.name.includes('Physics'), 'boost: names the campaign from the creative');

  // Every goal and audience preset expands without throwing.
  for (const g of BOOST_GOALS) {
    for (const a of BOOST_AUDIENCES) {
      const r = expandBoost({ ...input, goal: g, audience: a }, ctx);
      ok(!!r.campaign.objective && !!r.adSet.optimizationGoal,
         `boost: ${g}/${a} expands to a valid config`);
    }
  }
}

// ─── report ──────────────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(`ads.test.ts — ${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`ads.test.ts — ${passed} assertions passed`);
