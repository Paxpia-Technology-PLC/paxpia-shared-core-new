// @paxpia/core/ads — PLACEHOLDER module.
//
// The mobile app's `src/features/ads/*` (23 files, "ADS and refinement") expects a real
// shared ads domain module here — auction/targeting model, money math, feed-weaving,
// frequency capping — but no such module exists anywhere in this repo's history (checked
// local working tree, origin/main, upstream-old: all clean, 2026-08-15). Without SOME
// implementation the mobile Metro bundle cannot resolve `@paxpia/core/ads` at all, which
// blocks the ENTIRE app — not just the ads screens — from building on device/simulator.
//
// This file exists to unblock that build. It is intentionally minimal:
//   - Pure, well-defined helpers (money formatting, WCAG contrast, percentages) are
//     implemented FOR REAL — they're cheap to get right and used outside ads too.
//   - Ads-specific business rules (weaving, frequency capping, budget validation, reach
//     estimation, boost expansion) are permissive placeholders: they never crash, but
//     they do not implement the real auction/pacing/targeting logic the comments in the
//     mobile code describe. The ads feature will not behave correctly until this is
//     replaced with the real implementation.
//
// Shapes were reverse-engineered from call sites in Paxpia-mobile/src/features/ads/**
// (types.ts, api/*.ts, store/adPrefsStore.ts, delivery/useAdWovenFeed.ts, screens/*.tsx).

// ─── Branded id / money types ──────────────────────────────────────────────────────

export type AdId = string & { readonly __brand?: 'AdId' };
export type CampaignId = string & { readonly __brand?: 'CampaignId' };
export type AdSetId = string & { readonly __brand?: 'AdSetId' };
export type AdAccountId = string & { readonly __brand?: 'AdAccountId' };
export type CreativeId = string & { readonly __brand?: 'CreativeId' };
export type FillToken = string & { readonly __brand?: 'FillToken' };
/** Ethiopian birr, in cents (santim). */
export type Santim = number & { readonly __brand?: 'Santim' };

// ─── Placement / targeting ─────────────────────────────────────────────────────────

export type AdPlacement = 'precept' | 'reels' | 'feed';
const AD_PLACEMENTS: ReadonlySet<string> = new Set<AdPlacement>(['precept', 'reels', 'feed']);
export function isAdPlacement(x: unknown): x is AdPlacement {
  return typeof x === 'string' && AD_PLACEMENTS.has(x);
}

export interface AdTarget {
  kind: 'url' | 'route';
  url?: string;
  route?: string;
}

export type AdCtaLabel =
  | 'learn_more' | 'shop_now' | 'sign_up' | 'follow' | 'view_course' | 'contact' | 'get_app';

export interface CreativeSpec {
  maxWidth?: number;
  maxHeight?: number;
  aspectRatio?: number;
  maxDurationSecs?: number;
  maxFileSizeMB?: number;
}

/** Keyed by placement; any placement not listed falls back to a permissive default via
 *  the Proxy below rather than throwing on `CREATIVE_SPECS[placement]`. */
const CREATIVE_SPEC_DEFAULTS: Record<AdPlacement, CreativeSpec> = {
  precept: { maxWidth: 1080, maxHeight: 1350, aspectRatio: 4 / 5, maxFileSizeMB: 30 },
  reels: { maxWidth: 1080, maxHeight: 1920, aspectRatio: 9 / 16, maxDurationSecs: 60, maxFileSizeMB: 100 },
  feed: { maxWidth: 1080, maxHeight: 1350, aspectRatio: 4 / 5, maxFileSizeMB: 30 },
};
export const CREATIVE_SPECS: Record<string, CreativeSpec> = new Proxy(CREATIVE_SPEC_DEFAULTS, {
  get: (target, prop: string) => (target as Record<string, CreativeSpec>)[prop] ?? CREATIVE_SPEC_DEFAULTS.feed,
});

// ─── Creative / fill / campaign shapes ─────────────────────────────────────────────

export interface AdCreativeMedia {
  kind: 'image' | 'video';
  url: string;
  posterUrl?: string;
}

export interface AdCreativeDraft {
  id?: CreativeId;
  media: AdCreativeMedia;
  headline?: string;
  body?: string;
  cta?: { label: AdCtaLabel; target: AdTarget };
  brandColor?: string;
}

export interface AdFill {
  adId: AdId;
  campaignId: CampaignId;
  fillToken: FillToken;
  placement: AdPlacement;
  advertiser: { id: string; name: string; avatar: string; verified: boolean; isFollowing?: boolean };
  creative: {
    media: AdCreativeMedia;
    headline?: string;
    body?: string;
    cta?: { label: AdCtaLabel; target: AdTarget };
    brandColor?: string;
  };
  socialProof?: { firstFollowerName: string; othersCount: number };
  disclosure?: { reasons: string[] };
}

