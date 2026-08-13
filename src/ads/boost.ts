// Boost — the three-tap path from "I made a post" to "I am running a campaign".
//
// ── WHY BOOST IS NOT A SEPARATE CODE PATH ───────────────────────────────────────
//
// The temptation is to model a boost as its own lightweight thing: one object, one
// price, no hierarchy. That is how you end up with two ad systems, and with an
// advertiser who boosted a post being unable to open it in the manager later, edit its
// audience, or see it beside their other campaigns.
//
// So Boost EXPANDS into the same Campaign → AdSet → Ad the full builder produces. The
// simplification is entirely in the UI: three questions instead of five steps, with the
// objective inferred, the creative taken from the post, and everything else defaulted.
// Meta's real lesson is that Boost — not Ads Manager — is what converts the long tail,
// and this is the shape that lets it do that without forking the model.
//
// ── WHY THE EXPANSION IS PURE ───────────────────────────────────────────────────
//
// It takes ids and a clock as arguments rather than generating them. That keeps it
// deterministic and testable, and it means the SERVER can run the identical function to
// validate what the client claims it created.

import type {
  AdBudget, AdObjective, AdPlacement, AdSet, AdTargeting, Ad, AdCreativeDraft,
  Campaign, AdAccountId, CampaignId, AdSetId, AdId, Santim, AgeBand,
} from './types';
import { defaultGoalFor, defaultBillingFor } from './matrix';
import { lifetimeFromDaily } from './estimate';

/** The three questions Boost actually asks. Everything else is inferred or defaulted. */
export interface BoostInput {
  postId: string;
  /** Question 1 — what do you want? A deliberately short list; the full six objectives
   *  live in the web builder where there is room to explain them. */
  goal: BoostGoal;
  /** Question 2 — who? Presets, not a targeting editor. */
  audience: BoostAudience;
  /** Question 3 — how much, for how long? */
  dailyBudget: Santim;
  durationDays: number;
  /** Taken from the post, not authored in the flow. */
  creative: AdCreativeDraft;
  /** Where it should run. Empty = automatic (every eligible placement). */
  placements?: AdPlacement[];
}

/** Boost's reduced objective set. Each maps onto a real `AdObjective` — the model never
 *  sees "boost goals", only objectives. */
export type BoostGoal = 'more_views' | 'more_followers' | 'more_sales';

const GOAL_TO_OBJECTIVE: Record<BoostGoal, AdObjective> = {
  more_views: 'awareness',
  more_followers: 'followers',
  more_sales: 'course_sales',
};

export type BoostAudience = 'automatic' | 'my_followers' | 'students_nearby';

export interface BoostContext {
  accountId: AdAccountId;
  campaignId: CampaignId;
  adSetId: AdSetId;
  adId: AdId;
  /** Epoch seconds. Injected so the expansion stays pure. */
  nowUnix: number;
  /** Viewer's country/region, for the location presets. */
  country: string;
  region?: string;
  /** The advertiser's own follower audience id, when one exists. */
  followerAudienceId?: string;
}

/** All ages 18+. Boost never offers minor targeting — a three-tap flow is exactly where
 *  a well-meaning advertiser would reach a 14-year-old by accident, and no preset here
 *  is worth that. Reaching under-18s at all requires the full builder and an explicit
 *  age-band choice. */
const BOOST_AGE_BANDS: AgeBand[] = ['18-24', '25-34', '35-44', '45-54', '55+'];

function targetingFor(audience: BoostAudience, ctx: BoostContext): AdTargeting {
  const base: AdTargeting = {
    geo: { country: ctx.country },
    ageBands: BOOST_AGE_BANDS,
  };

  switch (audience) {
    case 'my_followers':
      return ctx.followerAudienceId
        ? { ...base, includeAudiences: [ctx.followerAudienceId as never] }
        : base;
    case 'students_nearby':
      return ctx.region ? { ...base, geo: { country: ctx.country, regions: [ctx.region] } } : base;
    case 'automatic':
    default:
      // Deliberately unnarrowed: let delivery find the people, which is what an
      // optimisation system is for and what an advertiser guessing at interests is not.
      return base;
  }
}

export interface BoostExpansion {
  campaign: Campaign;
  adSet: AdSet;
  ad: Ad;
  /** Total to reserve from Ad Credit, in santim. */
  totalSantim: Santim;
}

