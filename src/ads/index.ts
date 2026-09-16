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
//
// ── WHAT IS NO LONGER A PLACEHOLDER (2026-08-27) ───────────────────────────────────
//
// Three groups were promoted from stub to real, because each one had an authoritative
// definition elsewhere that this file was contradicting:
//
//   THE LINK / CTA GATE  `normalizeAdLink`, `isSafeAdUrl`, `resolveAdCta`,
//                        `AD_CTA_LABELS`, `isAdCtaLabel`. Implemented against
//                        Paxpia-mobile/__tests__/adsCtaLink.test.ts, which is a complete
//                        written spec for them. This is a SECURITY BOUNDARY, not shape:
//                        `Linking.openURL` hands its string to the operating system, so
//                        the http/https narrowing here is what stops `tel:`, `intent:`
//                        and an app's private scheme reaching it from advertiser data.
//                        A permissive placeholder in this position was the single
//                        highest-risk line in either client.
//
//   THE VOCABULARIES     `BoostGoal`, `BoostAudience`, `AdEventType`, `AdConversionKind`,
//                        `DeliveryState`, `AgeBand`, `AdObjective`, `AdPlacement`. These
//                        now mirror services/ads/internal/model exactly. The previous
//                        values were invented and disagreed with both the Go service and
//                        the clients calling this module — e.g. `BoostGoal` held the
//                        OBJECTIVE vocabulary ('awareness'), while every call site passes
//                        'more_views'. A mirror that disagrees with what it mirrors is
//                        worse than no mirror.
//
//   THE RESULT MAP       `RESULT_SOURCE_BY_OBJECTIVE` / `resultsFor`. Which delivery
//                        counter an objective's "results" reads from is a product rule,
//                        not a guess.
//
// Still placeholders, and still labelled as such below: `weaveAds`, `slotCountFor`,
// `applyCaps`, `estimateReach`, `expandBoost`, `validateBudget`. Those model the /ads/*
// auction and pacing, which is parked (see docs/ADS_SERVICE.md in Paxpia-backend).

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

/**
 * The live placement allowlist, mirroring `model.Placements` in services/ads.
 *
 * `'feed'` was in this union and is not a placement the server has ever accepted — a
 * serve request naming it is answered with zero fills. It is dropped rather than kept
 * as a harmless extra, because a `Record<AdPlacement, …>` in either client then has to
 * carry an entry for inventory that does not exist (which is exactly the error the
 * website's `DEFAULT_RESERVED` map was reporting). The CTA button's
 * `variant: 'feed' | 'overlay'` is unrelated and unaffected.
 *
 * `PLANNED_AD_PLACEMENTS` mirrors `model.PlacementsPlanned` — designed, not inventory.
 */
export type AdPlacement = 'precept' | 'reels';
const AD_PLACEMENTS: ReadonlySet<string> = new Set<AdPlacement>(['precept', 'reels']);
export const AD_PLACEMENT_LIST: readonly AdPlacement[] = ['precept', 'reels'];
export const PLANNED_AD_PLACEMENTS: readonly string[] = ['explore', 'stories', 'discovery'];
export function isAdPlacement(x: unknown): x is AdPlacement {
  return typeof x === 'string' && AD_PLACEMENTS.has(x);
}

/**
 * A destination as it arrives on the wire — every field optional, because `Creative.CTA`
 * is a Go VALUE struct and a creative saved with no cta round-trips as
 * `{"label":"","target":{"kind":""}}`: present, non-null and unusable.
 *
 * Nothing should navigate off this type. `resolveAdCta` turns it into `ResolvedAdTarget`,
 * which is where the fields become non-optional — see the note there.
 */
export interface AdTarget {
  kind: 'url' | 'route';
  url?: string;
  route?: string;
  /** Route params, for an in-app destination. Carried through verbatim. */
  params?: Record<string, unknown>;
}

/**
 * A destination that has PASSED the gate.
 *
 * A discriminated union rather than the loose shape above, so a caller that has already
 * resolved does not have to re-check: on the `'url'` branch `url` is a string, on the
 * `'route'` branch `route` is a string. That narrowing is the whole reason
 * `openAdTarget` can hand `cta.target.url` straight to `Linking.openURL`.
 */
export type ResolvedAdTarget =
  | { kind: 'url'; url: string }
  | { kind: 'route'; route: string; params?: Record<string, unknown> };

export interface ResolvedAdCta {
  label: AdCtaLabel;
  target: ResolvedAdTarget;
}

export type AdCtaLabel =
  | 'learn_more' | 'shop_now' | 'sign_up' | 'follow' | 'view_course' | 'contact' | 'get_app';

/**
 * Every CTA label the locales have copy for, in one place.
 *
 * `resolveAdCta` refuses a label absent from this list. Otherwise `CTA_KEY[label]` is
 * undefined and the card paints a blank full-width bar in the advertiser's brand colour,
 * which reads as the app breaking rather than as an ad with no button.
 */
export const AD_CTA_LABELS: readonly AdCtaLabel[] = [
  'learn_more', 'shop_now', 'sign_up', 'follow', 'view_course', 'contact', 'get_app',
];
const AD_CTA_LABEL_SET: ReadonlySet<string> = new Set<string>(AD_CTA_LABELS);