export interface AdServeResponse {
  fills: AdFill[];
  ttlSecs: number;
}

export interface AdPreferences {
  [key: string]: unknown;
}

export type AdEventType = 'impression' | 'click' | 'conversion' | 'hide' | 'report';
export interface AdEvent {
  adId: AdId;
  campaignId: CampaignId;
  fillToken: FillToken;
  type: AdEventType;
  ts: number;
}

export type AdConversionKind = 'purchase' | 'signup' | 'lead' | 'install' | 'other';

export type DeliveryState = 'active' | 'paused' | 'completed' | 'out_of_credit' | 'rejected';

export interface Campaign {
  id: CampaignId;
  objective: string;
  state: DeliveryState;
  [key: string]: unknown;
}
export interface AdSet {
  id: AdSetId;
  campaignId: CampaignId;
  [key: string]: unknown;
}
export interface Ad {
  id: AdId;
  adSetId: AdSetId;
  [key: string]: unknown;
}

// ─── Boost (create-a-campaign-from-a-post) ─────────────────────────────────────────

export type BoostGoal = 'awareness' | 'traffic' | 'engagement' | 'leads';
export type BoostAudience = 'broad' | 'similar_to_followers' | 'local';

export const BOOST_GOALS: BoostGoal[] = ['awareness', 'traffic', 'engagement', 'leads'];
export const BOOST_AUDIENCES: BoostAudience[] = ['broad', 'similar_to_followers', 'local'];
export const BOOST_DEFAULT_GOAL: BoostGoal = 'traffic';
export const BOOST_DEFAULT_AUDIENCE: BoostAudience = 'broad';

const fallbackKeyMap = (prefix: string) => new Proxy({} as Record<string, string>, {
  get: (_t, prop: string) => `${prefix}.${String(prop)}`,
});
export const BOOST_GOAL_KEYS: Record<BoostGoal, string> = fallbackKeyMap('ads.boost.goal') as Record<BoostGoal, string>;
export const BOOST_GOAL_HINT_KEYS: Record<BoostGoal, string> = fallbackKeyMap('ads.boost.goalHint') as Record<BoostGoal, string>;
export const BOOST_AUDIENCE_KEYS: Record<BoostAudience, string> = fallbackKeyMap('ads.boost.audience') as Record<BoostAudience, string>;
export const BOOST_AUDIENCE_HINT_KEYS: Record<BoostAudience, string> = fallbackKeyMap('ads.boost.audienceHint') as Record<BoostAudience, string>;

export const RESULT_LABEL_KEYS: Record<string, string> = fallbackKeyMap('ads.result');
export const RESULT_COST_LABEL_KEYS: Record<string, string> = fallbackKeyMap('ads.resultCost');
export const LEARNING_TARGET_EVENTS = 50;

/** Daily budget steps, in Santim (100, 200, 500, 1000, 2000, 5000 birr). */
export const DAILY_BUDGET_STEPS: Santim[] = [10000, 20000, 50000, 100000, 200000, 500000] as Santim[];
export const DURATION_DAYS_STEPS: number[] = [1, 3, 5, 7, 14, 30];

export const AD_CAPTION_MAX_LENGTH = 125;
export const AD_LINK_MAX_LENGTH = 2048;

export interface BoostInput {
  postId: string;
  goal: BoostGoal;
  audience: BoostAudience;
  dailyBudgetSantim: Santim;
  durationDays: number;
  link?: string;
  creative: AdCreativeDraft;
  [key: string]: unknown;
}

export interface BoostContext {
  campaignId: CampaignId;
  adSetId: AdSetId;
  adId: AdId;
  postId?: string;
  [key: string]: unknown;
}

/** PLACEHOLDER: builds the same {campaign, adSet, ad} shape the server would, from the
 *  Boost form input. Real targeting/pacing rules are NOT implemented. */
export function expandBoost(
  input: BoostInput,
  ctx: BoostContext,
): { campaign: Campaign; adSet: AdSet; ad: Ad } {
  return {
    campaign: {
      id: ctx.campaignId,
      objective: input.goal,
      state: 'active',
      dailyBudgetSantim: input.dailyBudgetSantim,
      durationDays: input.durationDays,
    },
    adSet: { id: ctx.adSetId, campaignId: ctx.campaignId, audience: input.audience },
    ad: { id: ctx.adId, adSetId: ctx.adSetId, creative: input.creative },
  };
}

export interface BudgetProblem {
  code: string;
  required?: Santim;
  available?: Santim;
  minimum?: Santim;
}

/** PLACEHOLDER: only checks the available balance covers the lifetime spend. The real
 *  server-side rules (minimum daily budget, pacing floors, etc.) are not modeled. */
