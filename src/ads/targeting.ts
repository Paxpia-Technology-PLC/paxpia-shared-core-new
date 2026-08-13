// Who is allowed to be shown what. THE ONLY place viewer eligibility is decided.
//
// ── WHY THIS IS ONE PURE FUNCTION ────────────────────────────────────────────────
//
// The rule protecting minors is the one rule in this system that must not be able to
// drift. Scattered `if (age < 18)` checks across a serve path, a builder, a reach
// estimator and a Go service will eventually disagree — and the failure mode is not a
// visual bug, it is a 15-year-old being interest-targeted by an advertiser.
//
// So it is a single predicate over plain data, unit-tested in isolation, exported from
// the shared core, and mirrored by the backend rather than reimplemented by it. Three
// call sites, one answer.
//
// ── THE POLICY (strict) ──────────────────────────────────────────────────────────
//
// A viewer under 18 is reachable by AGE BAND, LOCATION and LANGUAGE only. Interest
// targeting, custom audiences and lookalikes are all inert against them: a minor is
// never a member of a custom audience and never a lookalike seed.
//
// This was a deliberate choice over the "moderate" alternative (interests allowed for
// minors, sensitive verticals blocked). Moderate is where Meta, TikTok and YouTube each
// started and each was eventually forced to retreat from; adopting strict now avoids
// building a targeting surface that later has to be dismantled, and removes a category
// of compliance risk from a product whose users are there to study.
//
// The policy is passed IN rather than hard-coded, so the rule can be tightened or (with
// a deliberate decision) loosened as configuration, and so tests can assert both
// behaviours without editing the module under test.

import {
  ADULT_AGE, MIN_AD_AGE, RESTRICTED_CATEGORIES,
  type AdTargeting, type AgeBand, type RestrictedCategory,
} from './types';

/** The minimum age a band can contain. Used to decide whether an audience definition
 *  can reach anyone under 18 at all. */
const BAND_MIN_AGE: Record<AgeBand, number> = {
  '13-17': 13, '18-24': 18, '25-34': 25, '35-44': 35, '45-54': 45, '55+': 55,
};

const BAND_MAX_AGE: Record<AgeBand, number> = {
  '13-17': 17, '18-24': 24, '25-34': 34, '35-44': 44, '45-54': 54, '55+': 120,
};

export interface TargetingPolicy {
  /** Below this age, only age/geo/language may be used. */
  personalizedTargetingMinAge: number;
  /** Below this age, no ad is served at all. */
  absoluteMinAge: number;
  /** Declaring any of these clamps the whole campaign to 18+. */
  restrictedCategories: readonly RestrictedCategory[];
}

/** The shipped policy. */
export const STRICT_POLICY: TargetingPolicy = {
  personalizedTargetingMinAge: ADULT_AGE,
  absoluteMinAge: MIN_AD_AGE,
  restrictedCategories: RESTRICTED_CATEGORIES,
};

/** The looser variant, kept ONLY so tests can prove the predicate is genuinely
 *  policy-driven rather than hard-coded. Not exported from the barrel; not wired to
 *  anything. Do not ship this without an explicit product decision. */
export const MODERATE_POLICY_FOR_TESTS: TargetingPolicy = {
  personalizedTargetingMinAge: 0,
  absoluteMinAge: MIN_AD_AGE,
  restrictedCategories: RESTRICTED_CATEGORIES,
};

export interface ViewerContext {
  /** Absent when unknown. An unknown age is treated as a MINOR — failing closed is the
   *  only defensible default here. */
  age?: number;
  country?: string;
  region?: string;
  city?: string;
  language?: string;
  /** Audience ids the viewer is a member of, as resolved by the server. Never sent to
   *  or computed by the client. */
  audienceIds?: readonly string[];
  /** Interest/topic ids the viewer matches. */
  interests?: readonly string[];
}

export type TargetingVerdict =
  /** Serve it. */
  | { outcome: 'eligible' }
  /** Do not serve it to this viewer. */
  | { outcome: 'blocked'; reason: BlockReason }
  /** Serve, but only because the personalized parts of the targeting were IGNORED.
   *  Returned rather than silently serving so the serve path can log it and the reach
   *  estimator can subtract these viewers from the projection. */
  | { outcome: 'clamped'; ignored: ClampedField[] };

export type BlockReason =
  | 'under_minimum_age'
  | 'age_band_mismatch'
  | 'geo_mismatch'
  | 'language_mismatch'
  | 'excluded_audience'
  | 'restricted_category_minor'
  | 'no_targeting_match_after_clamp';

export type ClampedField = 'interests' | 'includeAudiences';

function inAnyBand(age: number, bands: readonly AgeBand[]): boolean {
  return bands.some(b => age >= BAND_MIN_AGE[b] && age <= BAND_MAX_AGE[b]);
}

function geoMatches(t: AdTargeting, v: ViewerContext): boolean {
  if (v.country && t.geo.country && v.country !== t.geo.country) return false;
  // Region/city narrow further only when specified. An unspecified level means
  // "anywhere in the level above", which is why an empty array is not a mismatch.
  if (t.geo.regions?.length) {
    if (!v.region || !t.geo.regions.includes(v.region)) return false;
  }
  if (t.geo.cities?.length) {
    if (!v.city || !t.geo.cities.includes(v.city)) return false;
  }
  return true;
}

/**
 * Decide whether one viewer may be shown one ad set's targeting.
 *
 * @param targeting  the ad set's audience definition
 * @param viewer     what is known about the person about to see it
 * @param opts.restrictedCategories  categories the campaign self-declared
 * @param policy     defaults to STRICT_POLICY
 */