/** Narrows a wire value to a label the UI can actually render. */
export function isAdCtaLabel(x: unknown): x is AdCtaLabel {
  return typeof x === 'string' && AD_CTA_LABEL_SET.has(x);
}

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
};
/** The spec an unknown placement falls back to — the more conservative of the two, so a
 *  surface added before its spec is written cannot accept oversized creative. */
const CREATIVE_SPEC_FALLBACK: CreativeSpec = CREATIVE_SPEC_DEFAULTS.precept;
export const CREATIVE_SPECS: Record<string, CreativeSpec> = new Proxy(CREATIVE_SPEC_DEFAULTS, {
  get: (target, prop: string) => (target as Record<string, CreativeSpec>)[prop] ?? CREATIVE_SPEC_FALLBACK,
});

// ─── Creative / fill / campaign shapes ─────────────────────────────────────────────

export interface AdCreativeMedia {
  kind: 'image' | 'video';
  /** A BUCKET-RELATIVE OBJECT KEY, not a URL — the server's CDN_BASE_URL is empty so the
   *  client owns the host. Both clients resolve it at the transport, never in a card. */
  url: string;
  posterUrl?: string;
  width?: number;
  height?: number;
  /** Video only. Drives the thruplay threshold and the reel's own progress affordances. */
  durationSecs?: number;
}

/** An app-install destination, when the creative has one. Passed through untouched by
 *  media resolution: `iconUrl` is already an app-store URL and rehosting it breaks it. */
export interface AdAppInstall {
  iconUrl?: string;
  appName?: string;
  storeUrl?: string;
  rating?: number;
}

export interface AdCreative {
  id?: CreativeId;
  media: AdCreativeMedia;
  headline?: string;
  body?: string;
  cta?: { label: AdCtaLabel; target: AdTarget };
  brandColor?: string;
  appInstall?: AdAppInstall;
}

/** The authoring-side alias. Same shape — a draft is a creative that has not shipped. */
export type AdCreativeDraft = AdCreative;

export interface AdFill {
  adId: AdId;
  campaignId: CampaignId;
  fillToken: FillToken;
  placement: AdPlacement;
  advertiser: { id: string; name: string; avatar: string; verified: boolean; isFollowing?: boolean };
  creative: AdCreative;
  socialProof?: { firstFollowerName: string; othersCount: number };
  disclosure?: { reasons: string[] };
  /** The organic post this creative was boosted FROM, when it was. Lets a card offer
   *  "see the original post" and lets attribution credit the right author. */
  fromPostId?: string;
}

export interface AdServeResponse {
  fills: AdFill[];
  ttlSecs: number;
}

/**
 * The viewer's own ad controls. Honoured client-side immediately and server-side too, so
 * the choice survives a reinstall and follows them to a new device.
 *
 * Arrays rather than Sets: this is persisted as JSON and sent over the wire, and a Set
 * serialises to `{}`.
 */
export interface AdPreferences {
  hiddenAdvertisers: string[];
  mutedTopics: string[];
}

export const EMPTY_AD_PREFERENCES: AdPreferences = { hiddenAdvertisers: [], mutedTopics: [] };

/**
 * Mirrors `model.EventType` in services/ads exactly.
 *
 * The three view milestones were missing here, which made every client that reported them
 * a type error while the SERVER accepted them perfectly well — the union was narrower than
 * the wire, not the other way round.
 */
export type AdEventType =
  | 'impression' | 'view_2s' | 'view_6s' | 'complete'
  | 'click' | 'hide' | 'report' | 'conversion';

export interface AdEvent {
  /**
   * `fillToken` is the only REQUIRED identifier, and that is the design.
   *
   * The token is signed and already carries the ad, ad set, campaign, account, placement,
   * principal and cleared price — the Go handler reads all of them from it and ignores any
   * body field claiming otherwise, because a client that could name its own campaign id
   * could bill someone else's budget. So `adId`/`campaignId`/`ts` are optional: useful for
   * local dedupe and logging, never sent as truth.
   */
  fillToken: FillToken;
  type: AdEventType;
  adId?: AdId;
  campaignId?: CampaignId;
  ts?: number;
  /** Which surface produced it. The server bills per placement, so an event that cannot
   *  say where it happened is an event that cannot be attributed. */
  placement?: AdPlacement;
  /** Client-side ordinal within one fill, so the server can drop a replayed batch. */
  seq?: number;
  /** Video only, for the thruplay billing event. */
  watchedMs?: number;
  /** The client's own clock, RFC3339. Advisory — the server times events itself. */
  tsClient?: string;
  conversion?: { kind: AdConversionKind; valueSantim?: Santim };
  reportReason?: string;
}

/** Mirrors the conversion kinds the platform actually emits, including the three social
 *  ones the touch ledger reports (`follow`, `live_join`, `message_started`). */
export type AdConversionKind =
  | 'purchase' | 'course_purchase' | 'enroll' | 'signup' | 'lead' | 'install'
  | 'follow' | 'live_join' | 'message_started' | 'other';

/**
 * Mirrors the delivery state machine in services/ads.
 *
 * Five states were missing, and their absence was not inert: `DeliveryMeter` and
 * `DeliveryStatePill` switch on `'in_review'`, `'learning'` and `'learning_limited'`, so
 * tsc was reporting those arms as unreachable while they were the arms that actually ran.
 */
export type DeliveryState =
  | 'draft' | 'in_review' | 'scheduled'
  | 'learning' | 'learning_limited' | 'active'
  | 'paused' | 'completed' | 'out_of_credit' | 'rejected';