/**
 * Expand a Boost into the four real objects.
 *
 * Everything defaulted here is defaulted deliberately:
 *   • `highest_volume` bidding — Boost never shows a bid input, because a cost cap is
 *     where inexperienced advertisers throttle their own delivery to zero and conclude
 *     the product doesn't work.
 *   • a LIFETIME budget — the run has a fixed end, so there is a definite total, which
 *     is the number a first-time advertiser actually wants to know.
 *   • impression billing — see the matrix; optimising for sales while paying per
 *     impression is the normal configuration, not a compromise.
 */
export function expandBoost(input: BoostInput, ctx: BoostContext): BoostExpansion {
  const objective = GOAL_TO_OBJECTIVE[input.goal];
  const optimizationGoal = defaultGoalFor(objective);
  const total = lifetimeFromDaily(input.dailyBudget, input.durationDays);

  const budget: AdBudget = { kind: 'lifetime', amount: total, currency: 'ETB' };

  const campaign: Campaign = {
    id: ctx.campaignId,
    accountId: ctx.accountId,
    name: boostName(input, ctx.nowUnix),
    objective,
    state: 'in_review',
    createdUnix: ctx.nowUnix,
    fromPostId: input.postId,
  };

  const adSet: AdSet = {
    id: ctx.adSetId,
    campaignId: ctx.campaignId,
    name: 'Default',
    targeting: targetingFor(input.audience, ctx),
    placements: input.placements ?? [],
    budget,
    schedule: {
      startUnix: ctx.nowUnix,
      endUnix: ctx.nowUnix + input.durationDays * 86_400,
    },
    optimizationGoal,
    billingEvent: defaultBillingFor(optimizationGoal),
    bidStrategy: 'highest_volume',
    attribution: '1d_view_7d_click',
    state: 'in_review',
  };

  const ad: Ad = {
    id: ctx.adId,
    adSetId: ctx.adSetId,
    name: 'Boosted post',
    creative: input.creative,
    state: 'in_review',
  };

  return { campaign, adSet, ad, totalSantim: total };
}

/** A name the advertiser will recognise in a list six weeks later. Derived from the
 *  creative rather than "Campaign 4". */
function boostName(input: BoostInput, nowUnix: number): string {
  const headline = input.creative.headline?.trim();
  if (headline) return headline.length > 40 ? `${headline.slice(0, 37)}…` : headline;
  const d = new Date(nowUnix * 1000);
  return `Boosted post · ${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Copy key per goal, so the three chips read as outcomes rather than as jargon. */
export const BOOST_GOAL_KEYS: Record<BoostGoal, string> = {
  more_views: 'ads.boost.goal.views',
  more_followers: 'ads.boost.goal.followers',
  more_sales: 'ads.boost.goal.sales',
};

export const BOOST_AUDIENCE_KEYS: Record<BoostAudience, string> = {
  automatic: 'ads.boost.audience.automatic',
  my_followers: 'ads.boost.audience.followers',
  students_nearby: 'ads.boost.audience.nearby',
};

/** One line saying what the option actually DOES, shown under its label.
 *
 *  These are not decoration. "More views / More followers / More sales" is three outcomes
 *  everybody wants, presented as though they were mutually exclusive, with nothing to
 *  choose between them — which makes the first real decision in the flow a coin-flip. The
 *  hint is what turns it into a choice: it names the trade (reach vs. intent) that the
 *  label alone hides.
 *
 *  Deliberately phrased as AIM rather than promise. Delivery does not yet optimise on the
 *  objective, so "gets you followers" would be a guarantee the auction cannot honour. */
export const BOOST_GOAL_HINT_KEYS: Record<BoostGoal, string> = {
  more_views: 'ads.boost.goalHint.views',
  more_followers: 'ads.boost.goalHint.followers',
  more_sales: 'ads.boost.goalHint.sales',
};

export const BOOST_AUDIENCE_HINT_KEYS: Record<BoostAudience, string> = {
  automatic: 'ads.boost.audienceHint.automatic',
  my_followers: 'ads.boost.audienceHint.followers',
  students_nearby: 'ads.boost.audienceHint.nearby',
};

/** The option a creator with no reason to think otherwise should take. Marked in the UI
 *  rather than merely preselected — an unexplained default reads as an arbitrary one. */
export const BOOST_DEFAULT_GOAL: BoostGoal = 'more_views';
export const BOOST_DEFAULT_AUDIENCE: BoostAudience = 'automatic';

export const BOOST_GOALS: readonly BoostGoal[] = ['more_views', 'more_followers', 'more_sales'];
export const BOOST_AUDIENCES: readonly BoostAudience[] = ['automatic', 'my_followers', 'students_nearby'];