export function resolveTargetingPolicy(
  targeting: AdTargeting,
  viewer: ViewerContext,
  opts: { restrictedCategories?: readonly RestrictedCategory[] } = {},
  policy: TargetingPolicy = STRICT_POLICY,
): TargetingVerdict {
  // An unknown age is a minor. Fail closed.
  const age = typeof viewer.age === 'number' ? viewer.age : 0;
  const isMinor = age < policy.personalizedTargetingMinAge;

  if (age < policy.absoluteMinAge) {
    return { outcome: 'blocked', reason: 'under_minimum_age' };
  }

  // A campaign in a restricted vertical is 18+ regardless of what it targeted. This is
  // checked BEFORE the age-band test so the reason returned is the informative one.
  const declared = opts.restrictedCategories ?? [];
  if (isMinor && declared.some(c => policy.restrictedCategories.includes(c))) {
    return { outcome: 'blocked', reason: 'restricted_category_minor' };
  }

  if (targeting.ageBands.length && !inAnyBand(age, targeting.ageBands)) {
    return { outcome: 'blocked', reason: 'age_band_mismatch' };
  }

  if (!geoMatches(targeting, viewer)) {
    return { outcome: 'blocked', reason: 'geo_mismatch' };
  }

  if (targeting.languages?.length) {
    if (!viewer.language || !targeting.languages.includes(viewer.language)) {
      return { outcome: 'blocked', reason: 'language_mismatch' };
    }
  }

  // Exclusions are honoured for EVERYONE, minors included. An exclusion can only ever
  // narrow reach, so there is no policy reason to ignore one — and ignoring it would
  // mean serving an ad to somebody the advertiser explicitly asked to leave out.
  if (targeting.excludeAudiences?.length && viewer.audienceIds?.length) {
    const excluded = targeting.excludeAudiences.some(a => viewer.audienceIds!.includes(a));
    if (excluded) return { outcome: 'blocked', reason: 'excluded_audience' };
  }

  const wantsInterests = Boolean(targeting.interests?.length);
  const wantsAudiences = Boolean(targeting.includeAudiences?.length);

  if (isMinor) {
    // THE RULE. Personalized dimensions are inert: not "matched loosely", not "matched
    // against a safe subset" — ignored entirely.
    const ignored: ClampedField[] = [];
    if (wantsInterests) ignored.push('interests');
    if (wantsAudiences) ignored.push('includeAudiences');

    if (!ignored.length) return { outcome: 'eligible' };

    // If personalization was the ONLY thing narrowing this audience, clamping it would
    // silently widen the ad set to every minor in the geo — which is not what the
    // advertiser asked for and not something they should get by accident. Block.
    const hasNonPersonalNarrowing =
      targeting.ageBands.length > 0 ||
      Boolean(targeting.geo.regions?.length) ||
      Boolean(targeting.geo.cities?.length) ||
      Boolean(targeting.languages?.length);

    if (!hasNonPersonalNarrowing) {
      return { outcome: 'blocked', reason: 'no_targeting_match_after_clamp' };
    }
    return { outcome: 'clamped', ignored };
  }

  // Adult path: personalization applies normally.
  if (wantsInterests) {
    const hit = targeting.interests!.some(i => viewer.interests?.includes(i));
    // An interest-targeted ad set with an audience include is an OR, not an AND: either
    // signal qualifies. Only fail when neither does.
    if (!hit && !wantsAudiences) return { outcome: 'blocked', reason: 'geo_mismatch' };
    if (hit) return { outcome: 'eligible' };
  }

  if (wantsAudiences) {
    const hit = targeting.includeAudiences!.some(a => viewer.audienceIds?.includes(a));
    if (!hit) return { outcome: 'blocked', reason: 'excluded_audience' };
  }

  return { outcome: 'eligible' };
}

/** Convenience for the serve path: may this viewer be shown this at all? */
export function isViewerEligible(
  targeting: AdTargeting,
  viewer: ViewerContext,
  opts?: { restrictedCategories?: readonly RestrictedCategory[] },
  policy?: TargetingPolicy,
): boolean {
  return resolveTargetingPolicy(targeting, viewer, opts, policy).outcome !== 'blocked';
}

// ─── Builder-side helpers ────────────────────────────────────────────────────────

/** Whether an audience definition can reach anyone under 18. Used by the builder to
 *  decide whether to show the "personalized targeting won't apply to under-18s" notice,
 *  and by the estimator to know it must subtract them. */
export function targetsMinors(targeting: AdTargeting, policy: TargetingPolicy = STRICT_POLICY): boolean {
  if (!targeting.ageBands.length) return true; // unspecified = everyone
  return targeting.ageBands.some(b => BAND_MIN_AGE[b] < policy.personalizedTargetingMinAge);
}

/** True when this ad set uses personalization that will be ignored for some of its
 *  audience — the exact condition the builder must warn about, because otherwise the
 *  advertiser believes they bought something they did not. */
export function hasClampedPersonalization(
  targeting: AdTargeting,
  policy: TargetingPolicy = STRICT_POLICY,
): boolean {
  const personalized = Boolean(targeting.interests?.length) || Boolean(targeting.includeAudiences?.length);
  return personalized && targetsMinors(targeting, policy);
}

/** Force an ad set to 18+ — what the builder applies when a restricted category is
 *  declared. Returns a NEW targeting object; never mutates. */
export function clampToAdults(targeting: AdTargeting): AdTargeting {
  const bands = targeting.ageBands.length ? targeting.ageBands : [...( ['13-17','18-24','25-34','35-44','45-54','55+'] as AgeBand[])];
  return { ...targeting, ageBands: bands.filter(b => BAND_MIN_AGE[b] >= ADULT_AGE) };
}