/** Age is expressed as BANDS, never free integers — it makes '13-17' a single
 *  indivisible bucket rather than something sliceable. Mirrors `model.AgeBands`. */
export type AgeBand = '13-17' | '18-24' | '25-34' | '35-44' | '45-54' | '55+';
export const AGE_BANDS: readonly AgeBand[] = ['13-17', '18-24', '25-34', '35-44', '45-54', '55+'];

export interface AdGeoTarget {
  /** ISO-3166 alpha-2. 'ET' for everything at launch. */
  country: string;
  regions?: string[];
  cities?: string[];
}

/** What an ad set is aimed at. Mirrors `model.Targeting`. */
export interface AdTargeting {
  geo: AdGeoTarget;
  ageBands?: AgeBand[];
  languages?: string[];
  interests?: string[];
  includeAudiences?: string[];
  excludeAudiences?: string[];
}

export interface AdSchedule {
  startUnix: number;
  /** Absent means open-ended. */
  endUnix?: number;
}

export interface AdBudget {
  kind?: 'daily' | 'lifetime';
  amount: Santim;
}

// ─── The four levels ───────────────────────────────────────────────────────────────
//
// The `[key: string]: unknown` index signature these three carried was what made
// `adSet.schedule` and `ad.creative` resolve to `unknown` at every read — the store and
// three screens dereference both, so the index signature was actively hiding the shape
// rather than tolerating it. The fields below are the ones those call sites read; the
// index signature is kept so a server field nobody models yet still round-trips.

export interface Campaign {
  id: CampaignId;
  objective: AdObjective;
  state: DeliveryState;
  createdUnix: number;
  /** Required, because the detail screen's header IS this string and there is no sensible
   *  default for it. Every producer already sets it (the bridge derives it from the ad's
   *  title); making it optional only moved the problem to a `?? ''` at the header. */
  name: string;
  accountId?: AdAccountId | string;
  /** Lifetime budget, when the server reports it at campaign level rather than on the
   *  ad set. The detail screens read `campaign.budget ?? adSet.budget` for that reason. */
  budget?: AdBudget;
  /** Set when this campaign came from boosting an existing post. */
  fromPostId?: string;
  restrictedCategories?: string[];
  [key: string]: unknown;
}

export interface AdSet {
  id: AdSetId;
  campaignId: CampaignId;
  schedule: AdSchedule;
  state?: DeliveryState;
  budget?: AdBudget;
  targeting?: AdTargeting;
  /** Required, and an EMPTY ARRAY is meaningful: it means automatic placements — every
   *  eligible surface — which is what Boost creates. `undefined` cannot say that, so the
   *  screens reading `placements.length === 0` were right and the type was wrong. */
  placements: AdPlacement[];
  optimizationGoal?: string;
  billingEvent?: 'impression' | 'link_click' | 'thruplay';
  bidStrategy?: string;
  bidSantim?: Santim;
  [key: string]: unknown;
}

export interface Ad {
  id: AdId;
  adSetId: AdSetId;
  creative: AdCreative;
  state?: DeliveryState;
  /** Shown to the advertiser VERBATIM when their ad is refused. Never summarised. */
  rejectionReason?: string;
  /** Only the /ads/* service has an appeal route, so this is absent on a
   *  promotions-backed record — which is what the detail screen keys the appeal button
   *  off, rather than offering a control that could only ever fail. */
  appeal?: { state: 'pending' | 'accepted' | 'declined'; filedUnix?: number };
  [key: string]: unknown;
}

// ─── Boost (create-a-campaign-from-a-post) ─────────────────────────────────────────

/**
 * What the Boost form asks, mirroring `model.BoostGoal` / `model.BoostAudience`.
 *
 * These held the OBJECTIVE vocabulary ('awareness' | 'traffic' | …) — which is a real
 * vocabulary, but a different one, and it belongs to `AdObjective` below. Every call site
 * in the app passes 'more_views' / 'automatic', so the union was rejecting the only values
 * anything actually sends. `boostGoalToObjective` is the map between the two, matching
 * `goalToObjective` in services/ads.
 */
export type BoostGoal = 'more_views' | 'more_followers' | 'more_sales';
export type BoostAudience = 'automatic' | 'my_followers' | 'students_nearby';

export const BOOST_GOALS: BoostGoal[] = ['more_views', 'more_followers', 'more_sales'];
export const BOOST_AUDIENCES: BoostAudience[] = ['automatic', 'my_followers', 'students_nearby'];
export const BOOST_DEFAULT_GOAL: BoostGoal = 'more_views';
export const BOOST_DEFAULT_AUDIENCE: BoostAudience = 'automatic';

export function isBoostGoal(x: unknown): x is BoostGoal {
  return typeof x === 'string' && (BOOST_GOALS as string[]).includes(x);
}
export function isBoostAudience(x: unknown): x is BoostAudience {
  return typeof x === 'string' && (BOOST_AUDIENCES as string[]).includes(x);
}

/** Mirrors `model.Objective`. What a campaign is FOR, as opposed to what the Boost form
 *  asked — the server derives one from the other. */
export type AdObjective =
  | 'awareness' | 'traffic' | 'engagement' | 'followers' | 'course_sales' | 'leads';

const BOOST_GOAL_TO_OBJECTIVE: Record<BoostGoal, AdObjective> = {
  more_views: 'awareness',
  more_followers: 'followers',
  more_sales: 'course_sales',
};

