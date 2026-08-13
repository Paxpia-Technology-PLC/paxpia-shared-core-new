// Reach estimation and budget maths — what the advertiser sees BEFORE they spend.
//
// ── WHY THIS IS IN THE SHARED CORE AND NOT IN THE SLIDER COMPONENT ──────────────
//
// The estimate is a promise. An advertiser who is shown "reaches 12,000–18,000" and
// receives 4,000 will not conclude that estimation is hard; they will conclude they were
// misled, and they will be right to. So the maths lives next to the delivery rules that
// determine actual reach, is unit-tested against them, and is used by the web builder,
// the mobile Boost flow and the Go service identically.
//
// ── WHY A RANGE, NEVER A NUMBER ─────────────────────────────────────────────────
//
// The honest output of this calculation is an interval. Auction prices move, inventory
// varies by hour, and the CTR estimate for a brand-new ad is a prior rather than a
// measurement. A single figure implies a precision that does not exist — and it is the
// figure the advertiser will hold you to.
//
// ── THE MINOR CLAMP ─────────────────────────────────────────────────────────────
//
// Under the strict policy, interest and audience targeting are inert against under-18
// viewers. An estimator that ignored that would count people the auction can never
// reach, so a personalised ad set targeting a young audience would promise reach it
// cannot deliver. `estimateReach` subtracts them. See ./targeting.

import type { AdPlacement, AdTargeting, Santim } from './types';
import { targetsMinors, type TargetingPolicy, STRICT_POLICY } from './targeting';

/** Indicative CPM floor per placement, in santim. The server is the pricing authority —
 *  these exist so the client can render an estimate before any auction has run, and are
 *  replaced by server-quoted figures the moment `/ads/estimate` answers. */
export const FLOOR_CPM: Record<AdPlacement, Santim> = {
  // 45 birr per 1,000 — a reasonable launch floor for a thin auction.
  precept: 4_500 as Santim,
  // Full-screen video is worth more per impression.
  reels: 6_500 as Santim,
};

/** How wide the estimate interval is. ±35% reflects genuine auction variance rather
 *  than a decorative band; narrowing it would be a claim we cannot support. */
const RANGE_SPREAD = 0.35;

/** Fraction of an audience realistically reachable in one campaign. Nobody reaches
 *  100% of a targeted audience — people don't all open the app, and frequency capping
 *  means budget goes to repeat impressions before it exhausts the pool. */
const MAX_AUDIENCE_PENETRATION = 0.45;

/** Share of the 13–17 band in a typical Paxpia audience. Used only to discount an
 *  estimate when personalised targeting cannot apply to them. Server-provided figures
 *  supersede this the moment they exist. */
const MINOR_AUDIENCE_SHARE = 0.22;

export interface ReachEstimate {
  /** Distinct people, low end. */
  min: number;
  /** Distinct people, high end. */
  max: number;
  /** Impressions the budget buys at the assumed price. */
  impressions: number;
  /** Assumed price used, so the UI can explain the number rather than assert it. */
  assumedCpm: Santim;
  /** True when the estimate was reduced because personalised targeting is inert against
   *  part of the audience. The builder MUST surface this — an advertiser who is not told
   *  believes they bought something they did not. */
  minorClamped: boolean;
}

export interface EstimateInput {
  /** Total spend for the whole run, in santim. */
  budgetSantim: Santim;
  placement: AdPlacement;
  targeting: AdTargeting;
  /** Server-provided size of the targeted audience. Absent → unbounded (no cap applied). */
  audienceSize?: number;
  /** Server-quoted CPM. Absent → the placement floor. */
  quotedCpm?: Santim;
  policy?: TargetingPolicy;
}

/**
 * Estimate distinct reach for a budget.
 *
 * Deliberately conservative in every direction where an error would flatter the number:
 * it caps at a fraction of the audience, discounts minors when personalisation cannot
 * apply, and reports a range rather than a point.
 */
export function estimateReach(input: EstimateInput): ReachEstimate {
  const policy = input.policy ?? STRICT_POLICY;
  const cpm = input.quotedCpm ?? FLOOR_CPM[input.placement];

  if (input.budgetSantim <= 0 || cpm <= 0) {
    return { min: 0, max: 0, impressions: 0, assumedCpm: cpm, minorClamped: false };
  }

  const impressions = Math.floor((input.budgetSantim / cpm) * 1000);

  // Frequency: an impression is not a person. Assume each reached person sees it ~1.7
  // times over a short run — below that and the campaign is not memorable, above it and
  // frequency capping intervenes.
  const ASSUMED_FREQUENCY = 1.7;
  let people = Math.floor(impressions / ASSUMED_FREQUENCY);

  const personalised =
    Boolean(input.targeting.interests?.length) || Boolean(input.targeting.includeAudiences?.length);
  const minorClamped = personalised && targetsMinors(input.targeting, policy);

  let reachableAudience = input.audienceSize;
  if (minorClamped && typeof reachableAudience === 'number') {
    // The under-18 slice cannot be reached by this ad set's personalised targeting, so
    // it is not part of what the budget can buy.
    reachableAudience = Math.floor(reachableAudience * (1 - MINOR_AUDIENCE_SHARE));
  }

  if (typeof reachableAudience === 'number' && reachableAudience > 0) {
    people = Math.min(people, Math.floor(reachableAudience * MAX_AUDIENCE_PENETRATION));
  }

  return {
    min: Math.max(0, Math.floor(people * (1 - RANGE_SPREAD))),
    max: Math.max(0, Math.floor(people * (1 + RANGE_SPREAD))),
    impressions,
    assumedCpm: cpm,
    minorClamped,
  };
}

// ─── Budget presets ─────────────────────────────────────────────────────────────

/** Daily budget rungs, in santim. Chosen for Ethiopian price expectations rather than
 *  copied from a US product: 25 birr/day is a real amount of money to a tutor and must
 *  be a first-class option, not an awkward minimum. */
export const DAILY_BUDGET_STEPS: readonly Santim[] = [
  2_500, 5_000, 10_000, 20_000, 35_000, 50_000, 100_000,
] as unknown as readonly Santim[];

export const DURATION_DAYS_STEPS: readonly number[] = [1, 3, 5, 7, 14, 30];

export const MIN_DAILY_BUDGET = 2_500 as Santim;  // 25 birr

/** Total spend for a daily budget over N days. */
export function lifetimeFromDaily(daily: Santim, days: number): Santim {
  return (daily * Math.max(1, days)) as Santim;
}

/** Nearest legal rung to an arbitrary amount — what a slider snaps to. */
export function snapDailyBudget(amount: number): Santim {
  let best = DAILY_BUDGET_STEPS[0];
  for (const step of DAILY_BUDGET_STEPS) {
    if (Math.abs(step - amount) < Math.abs(best - amount)) best = step;
  }
  return best;
}

export type BudgetProblem =
  | { code: 'below_minimum'; minimum: Santim }
  | { code: 'insufficient_credit'; required: Santim; available: Santim };

/** Everything that can stop a Boost from being submitted, reported together. */
export function validateBudget(
  daily: Santim,
  days: number,
  availableCredit: Santim,
): BudgetProblem[] {
  const problems: BudgetProblem[] = [];
  if (daily < MIN_DAILY_BUDGET) problems.push({ code: 'below_minimum', minimum: MIN_DAILY_BUDGET });

  const required = lifetimeFromDaily(daily, days);
  if (required > availableCredit) {
    problems.push({ code: 'insufficient_credit', required, available: availableCredit });
  }
  return problems;
}
