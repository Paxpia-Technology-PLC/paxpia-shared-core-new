// Frequency capping — how often one person may see the same thing.
//
// ── WHY THE CLIENT HAS A LIMITER AT ALL ──────────────────────────────────────────
//
// The server paces delivery and is the real authority. This is a second, independent
// limiter underneath it, and the duplication is deliberate: a server pacing bug, a bad
// experiment, or an over-eager fill response must not be able to turn somebody's feed
// into an ad break. The blast radius of "the server sent 40 fills" should be "the
// client used 4", not "the user uninstalled".
//
// The rules here are a FLOOR, never a ceiling — they can only ever show FEWER ads than
// the server asked for. That direction is what makes running both safe.
//
// ── WHY REACH×FREQUENCY MATTERS MORE THAN IMPRESSIONS ────────────────────────────
//
// 100,000 impressions can be 100,000 people seeing an ad once or 10,000 people seeing
// it ten times. The second costs the advertiser the same and actively damages the app,
// because the eleventh viewing is where users start resenting you. Capping frequency is
// how a marketplace protects the asset it is selling access to.

import type { AdFill, AdPlacement } from './types';

export interface FrequencyRules {
  /** Hard ceiling on ads shown per placement per session. */
  maxPerSession: number;
  /** Minimum milliseconds between two ads on the same surface. Reels needs this because
   *  a swipe can cross several items a second — cadence alone doesn't bound TIME. */
  minGapMs: number;
  /** Max times ONE campaign may be shown to this viewer per session. Stops a single
   *  advertiser owning every slot when the fill response is thin. */
  maxPerCampaignPerSession: number;
}

export const DEFAULT_RULES: Record<AdPlacement, FrequencyRules> = {
  precept: { maxPerSession: 4, minGapMs: 0,      maxPerCampaignPerSession: 2 },
  // 90s between reels ads: at ~10s a reel that is roughly one ad per nine organic
  // videos even if the cadence would allow more.
  reels:   { maxPerSession: 4, minGapMs: 90_000, maxPerCampaignPerSession: 2 },
};

/** Everything the limiter needs to remember. Plain JSON so a caller can persist it to
 *  MMKV / localStorage and restore it, and so it can be asserted on in a test. */
export interface FrequencyState {
  /** Ads shown this session, per placement. */
  shown: Record<string, number>;
  /** Last shown timestamp (epoch ms), per placement. */
  lastShownMs: Record<string, number>;
  /** Times each campaign has been shown this session. */
  perCampaign: Record<string, number>;
}

export function emptyFrequencyState(): FrequencyState {
  return { shown: {}, lastShownMs: {}, perCampaign: {} };
}

export type CapDecision =
  | { allowed: true }
  | { allowed: false; reason: 'session_cap' | 'campaign_cap' | 'too_soon' };

/**
 * May this fill be shown right now?
 *
 * `nowMs` is injected rather than read from the clock so this stays pure and a test can
 * advance time without waiting for it.
 */
export function canShow(
  state: FrequencyState,
  fill: AdFill,
  nowMs: number,
  rules: FrequencyRules = DEFAULT_RULES[fill.placement],
): CapDecision {
  const placement = fill.placement;

  if ((state.shown[placement] ?? 0) >= rules.maxPerSession) {
    return { allowed: false, reason: 'session_cap' };
  }
  if ((state.perCampaign[fill.campaignId] ?? 0) >= rules.maxPerCampaignPerSession) {
    return { allowed: false, reason: 'campaign_cap' };
  }
  const last = state.lastShownMs[placement];
  if (rules.minGapMs > 0 && typeof last === 'number' && nowMs - last < rules.minGapMs) {
    return { allowed: false, reason: 'too_soon' };
  }
  return { allowed: true };
}

/** Record that a fill was actually shown. Returns a NEW state — the caller decides when
 *  to commit it, which keeps "we considered showing this" and "we showed this" from
 *  collapsing into the same event. */
export function recordShown(state: FrequencyState, fill: AdFill, nowMs: number): FrequencyState {
  return {
    shown: { ...state.shown, [fill.placement]: (state.shown[fill.placement] ?? 0) + 1 },
    lastShownMs: { ...state.lastShownMs, [fill.placement]: nowMs },
    perCampaign: { ...state.perCampaign, [fill.campaignId]: (state.perCampaign[fill.campaignId] ?? 0) + 1 },
  };
}

/**
 * Filter a fill list down to what may actually be shown, in order, applying the caps as
 * if each survivor were shown in turn.
 *
 * Note this SIMULATES rather than commits: the returned state is not applied anywhere.
 * Committing happens when an ad genuinely reaches the screen (an impression), because
 * a fill that was woven into an array the user never scrolled to was not "shown" and
 * must not consume the user's daily patience for ads.
 */
export function applyCaps(
  state: FrequencyState,
  fills: readonly AdFill[],
  nowMs: number,
  rulesFor: (p: AdPlacement) => FrequencyRules = p => DEFAULT_RULES[p],
): AdFill[] {
  let sim = state;
  const out: AdFill[] = [];
  // Successive ads in one weave are separated by `everyN` organic items, not by time,
  // so simulating them all at `nowMs` would make minGapMs reject every one after the
  // first. Advance the simulated clock by the gap for each accepted ad instead.
  let cursor = nowMs;

  for (const fill of fills) {
    const rules = rulesFor(fill.placement);
    const decision = canShow(sim, fill, cursor, rules);
    if (!decision.allowed) {
      // A session/campaign cap is terminal for this fill but not for the next one (a
      // different campaign may still pass), so keep going rather than breaking.
      continue;
    }
    out.push(fill);
    sim = recordShown(sim, fill, cursor);
    cursor += rules.minGapMs;
  }
  return out;
}