export function validateBudget(daily: Santim, days: number, availableSantim: Santim): BudgetProblem[] {
  const problems: BudgetProblem[] = [];
  const total = lifetimeFromDaily(daily, days);
  if (total > availableSantim) {
    problems.push({ code: 'insufficient_credit', required: total, available: availableSantim });
  }
  return problems;
}

export interface ReachEstimate {
  min: number;
  max: number;
}

/** PLACEHOLDER: a rough, deterministic guess (roughly 1 reached person per 2 birr spent,
 *  +/-30%) — not a real auction/inventory model. */
export function estimateReach(opts: {
  budgetSantim: Santim;
  placement: AdPlacement;
  targeting?: { geo?: { country?: string }; ageBands?: string[] };
}): ReachEstimate {
  const birr = opts.budgetSantim / 100;
  const mid = Math.max(50, Math.round(birr * 5));
  return { min: Math.round(mid * 0.7), max: Math.round(mid * 1.3) };
}

// ─── Frequency capping ─────────────────────────────────────────────────────────────

export interface FrequencyState {
  shownAt: Record<string, number[]>;
}

export function emptyFrequencyState(): FrequencyState {
  return { shownAt: {} };
}

/** PLACEHOLDER: records a shown timestamp per advertiser but never actually caps —
 *  matches the "client-side floor under the server's pacing" comment insofar as it
 *  never blocks anything; the real capping window/limit is not implemented. */
export function recordShown(state: FrequencyState, fill: AdFill, now: number): FrequencyState {
  const key = fill.advertiser.id;
  const prior = state.shownAt[key] ?? [];
  return { shownAt: { ...state.shownAt, [key]: [...prior, now].slice(-20) } };
}

/** PLACEHOLDER: passthrough — every visible fill is "eligible". No real frequency cap. */
export function applyCaps(_frequency: FrequencyState, fills: AdFill[], _now: number): AdFill[] {
  return fills;
}

// ─── Feed weaving ───────────────────────────────────────────────────────────────────

/** How many ad slots a feed of this length should carry. PLACEHOLDER: one slot per 10
 *  organic items, small caps per placement — not the real pacing/inventory logic. */
export function slotCountFor(feedLength: number, _placement: AdPlacement): number {
  if (feedLength <= 0) return 0;
  return Math.min(3, Math.floor(feedLength / 10));
}

export interface WeaveHelpers<TPost> {
  toItem: (fill: AdFill, anchorOrganicId: string) => TPost;
  idOf: (p: TPost) => string;
  isReservedSlot?: (index: number) => boolean;
}

/** PLACEHOLDER: inserts fills evenly spaced through the organic array (skipping reserved
 *  slots), anchored to the organic post immediately before each insertion point. This is
 *  NOT the real weaving algorithm — just enough to keep the list rendering. */
export function weaveAds<TPost>(
  organic: TPost[],
  eligible: AdFill[],
  placement: AdPlacement,
  helpers: WeaveHelpers<TPost>,
): TPost[] {
  if (!eligible.length || !organic.length) return organic;
  const gap = Math.max(3, Math.floor(organic.length / (eligible.length + 1)));
  const out: TPost[] = [];
  let fillIdx = 0;
  for (let i = 0; i < organic.length; i++) {
    out.push(organic[i]);
    const isDue = (i + 1) % gap === 0 && fillIdx < eligible.length;
    if (isDue && !(helpers.isReservedSlot?.(out.length))) {
      const fill = eligible[fillIdx++];
      out.push(helpers.toItem(fill, helpers.idOf(organic[i])));
    }
  }
  return out;
}

// ─── Ad <-> Post bridge helpers (sponsored item ids) ───────────────────────────────

export function sponsoredItemId(adId: AdId | string, anchorOrganicId: string): string {
  return `ad:${adId}:${anchorOrganicId}`;
}
export function isSponsoredItemId(id: string): boolean {
  return typeof id === 'string' && id.startsWith('ad:');
}

// ─── CTA resolution ─────────────────────────────────────────────────────────────────

export function resolveAdCta(
  creative: { cta?: { label: AdCtaLabel; target: AdTarget } } | undefined,
): { label: AdCtaLabel; target: AdTarget } | undefined {
  return creative?.cta;
}

// ─── Link validation ────────────────────────────────────────────────────────────────

export type AdLinkProblem = 'too_long' | 'invalid_url';