/** The same mapping the server applies, so a locally-expanded boost and a
 *  server-expanded one agree on the objective. */
export function boostGoalToObjective(goal: BoostGoal): AdObjective {
  return BOOST_GOAL_TO_OBJECTIVE[goal] ?? 'awareness';
}

// ── REAL TABLES, NOT A PROXY THAT ANSWERS ANYTHING ────────────────────────────────
//
// These four were `new Proxy({}, { get: (_, k) => `${prefix}.${k}` })`, which returned a
// plausible-looking key for ANY property — and that is worse than being wrong, because it
// cannot be checked. The locale files key these blocks `views` / `followers` / `sales` and
// `automatic` / `followers` / `nearby`, while the option IDS are `more_views` /
// `my_followers` / `students_nearby`, so the Proxy was handing i18next
// `ads.boost.goal.more_views` — a key no locale has. i18next then renders the key path
// itself, which put the raw string "ads.boost.goal.more_views" on screen inside the
// option row.
//
// It survived because `adsI18nKeysExist.test.ts` walks `Object.values`, and a Proxy over
// `{}` has none. Written out, the test can finally see them.
//
// The leaf names below are the LOCALE's, not the option id's. They are deliberately not
// renamed to match: the locale copy is translated in three languages, and the mapping
// belongs here rather than in an am/om rename.
export const BOOST_GOAL_KEYS: Record<BoostGoal, string> = {
  more_views:     'ads.boost.goal.views',
  more_followers: 'ads.boost.goal.followers',
  more_sales:     'ads.boost.goal.sales',
};
export const BOOST_GOAL_HINT_KEYS: Record<BoostGoal, string> = {
  more_views:     'ads.boost.goalHint.views',
  more_followers: 'ads.boost.goalHint.followers',
  more_sales:     'ads.boost.goalHint.sales',
};
export const BOOST_AUDIENCE_KEYS: Record<BoostAudience, string> = {
  automatic:       'ads.boost.audience.automatic',
  my_followers:    'ads.boost.audience.followers',
  students_nearby: 'ads.boost.audience.nearby',
};
export const BOOST_AUDIENCE_HINT_KEYS: Record<BoostAudience, string> = {
  automatic:       'ads.boost.audienceHint.automatic',
  my_followers:    'ads.boost.audienceHint.followers',
  students_nearby: 'ads.boost.audienceHint.nearby',
};

// Keyed on the OBJECTIVE, and pointing at the `ads.result.*` / `ads.resultCost.*` blocks
// that already exist in all three locales — camelCase leaf for `course_sales`, matching
// how the locale files are written. These were `fallbackKeyMap` Proxies, which answered
// any property with a plausible-looking key and therefore could never be checked: the
// i18n test walks `Object.values` and a Proxy over `{}` has none.
export const RESULT_LABEL_KEYS: Record<AdObjective, string> = {
  awareness:    'ads.result.awareness',
  traffic:      'ads.result.traffic',
  engagement:   'ads.result.engagement',
  followers:    'ads.result.followers',
  course_sales: 'ads.result.courseSales',
  leads:        'ads.result.leads',
};

export const RESULT_COST_LABEL_KEYS: Record<AdObjective, string> = {
  awareness:    'ads.resultCost.awareness',
  traffic:      'ads.resultCost.traffic',
  engagement:   'ads.resultCost.engagement',
  followers:    'ads.resultCost.followers',
  course_sales: 'ads.resultCost.courseSales',
  leads:        'ads.resultCost.leads',
};
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
  /** Santim per day. Named `dailyBudget` and not `dailyBudgetSantim` because that is what
   *  every call site passes — `Santim` in the type already says the unit. */
  dailyBudget: Santim;
  durationDays: number;
  link?: string;
  creative: AdCreativeDraft;
  placements?: AdPlacement[];
  [key: string]: unknown;
}

/**
 * Everything the expansion needs that is not the buyer's choice.
 *
 * The three ids are what the CALLER mints (locally, or from the server's response), which
 * is why `createBoost` takes `Omit<BoostContext, 'campaignId' | 'adSetId' | 'adId'>` and
 * fills them in itself.
 */
export interface BoostContext {
  campaignId: CampaignId;
  adSetId: AdSetId;
  adId: AdId;
  accountId?: AdAccountId | string;
  nowUnix?: number;
  country?: string;
  region?: string;
  /** Needed for the `my_followers` audience — without it that preset cannot narrow. */
  followerAudienceId?: string;
  postId?: string;
  [key: string]: unknown;
}

/** PLACEHOLDER: builds the same {campaign, adSet, ad} shape the server would, from the
 *  Boost form input. Real targeting/pacing rules are NOT implemented. */
