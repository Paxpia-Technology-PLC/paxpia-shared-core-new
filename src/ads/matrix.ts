// The delivery CONTRACT: which optimization goals are legal for which objective, and
// which billing events are legal for which goal.
//
// This lives here as DATA rather than as validation code in the builder, because three
// independent things need the same answer and must not be able to disagree: the web
// builder (which renders the choices), the client-side validator (which blocks Next),
// and the Go ads service (which rejects a hand-rolled API call). Anything expressed as
// `if` statements in a form component is a rule the backend doesn't know about.

import type { AdObjective, OptimizationGoal, BillingEvent, BidStrategy } from './types';

export const OBJECTIVES: readonly AdObjective[] = [
  'awareness', 'traffic', 'engagement', 'followers', 'course_sales', 'leads',
];

/** Legal optimization goals per objective. First entry is the DEFAULT — the one Boost
 *  picks silently, and the one the builder preselects. */
export const GOALS_BY_OBJECTIVE: Record<AdObjective, readonly OptimizationGoal[]> = {
  awareness:    ['reach', 'impressions'],
  traffic:      ['link_clicks', 'destination_views'],
  engagement:   ['post_engagement', 'thruplay', 'video_views_2s'],
  followers:    ['follows', 'profile_visits'],
  course_sales: ['purchase', 'enroll_intent', 'value'],
  leads:        ['lead', 'message_started'],
};

/** Legal billing events per optimization goal. First entry is the default.
 *
 *  Impression billing (CPM) is available for EVERY goal, deliberately. Optimizing for
 *  purchases while paying per impression is not a compromise — it is the normal and
 *  usually correct configuration, because it lets the system spend on the impressions
 *  most likely to convert rather than only on the ones that already did. */
export const BILLING_BY_GOAL: Record<OptimizationGoal, readonly BillingEvent[]> = {
  reach:              ['impression'],
  impressions:        ['impression'],
  link_clicks:        ['impression', 'link_click'],
  destination_views:  ['impression', 'link_click'],
  post_engagement:    ['impression'],
  thruplay:           ['impression', 'thruplay'],
  video_views_2s:     ['impression'],
  follows:            ['impression'],
  profile_visits:     ['impression'],
  purchase:           ['impression'],
  enroll_intent:      ['impression'],
  value:              ['impression'],
  lead:               ['impression'],
  message_started:    ['impression'],
};

/** Bid strategies legal for a goal. `highest_value` needs a value signal to maximise,
 *  so it is only offered where the goal actually produces one. */
export function bidStrategiesFor(goal: OptimizationGoal): readonly BidStrategy[] {
  const base: BidStrategy[] = ['highest_volume', 'cost_per_result_goal', 'bid_cap'];
  return goal === 'value' ? [...base, 'highest_value'] : base;
}

/** Strategies that REQUIRE the advertiser to supply an amount. The inverse matters as
 *  much: sending a bidAmount with `highest_volume` is a bug, not a harmless extra. */
export function bidStrategyNeedsAmount(s: BidStrategy): boolean {
  return s === 'cost_per_result_goal' || s === 'bid_cap';
}

export function defaultGoalFor(objective: AdObjective): OptimizationGoal {
  return GOALS_BY_OBJECTIVE[objective][0];
}

export function defaultBillingFor(goal: OptimizationGoal): BillingEvent {
  return BILLING_BY_GOAL[goal][0];
}

export function isGoalLegal(objective: AdObjective, goal: OptimizationGoal): boolean {
  return GOALS_BY_OBJECTIVE[objective].includes(goal);
}

export function isBillingLegal(goal: OptimizationGoal, billing: BillingEvent): boolean {
  return BILLING_BY_GOAL[goal].includes(billing);
}

// ─── Validation ──────────────────────────────────────────────────────────────────

export interface DeliveryConfig {
  objective: AdObjective;
  optimizationGoal: OptimizationGoal;
  billingEvent: BillingEvent;
  bidStrategy: BidStrategy;
  bidAmount?: number;
}

export type ConfigProblem =
  | { code: 'goal_illegal_for_objective'; goal: OptimizationGoal; objective: AdObjective }
  | { code: 'billing_illegal_for_goal'; billing: BillingEvent; goal: OptimizationGoal }
  | { code: 'bid_strategy_illegal_for_goal'; strategy: BidStrategy; goal: OptimizationGoal }
  | { code: 'bid_amount_required'; strategy: BidStrategy }
  | { code: 'bid_amount_forbidden'; strategy: BidStrategy };

/** Returns every problem, not just the first — a builder that fixes one error only to
 *  reveal the next one is a bad builder. */
export function validateDeliveryConfig(c: DeliveryConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  if (!isGoalLegal(c.objective, c.optimizationGoal)) {
    problems.push({ code: 'goal_illegal_for_objective', goal: c.optimizationGoal, objective: c.objective });
  }
  if (!isBillingLegal(c.optimizationGoal, c.billingEvent)) {
    problems.push({ code: 'billing_illegal_for_goal', billing: c.billingEvent, goal: c.optimizationGoal });
  }
  if (!bidStrategiesFor(c.optimizationGoal).includes(c.bidStrategy)) {
    problems.push({ code: 'bid_strategy_illegal_for_goal', strategy: c.bidStrategy, goal: c.optimizationGoal });
  }

  const needs = bidStrategyNeedsAmount(c.bidStrategy);
  const has = typeof c.bidAmount === 'number' && c.bidAmount > 0;
  if (needs && !has) problems.push({ code: 'bid_amount_required', strategy: c.bidStrategy });
  if (!needs && has) problems.push({ code: 'bid_amount_forbidden', strategy: c.bidStrategy });

  return problems;
}