export function normalizeAdLink(link: string): { url?: string; problem?: AdLinkProblem } {
  const trimmed = link.trim();
  if (!trimmed) return {};
  if (trimmed.length > AD_LINK_MAX_LENGTH) return { problem: 'too_long' };
  try {
    const url = trimmed.match(/^https?:\/\//i) ? trimmed : `https://${trimmed}`;
    // eslint-disable-next-line no-new
    new URL(url);
    return { url };
  } catch {
    return { problem: 'invalid_url' };
  }
}

// ─── Money / metric math (implemented for real — these are well-defined) ──────────

export function lifetimeFromDaily(daily: Santim, days: number): Santim {
  return (daily * days) as Santim;
}

/** Ethiopia's 15% VAT, split out of a VAT-inclusive gross total. */
/** The VAT rate these figures are split at, as a percentage. Returned alongside the split
 *  because the receipt LABELS it ("VAT (15%)") — the boost screen was reading a `ratePct`
 *  that was never in the return, so that line rendered "VAT (undefined%)" on a spend
 *  breakdown, which is exactly the number a business needs to be able to trust. */
export const VAT_RATE_PCT = 15;

export function vatFromGross(
  grossSantim: Santim,
): { net: Santim; vat: Santim; gross: Santim; ratePct: number } {
  const net = Math.round(grossSantim / (1 + VAT_RATE_PCT / 100)) as Santim;
  const vat = (grossSantim - net) as Santim;
  return { net, vat, gross: grossSantim, ratePct: VAT_RATE_PCT };
}

export function fmtETB(santim: Santim | number, opts: { whole?: boolean; compact?: boolean } = {}): string {
  const birr = santim / 100;
  if (opts.compact && birr >= 1000) {
    return `${(birr / 1000).toFixed(1)}k ETB`;
  }
  const value = opts.whole ? Math.round(birr).toString() : birr.toFixed(2);
  return `${value} ETB`;
}

export function fmtPct(ratio: number | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}

export function ctr(clicks: number, impressions: number): number | undefined {
  if (!impressions) return undefined;
  return clicks / impressions;
}

export function cpc(spendSantim: Santim, clicks: number): Santim | undefined {
  if (!clicks) return undefined;
  return Math.round(spendSantim / clicks) as Santim;
}

export function cpm(spendSantim: Santim, impressions: number): Santim | undefined {
  if (!impressions) return undefined;
  return Math.round((spendSantim / impressions) * 1000) as Santim;
}

/** PLACEHOLDER objective -> "result" mapping: awareness reports impressions, everything
 *  else reports clicks. The real per-objective result source is not modeled. */
export function resultsFor(
  objective: string,
  delivery: { impressions: number; clicks: number; conversions: number },
): number {
  if (objective === 'awareness') return delivery.impressions;
  if (objective === 'leads') return delivery.conversions;
  return delivery.clicks;
}

export function costPerResult(
  objective: string,
  spendSantim: Santim,
  delivery: { impressions: number; clicks: number; conversions: number },
): Santim | undefined {
  const results = resultsFor(objective, delivery);
  if (!results) return undefined;
  return Math.round(spendSantim / results) as Santim;
}

// ─── Color utilities (WCAG contrast — real, standard math) ─────────────────────────

export function parseHex(hex: string): { r: number; g: number; b: number } | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function relLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const chan = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/** WCAG 2.x contrast ratio between two colors, in [1, 21]. */
export function contrastRatio(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const la = relLuminance(a) + 0.05;
  const lb = relLuminance(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}

function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Walk `brandColor` toward black or white (per `prefer`) until it clears `floor` contrast
 * against a white/black label, returning a safe {background, label} pair. Falls back to
 * `fallbackColor` when `brandColor` is missing/unparseable.
 */
export function safeBrandColor(
  brandColor: string | undefined,
  _mode: 'dark' | 'light',
  fallbackColor: string,
  floor: number,
  prefer: 'light' | 'dark' | 'auto' = 'auto',
): { background: string; label: string } {
  const base = parseHex(brandColor ?? '') ?? parseHex(fallbackColor) ?? { r: 66, g: 158, b: 245 };
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };

  const labelColor = prefer === 'dark' ? black
    : prefer === 'light' ? white
    : contrastRatio(base, black) > contrastRatio(base, white) ? black : white;

  let cur = base;
  const towardBlack = labelColor === white;
  let ratio = contrastRatio(cur, labelColor);
  let guard = 0;
  while (ratio < floor && guard++ < 40) {
    const step = towardBlack ? -8 : 8;
    cur = {
      r: cur.r + step, g: cur.g + step, b: cur.b + step,
    };
    cur = {
      r: Math.max(0, Math.min(255, cur.r)),
      g: Math.max(0, Math.min(255, cur.g)),
      b: Math.max(0, Math.min(255, cur.b)),
    };
    ratio = contrastRatio(cur, labelColor);
    if ((towardBlack && cur.r <= 0) || (!towardBlack && cur.r >= 255)) break;
  }

  return { background: toHex(cur), label: toHex(labelColor) };
}