export function expandBoost(
  input: BoostInput,
  ctx: BoostContext,
): { campaign: Campaign; adSet: AdSet; ad: Ad } {
  const startUnix = ctx.nowUnix ?? Math.floor(Date.now() / 1000);
  return {
    campaign: {
      id: ctx.campaignId,
      // Derived through the same map the server uses, so a locally-expanded boost and a
      // server-expanded one do not disagree about what the campaign is for.
      objective: boostGoalToObjective(input.goal),
      // A boost is NOT live on creation: it waits for review, and `in_review` is a state
      // the advertiser has to learn exists. Starting it 'active' teaches the opposite.
      state: 'in_review',
      createdUnix: startUnix,
      // Derived from the headline the advertiser wrote, so a creator who boosted four
      // posts gets four distinguishable campaigns rather than four called the same thing.
      name: input.creative.headline?.trim() || `Boost ${input.postId.slice(0, 8)}`,
      accountId: ctx.accountId,
      fromPostId: input.postId,
    },
    adSet: {
      id: ctx.adSetId,
      campaignId: ctx.campaignId,
      audience: input.audience,
      // A LIFETIME budget: daily × duration, collapsed. The daily figure survives on the
      // BoostInput, which is where `createBoost` reads it from for the wire.
      budget: {
        kind: 'lifetime',
        amount: lifetimeFromDaily(input.dailyBudget, input.durationDays),
      },
      schedule: {
        startUnix,
        endUnix: startUnix + input.durationDays * 24 * 60 * 60,
      },
      placements: input.placements ?? [],
    },
    ad: { id: ctx.adId, adSetId: ctx.adSetId, creative: input.creative, state: 'in_review' },
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

/** Mirrors `model.Rules` in services/ads. */
export interface FrequencyRules {
  /** Hard ceiling on ads shown per placement per session. */
  maxPerSession: number;
  /** Minimum milliseconds between two ads on the same surface. Reels needs this because
   *  a swipe can cross several items a second — cadence alone does not bound TIME. */
  minGapMs: number;
  /** Stops a single advertiser owning every slot when the fill response is thin. */
  maxPerCampaignPerSession: number;
}

/** Mirrors `model.DefaultRules`. Same numbers, milliseconds instead of a Duration. */
export const DEFAULT_FREQUENCY_RULES: Record<AdPlacement, FrequencyRules> = {
  precept: { maxPerSession: 4, minGapMs: 0, maxPerCampaignPerSession: 2 },
  // 90s between reels ads: at ~10s a reel that is roughly one ad per nine organic
  // videos even if the cadence would allow more.
  reels: { maxPerSession: 4, minGapMs: 90_000, maxPerCampaignPerSession: 2 },
};

/**
 * What this session has already shown. Mirrors `model.CapState`, per placement.
 *
 * Reshaped from `{ shownAt: Record<string, number[]> }`, which kept an unbounded
 * timestamp list per ADVERTISER and answered none of the three questions the rules ask.
 * The website's own store was already written against these three fields.
 */
export interface FrequencyState {
  /** Fills shown this session, keyed by placement. */
  shown: Record<string, number>;
  /** Epoch ms of the most recent fill, keyed by placement. */
  lastShownMs: Record<string, number>;
  /** Fills shown this session, keyed by campaign id. */
  perCampaign: Record<string, number>;
}

export function emptyFrequencyState(): FrequencyState {
  return { shown: {}, lastShownMs: {}, perCampaign: {} };
}

/** Commit one fill. Called on a real IMPRESSION, not on a fill being handed out — the
 *  server counts fills for its own cap; this counts what the viewer actually saw. */
export function recordShown(state: FrequencyState, fill: AdFill, now: number): FrequencyState {
  const p = fill.placement;
  return {
    shown: { ...state.shown, [p]: (state.shown[p] ?? 0) + 1 },
    lastShownMs: { ...state.lastShownMs, [p]: now },
    perCampaign: {
      ...state.perCampaign,
      [fill.campaignId]: (state.perCampaign[fill.campaignId] ?? 0) + 1,
    },
  };
}

/**
 * Drop the fills this viewer has already had enough of.
 *
 * ── WHY THE CLIENT CAPS AT ALL, WHEN THE SERVER ALREADY DOES ──────────────────────
 *
 * This is a FLOOR under the server's pacing, not a replacement for it. The server caps
 * what it hands out; the client decides what it actually renders, and the two differ
 * whenever a fill is fetched and not shown (a page the viewer never scrolls to, a
 * response held across a refresh, a reel skipped in under a second). Without this, those
 * unshown fills come back around and the viewer sees a burst the server believes it
 * already spaced out.
 *
 * It was a PASSTHROUGH — every fill eligible, always — so there was no client-side cap in
 * either app despite both stores maintaining the state for one.
 *
 * The simulated clock advances by `minGapMs` per accepted fill, exactly as the server's
 * `applyCaps` does: successive ads in one weave are separated by organic items rather
 * than by elapsed time, so judging them all at `now` would reject every fill after the
 * first.
 */
export function applyCaps(frequency: FrequencyState, fills: AdFill[], now: number): AdFill[] {
  const out: AdFill[] = [];
  // Local mutable tallies so this stays pure with respect to `frequency`.
  const shown = { ...frequency.shown };
  const perCampaign = { ...frequency.perCampaign };
  const lastShownMs = { ...frequency.lastShownMs };

  for (const fill of fills) {
    const rules = DEFAULT_FREQUENCY_RULES[fill.placement];
    // An unknown placement has no rules to apply, and inventing one would either block a
    // legitimate surface or leave it uncapped. Passed through — the server is still the
    // authority, and this is a floor.
    if (!rules) { out.push(fill); continue; }

    if ((shown[fill.placement] ?? 0) >= rules.maxPerSession) continue;
    if ((perCampaign[fill.campaignId] ?? 0) >= rules.maxPerCampaignPerSession) continue;
    const last = lastShownMs[fill.placement];
    if (rules.minGapMs > 0 && last !== undefined && now - last < rules.minGapMs) continue;

    out.push(fill);
    shown[fill.placement] = (shown[fill.placement] ?? 0) + 1;
    perCampaign[fill.campaignId] = (perCampaign[fill.campaignId] ?? 0) + 1;
    lastShownMs[fill.placement] = now;
    if (rules.minGapMs > 0) now += rules.minGapMs;
  }
  return out;
}

// ─── Feed weaving ───────────────────────────────────────────────────────────────────

/** Per-placement cadence defaults, used when the caller states none. */
const DEFAULT_CADENCE: Record<AdPlacement, Required<WeaveCadence>> = {
  precept: { firstSlot: 3, every: 8, maxPerPage: 3 },
  reels: { firstSlot: 4, every: 8, maxPerPage: 3 },
};

/** How many ad slots a feed of this length should carry. PLACEHOLDER density (one slot per
 *  `every` organic items) — not the real pacing/inventory logic, but it now READS the
 *  cadence the caller passes instead of ignoring it. */
export function slotCountFor(
  feedLength: number,
  placement: AdPlacement,
  cadence?: WeaveCadence,
): number {
  if (feedLength <= 0) return 0;
  const base = DEFAULT_CADENCE[placement] ?? DEFAULT_CADENCE.precept;
  const firstSlot = cadence?.firstSlot ?? base.firstSlot;
  const every = Math.max(1, cadence?.every ?? base.every);
  const maxPerPage = cadence?.maxPerPage ?? base.maxPerPage;
  // Below the first slot there is nowhere to put an ad, so ask for NOTHING rather than
  // fetching a fill that will be discarded — a discarded fill is a wasted auction on the
  // server and a spurious row in its pacing ledger.
  if (feedLength < firstSlot) return 0;
  return Math.min(maxPerPage, Math.ceil((feedLength - firstSlot + 1) / every));
}

export interface WeaveHelpers<TPost> {
  toItem: (fill: AdFill, anchorOrganicId: string) => TPost;
  idOf: (p: TPost) => string;
  isReservedSlot?: (index: number) => boolean;
  cadence?: WeaveCadence;
}

/** PLACEHOLDER: inserts fills evenly spaced through the organic array (skipping reserved
 *  slots), anchored to the organic post immediately before each insertion point. This is
 *  NOT the real weaving algorithm — just enough to keep the list rendering.
 *
 *  `organic` is `readonly` because callers hand it straight from a store selector, and
 *  this function has no business mutating a domain array. It never did; the signature
 *  just did not say so. */
export function weaveAds<TPost>(
  organic: readonly TPost[],
  eligible: AdFill[],
  placement: AdPlacement,
  helpers: WeaveHelpers<TPost>,
): TPost[] {
  if (!eligible.length || !organic.length) return organic as TPost[];
  const base = DEFAULT_CADENCE[placement] ?? DEFAULT_CADENCE.precept;
  const firstSlot = helpers.cadence?.firstSlot ?? base.firstSlot;
  const gap = Math.max(3, Math.floor(organic.length / (eligible.length + 1)));
  const out: TPost[] = [];
  let fillIdx = 0;
  let nextSlot = firstSlot;
  for (let i = 0; i < organic.length; i++) {
    out.push(organic[i]);
    const isDue = out.length >= nextSlot && fillIdx < eligible.length;
    if (isDue && !(helpers.isReservedSlot?.(out.length))) {
      const fill = eligible[fillIdx++];
      out.push(helpers.toItem(fill, helpers.idOf(organic[i])));
      nextSlot = out.length + gap;
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

/**
 * Is there a call to action at all, and may it be opened?
 *
 * Returns `null` for every shape that must not paint a button, which is more cases than
 * "no cta":
 *
 *   · absent          a boost with no link. A supported ad, not an error.
 *   · Go zero value   `Creative.CTA` is a VALUE struct, so an omitted cta round-trips as
 *                     `{"label":"","target":{"kind":""}}` — present, non-null, unusable.
 *   · unknown label   `CTA_KEY[label]` would be undefined and the card would paint a
 *                     blank full-width bar in the advertiser's brand colour.
 *   · unsafe target   whatever review let through. Checked on the way OUT as well as on
 *                     the way in, because this is what feeds `Linking.openURL`.
 *
 * The URL it returns is NORMALISED, so what opens is exactly what was vetted. Pure — it
 * never mutates the creative it was handed.
 */
export function resolveAdCta(
  creative: { cta?: { label: AdCtaLabel; target: AdTarget } } | undefined,
): ResolvedAdCta | null {
  const cta = creative?.cta;
  if (!cta || !isAdCtaLabel(cta.label)) return null;

  const target = cta.target;
  if (!target || typeof target !== 'object') return null;

  if (target.kind === 'route') {
    const route = typeof target.route === 'string' ? target.route.trim() : '';
    if (!route) return null;
    return {
      label: cta.label,
      target: target.params
        ? { kind: 'route', route, params: target.params }
        : { kind: 'route', route },
    };
  }

  if (target.kind === 'url') {
    const raw = typeof target.url === 'string' ? target.url : '';
    if (!raw) return null;
    // Normalised, not merely checked: the advertiser may have typed `Example.ET/a`, and
    // the thing that opens has to be the thing that passed the gate.
    const { url } = normalizeAdLink(raw);
    if (!url || !isSafeAdUrl(url)) return null;
    return { label: cta.label, target: { kind: 'url', url } };
  }

  return null;
}

// ─── Link validation ────────────────────────────────────────────────────────────────
//
// ── WHY THIS IS NOT `new URL(...)` AND A SHRUG ─────────────────────────────────────
//
// Two different jobs, deliberately two functions:
//
//   normalizeAdLink  the FIELD validator. Forgiving about form — it supplies a missing
//                    scheme, fixes the typo'd `https:/`, lower-cases the host — because a
//                    creator typing `example.et` means a website and refusing them is
//                    just rudeness. Strict about substance.
//   isSafeAdUrl      the EGRESS gate. Forgiving about nothing. A string reaching here did
//                    not necessarily come through the field, and `Linking.openURL` hands
//                    it to the OPERATING SYSTEM, which honours `tel:`, `sms:`, `intent:`
//                    and any installed app's private scheme.
//
// The refusals below are not hypothetical. `https://paxpia.et@evil.example/x` renders with
// our domain leftmost and loads someone else's site; a zero-width space or an RTL override
// makes two different hosts paint identically. Both are how a reviewed ad becomes a
// phishing delivery mechanism, so both are refused as MALFORMED rather than repaired —
// there is no correct guess about what the author meant.

export type AdLinkProblem =
  /** The field is blank. Not an error — it means "no link", so no CTA bar anywhere. */
  | 'empty'
  /** A scheme other than http/https. Named separately from `malformed` because the
   *  message a creator needs is different: not "check your typing" but "links only". */
  | 'scheme'
  /** Structurally wrong, or deliberately deceptive. */
  | 'malformed'
  | 'too_long';

export interface AdLinkResult {
  /** The vetted, normalised URL. `null` — not absent — when the input parsed but names
   *  something that is not a public destination, so a caller cannot mistake "refused" for
   *  "not checked yet". */
  url?: string | null;
  problem?: AdLinkProblem;
}

/** Hosts that can only mean "this machine" or "our own network", and are therefore never
 *  an advertiser's destination however well-formed they look. */
const NON_PUBLIC_HOST =
  /^(?:localhost|0\.0\.0\.0|\[?::1\]?|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|.+\.local)$/i;

/**
 * Characters that must never appear in a URL an advertiser supplied.
 *
 * Whitespace and control characters, plus the invisible ones that spoof a host:
 * zero-width space/non-joiner/joiner, the bidi overrides and embeddings, word joiner,
 * BOM, and the ideographic space. Tested individually in adsCtaLink.test.ts.
 */
const INVISIBLE_OR_SPACE = new RegExp(
  '[\\s'
  + '\\u0000-\\u001f\\u007f'   // control characters
  + '\\u00a0'                  // no-break space
  + '\\u200b-\\u200f'          // zero-width space/NJ/J, LRM, RLM
  + '\\u202a-\\u202e'          // bidi embeddings and overrides
  + '\\u2060'                  // word joiner
  + '\\u2066-\\u2069'          // bidi isolates
  + '\\u3000'                  // ideographic space
  + '\\ufeff'                  // BOM / zero-width no-break space
  + ']',
);

/** A port, if the authority names one: 1–65535, digits only. */
function portIsValid(port: string): boolean {
  if (port === '') return true;
  if (!/^\d{1,5}$/.test(port)) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535;
}

/** A host that could plausibly resolve on the public internet: at least one dot, and no
 *  empty label. `example` is refused — it is a typo, not a destination. */
function hostIsPublic(host: string): boolean {
  if (!host || NON_PUBLIC_HOST.test(host)) return false;
  // A bracketed IPv6 literal is not something an ad links to; refuse rather than parse.
  if (host.startsWith('[')) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  return labels.every(l => l.length > 0) && /^[a-z0-9.-]+$/i.test(host);
}

/**
 * Validate and normalise what a creator typed into the link field.
 *
 * Lower-cases the HOST and leaves the PATH exactly as typed — a host is
 * case-insensitive, a path is not, and re-casing a signed or hashed path is how a working
 * URL stops working. Idempotent: normalising its own output changes nothing.
 */
export function normalizeAdLink(link: string): AdLinkResult {
  const trimmed = (link ?? '').trim();
  if (!trimmed) return { problem: 'empty' };
  if (trimmed.length > AD_LINK_MAX_LENGTH) return { problem: 'too_long' };
  // Checked on the TRIMMED value so an ordinary trailing space is forgiven, while an
  // interior space or an invisible character is not.
  if (INVISIBLE_OR_SPACE.test(trimmed)) return { problem: 'malformed' };

  // ── SCHEME ──
  // Matched as `letters + ':'` and NOT the RFC-3986 scheme grammar, which permits a dot:
  // the permissive pattern reads `example.et:8443` as a scheme named `example.et` and
  // refuses a perfectly good destination. Nothing this field accepts or refuses has a dot
  // in its scheme.
  let rest = trimmed;
  let scheme = 'https';
  const schemeMatch = /^([a-z][a-z0-9+-]*):/i.exec(trimmed);
  if (schemeMatch) {
    const named = schemeMatch[1].toLowerCase();
    const after = trimmed.slice(schemeMatch[0].length);
    // ── `localhost:3000` IS NOT A SCHEME NAMED `localhost` ──
    //
    // Excluding dots from the pattern above already rescues `example.et:8443`, but a
    // DOTLESS host with a port still matches it, and answering 'scheme' there reports the
    // wrong cause: the problem with `localhost:3000` is the host, not the protocol. So a
    // colon followed by digits is read as a port, and only a colon followed by `//` or a
    // non-numeric path is a scheme (`tel:+251…`, `javascript:alert(1)`, `file:///etc`).
    const looksLikePort = /^\d{1,5}(?:[/?#]|$)/.test(after);
    if (named === 'http' || named === 'https') {
      scheme = named;
      // Forgives `https:/host` and `https:host` as well as the correct `https://host` —
      // all three are the same typo class and all three mean one thing.
      rest = after.replace(/^\/{0,2}/, '');
    } else if (!looksLikePort) {
      return { problem: 'scheme' };
    }
    // else: not a scheme at all. `rest` stays as the whole trimmed string.
  } else if (trimmed.startsWith('//')) {
    rest = trimmed.slice(2);
  }
  if (!rest) return { problem: 'malformed' };

  // ── AUTHORITY vs PATH ──
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const tail = cut === -1 ? '' : rest.slice(cut);

  // Userinfo: the look-alike where the part that READS as the destination is the part the
  // browser treats as a username. Never repaired — refused.
  if (authority.includes('@')) return { problem: 'malformed' };

  const colon = authority.lastIndexOf(':');
  const host = (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
  const port = colon === -1 ? '' : authority.slice(colon + 1);

  if (!portIsValid(port)) return { problem: 'malformed' };
  if (!hostIsPublic(host)) return { url: null, problem: 'malformed' };

  const url = `${scheme}://${host}${port ? `:${port}` : ''}${tail}`;
  return { url };
}

/**
 * May this string be handed to `Linking.openURL` / `window.open`?
 *
 * Unlike the field normaliser, this REFUSES a scheme-less string. A URL off the wire was
 * normalised when it was authored; one arriving without a scheme did not come through
 * that path, and guessing on its behalf would be inventing a destination the advertiser
 * never wrote.
 */
export function isSafeAdUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false;
  const match = /^([a-z][a-z0-9+-]*):\/\//i.exec(url);
  if (!match) return false;
  const scheme = match[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return false;
  // Same substance rules as the field: no invisibles, no userinfo, a real public host.
  const normalized = normalizeAdLink(url);
  return Boolean(normalized.url);
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

/**
 * The delivery counters an objective's "results" may be read from.
 *
 * `reach` is deliberately NOT one of them. No objective reports reach as its result — it
 * is a supporting figure — and including it here would make every consumer of this table
 * have to hold a `reach` field just to be indexable.
 */
export type ResultSource = 'impressions' | 'clicks' | 'conversions';

/**
 * Which counter IS the result, per objective.
 *
 * Exported as a table rather than hidden inside `resultsFor` because the insights screens
 * need it for two things the function cannot answer: which tile to LABEL "Results", and
 * whether the figure is even present — the promotions service reports impressions and
 * clicks and nothing else, so an objective whose source is `conversions` has an UNKNOWN
 * result, not a zero. `deliveryFacts.resultsIfKnown` indexes this and returns undefined,
 * which is what makes the screen omit the tile instead of printing a confident 0.
 */
export const RESULT_SOURCE_BY_OBJECTIVE: Record<AdObjective, ResultSource> = {
  awareness: 'impressions',
  traffic: 'clicks',
  engagement: 'clicks',
  followers: 'conversions',
  course_sales: 'conversions',
  leads: 'conversions',
};

export function resultsFor(
  objective: AdObjective | string,
  delivery: { impressions: number; clicks: number; conversions: number },
): number {
  const source = RESULT_SOURCE_BY_OBJECTIVE[objective as AdObjective] ?? 'clicks';
  return delivery[source] ?? 0;
}

export function costPerResult(
  objective: AdObjective | string,
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

/** UPPERCASE, matching how every palette constant in both apps is written — a returned
 *  `#ffffff` compared against a `#FFFFFF` token is equal to the eye and not to `===`. */
function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const h = (n: number) =>
    Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0').toUpperCase();
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
  /** WCAG AA for normal text. Defaulted so a caller that has no opinion still gets a
   *  legible pair — the website was calling this with three arguments and could not
   *  compile against a required floor. */
  floor = 4.5,
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

// --- Stopgap for local website imports ---
export type AdAttributionSetting =
  | '1d_view_7d_click'
  | '1d_view_1d_click'
  | '7d_click'
  | '1d_click';

const DAY_SECS = 24 * 60 * 60;

export const ATTRIBUTION_TTL_SECS: Record<AdAttributionSetting, number> = {
  '1d_view_7d_click': 7 * DAY_SECS,
  '1d_view_1d_click': 1 * DAY_SECS,
  '7d_click': 7 * DAY_SECS,
  '1d_click': 1 * DAY_SECS,
};

/** `AdMedia` is the name the website's transport imports this by. */
export type AdMedia = AdCreativeMedia;

/**
 * How densely a surface may carry ads.
 *
 * Was `any`, which meant the website could pass a cadence to `slotCountFor` and `weaveAds`
 * and neither would look at it — a control that compiled and did nothing. It is a real
 * shape now, and the two placeholders below at least read it.
 */
export interface WeaveCadence {
  /** Index of the first ad slot. */
  firstSlot?: number;
  /** Organic items between one ad slot and the next. */
  every?: number;
  /** Hard ceiling on slots per page, whatever the length implies. */
  maxPerPage?: number;
}

// `ResolvedAdCta`, `AdObjective` and `AdPlacement` were also declared here as `any` /
// derived aliases. They are real types now, defined next to what they describe.