// ─── What counts as a RESULT ─────────────────────────────────────────────────────
//
// "Results" and "Cost per result" are the two figures an advertiser actually decides on,
// and generic labels make them undecidable: 5 of what, costing 12 birr each? The answer
// is objective-dependent by definition — a result IS the thing they asked for — so the
// label and the number both have to come from the objective rather than from one column.
//
// The SOURCE matters as much as the label. Not every objective produces a conversion
// event: an awareness campaign's result is the view itself, already counted as an
// impression, and reporting 0 results for a campaign that delivered 40,000 views would be
// wrong in the direction that makes the advertiser think the product is broken. So each
// objective names which measured figure carries its results, and no figure is invented.

/** Which measured column an objective's results are read from. */
export type ResultSource = 'impressions' | 'clicks' | 'conversions';

export const RESULT_SOURCE_BY_OBJECTIVE: Record<AdObjective, ResultSource> = {
  awareness:    'impressions',   // the view IS the result
  traffic:      'clicks',        // the tap-through IS the result
  engagement:   'clicks',        // CTA taps; a like is not reported (see SponsoredPostCard)
  followers:    'conversions',   // 'follow' conversions
  course_sales: 'conversions',   // 'course_purchase' / 'enroll' conversions
  leads:        'conversions',   // 'lead' / 'message_started' conversions
};

/** i18n key for the plural noun, e.g. `ads.result.followers` → "Follows". */
export const RESULT_LABEL_KEYS: Record<AdObjective, string> = {
  awareness:    'ads.result.awareness',
  traffic:      'ads.result.traffic',
  engagement:   'ads.result.engagement',
  followers:    'ads.result.followers',
  course_sales: 'ads.result.courseSales',
  leads:        'ads.result.leads',
};

/** i18n key for the cost line, e.g. `ads.resultCost.followers` → "Cost per follow". */
export const RESULT_COST_LABEL_KEYS: Record<AdObjective, string> = {
  awareness:    'ads.resultCost.awareness',
  traffic:      'ads.resultCost.traffic',
  engagement:   'ads.resultCost.engagement',
  followers:    'ads.resultCost.followers',
  course_sales: 'ads.resultCost.courseSales',
  leads:        'ads.resultCost.leads',
};

/** The measured figures a result count can be read from. */
export interface ResultCounts {
  impressions: number;
  clicks: number;
  conversions: number;
}

/**
 * How many results this campaign got.
 *
 * A plain lookup and deliberately nothing more — no blending, no estimating, no falling
 * back to a different column when one reads zero. A `followers` campaign with no
 * conversions has zero results, and saying so is the point: it is what tells the
 * advertiser the ad is being seen but not working.
 */
export function resultsFor(objective: AdObjective, counts: ResultCounts): number {
  return counts[RESULT_SOURCE_BY_OBJECTIVE[objective]];
}

/**
 * Cost per result, in santim. Undefined when there are no results yet.
 *
 * Undefined rather than zero, and the caller renders it as a dash: a campaign that has
 * spent 400 birr for nothing has an *undefined* cost per result, and printing "0" reads
 * as free.
 */
export function costPerResult(
  objective: AdObjective,
  spendSantim: number,
  counts: ResultCounts,
): number | undefined {
  const n = resultsFor(objective, counts);
  return n > 0 ? Math.round(spendSantim / n) : undefined;
}

// ─── The learning phase ──────────────────────────────────────────────────────────

/** Optimization events an ad set needs before its predictions are trustworthy. The
 *  industry number is ~50 per week; the server owns the real target and sends it in
 *  diagnostics, so this is only the fallback for rendering a progress bar offline. */
export const LEARNING_TARGET_EVENTS = 50;

/** Edits that reset the learning phase, because they change the thing being predicted.
 *
 *  This list exists so the builder can WARN before saving. That warning looks like a UX
 *  nicety and is actually a statistical constraint surfacing through the interface:
 *  advertisers who edit daily never exit learning, get poor results, and churn. Hiding
 *  it generates support tickets no amount of documentation absorbs. */
export type EditField =
  | 'targeting' | 'optimizationGoal' | 'billingEvent' | 'bidStrategy' | 'bidAmount'
  | 'creative' | 'placements' | 'budget' | 'schedule' | 'name';

const RESET_ALWAYS: readonly EditField[] = [
  'targeting', 'optimizationGoal', 'billingEvent', 'bidStrategy', 'bidAmount',
  'creative', 'placements',
];

/** A budget change resets learning only if it is LARGE. Small tweaks are how pacing is
 *  normally managed and punishing them would make the system unusable. 20% is the
 *  conventional threshold. */
export const BUDGET_RESET_THRESHOLD = 0.2;

export function editResetsLearning(
  field: EditField,
  oldValue?: number,
  newValue?: number,
): boolean {
  if (RESET_ALWAYS.includes(field)) return true;
  if (field === 'budget') {
    if (typeof oldValue !== 'number' || typeof newValue !== 'number' || oldValue <= 0) return false;
    return Math.abs(newValue - oldValue) / oldValue > BUDGET_RESET_THRESHOLD;
  }
  // 'schedule' and 'name' never reset learning.
  return false;
}

/** Which of a set of pending edits will reset learning — so the warning can name them
 *  rather than saying "some of your changes". */
export function editsResettingLearning(
  edits: { field: EditField; oldValue?: number; newValue?: number }[],
): EditField[] {
  return edits.filter(e => editResetsLearning(e.field, e.oldValue, e.newValue)).map(e => e.field);
}
