// @paxpia/core/ads — the advertising DOMAIN MODEL, shared by Paxpia-mobile (delivery +
// Boost), Paxpia-web (Ads Manager) and mirrored by the Go ads service.
//
// Types + pure rules ONLY. No transport, no storage, no UI. Every value here is plain
// JSON (no Date, no Map, no class) so a campaign can go ClickHouse/Postgres → JSON →
// fetch → component with zero adapters — the same discipline as ./analytics.
//
// ── THE FOUR LEVELS ──────────────────────────────────────────────────────────────
//
//   AdAccount   who pays, in what currency, with what credit and standing
//     └─ Campaign   what am I trying to achieve?          (objective)
//          └─ AdSet    who sees it, where, when, how much? (audience/budget/bidding)
//               └─ Ad     what do they actually see?       (creative)
//
// All four exist here from day one even though mobile surfaces only two. Boost creates
// one of each under the hood, which is what makes a boosted post a first-class campaign
// that can later be opened in the web manager — not a parallel code path.
//
// ── WHAT THE CLIENT IS NOT ALLOWED TO DO ─────────────────────────────────────────
//
// The client never prices anything, never computes what to bill, and never decides who
// is eligible. It sends INTENT and OBSERVATIONS; the server prices, counts and bills.
// This mirrors the standing wallet rule ("the client sends intent, never a coin amount
// the server didn't itself price") and it is why `AdFill` carries an opaque `fillToken`
// rather than anything the client could have derived.
//
// NOTE ON THE NAME `fillToken`: it is deliberately NOT called an "impression token".
// `impression_token` already means something else in this stack — it is the guest
// identity JWT minted by the auth service's guest_token.go and stored as the access
// token for logged-out visitors (see mobile's api/authApi.ts). Two meanings for one
// name in one client is how the wrong one eventually gets wired to the wrong place.

// ─── Branded ids ────────────────────────────────────────────────────────────────
// Branded so an AdSetId can never be passed where a CampaignId is wanted. They are
// plain strings at runtime; the brand exists only at compile time.

export type AdAccountId = string & { readonly __brand: 'AdAccountId' };
export type CampaignId  = string & { readonly __brand: 'CampaignId' };
export type AdSetId     = string & { readonly __brand: 'AdSetId' };
export type AdId        = string & { readonly __brand: 'AdId' };
export type CreativeId  = string & { readonly __brand: 'CreativeId' };
export type AudienceId  = string & { readonly __brand: 'AudienceId' };

/** The opaque server token identifying ONE fill (one ad served into one slot for one
 *  viewer). Echoed verbatim on every event about that fill; it is the billing join key
 *  and the dedupe key. The client must treat it as an opaque string — never parse it,
 *  never construct one. */
export type FillToken = string & { readonly __brand: 'FillToken' };

// ─── Money ───────────────────────────────────────────────────────────────────────

/** Money in the smallest unit of its currency — ETB santim (1 birr = 100 santim).
 *  Integer cents, never a float: 0.1 + 0.2 !== 0.3 is not an acceptable property for
 *  something that appears on an invoice. */
export type Santim = number & { readonly __brand: 'Santim' };

export const ETB = 'ETB' as const;
export type Currency = typeof ETB;

// ─── Placements ─────────────────────────────────────────────────────────────────
//
// An ALLOWLIST, not a denylist. `AdPlacement` is a closed union, so a classroom, a
// homework submission, a peer review, a live session, a whiteboard or a message thread
// is UNREPRESENTABLE as a placement — the education-surface exclusion is a compile
// error rather than something a reviewer has to remember to catch.

export const AD_PLACEMENTS = ['precept', 'reels'] as const;
export type AdPlacement = typeof AD_PLACEMENTS[number];

/** Placements planned but not yet inventory. Kept separate from the live union so
 *  adding one is a deliberate edit in two places, not a typo that opens a surface. */
export const AD_PLACEMENTS_PLANNED = ['explore', 'stories', 'discovery'] as const;

export function isAdPlacement(v: string): v is AdPlacement {
  return (AD_PLACEMENTS as readonly string[]).includes(v);
}

// ─── Objectives, goals, billing ──────────────────────────────────────────────────

/** What the advertiser is actually trying to achieve. Set at CAMPAIGN level, and it
 *  changes delivery, not just a label: two advertisers targeting the same audience with
 *  different objectives get shown to different people inside it. */
export type AdObjective =
  | 'awareness'      // be seen by as many people as possible
  | 'traffic'        // send people somewhere
  | 'engagement'     // likes, comments, shares, video views
  | 'followers'      // account growth — high value for educators
  | 'course_sales'   // purchases
  | 'leads';         // contact / message / lead capture

/** The specific event delivery tries to produce more of. Set at AD SET level. */
export type OptimizationGoal =
  | 'reach' | 'impressions'
  | 'link_clicks' | 'destination_views'
  | 'post_engagement' | 'thruplay' | 'video_views_2s'
  | 'follows' | 'profile_visits'
  | 'purchase' | 'enroll_intent' | 'value'
  | 'lead' | 'message_started';

/** What actually triggers a charge. DISTINCT from the optimization goal — you can
 *  optimize for purchases while being billed per impression, and usually should be. */
export type BillingEvent = 'impression' | 'link_click' | 'thruplay';

/** How the advertiser instructs the auction to bid on their behalf. */
export type BidStrategy =
  | 'highest_volume'        // no bid input — spend the budget, get the most results
  | 'cost_per_result_goal'  // aim for an average cost per result
  | 'bid_cap'              // never bid above this
  | 'highest_value';       // ROAS-oriented; needs `value` optimization

// ─── Audience ────────────────────────────────────────────────────────────────────

export type AudienceKind = 'saved' | 'custom' | 'lookalike';

/** Where a custom audience's members came from. `customer_list` is matched on a hash of
 *  the PHONE NUMBER, not email — Ethiopia is phone-first and an email-keyed list would
 *  match almost nobody. */
export type CustomAudienceSource =
  | 'customer_list' | 'video_viewers' | 'course_buyers'
  | 'profile_engagers' | 'live_attendees';

export interface GeoTarget {
  /** ISO-3166 alpha-2. 'ET' for everything at launch. */
  country: string;
  /** Region/state names as the backend knows them (Addis Ababa, Oromia, Amhara, …). */
  regions?: string[];
  cities?: string[];
}

/** Age is expressed as BANDS, not free integers. A band is the coarsest thing that
 *  still supports the product, and coarse is the correct default for targeting minors:
 *  it makes "13-17" a single indivisible bucket rather than something sliceable. */
export type AgeBand = '13-17' | '18-24' | '25-34' | '35-44' | '45-54' | '55+';

export const AGE_BANDS: readonly AgeBand[] = ['13-17', '18-24', '25-34', '35-44', '45-54', '55+'];

/** The minimum age Paxpia will serve any ad to at all. */
export const MIN_AD_AGE = 13;
/** Below this, targeting is restricted to age + geo + language. See ./targeting. */
export const ADULT_AGE = 18;

export interface AdTargeting {
  geo: GeoTarget;
  ageBands: AgeBand[];
  /** BCP-47-ish app languages: 'en' | 'am' | 'om'. Empty = all. */
  languages?: string[];
  /** Interest/topic ids from the course taxonomy. INERT against under-18 viewers —
   *  see `resolveTargetingPolicy`. */
  interests?: string[];
  /** Custom/lookalike audiences to include. Also inert against under-18 viewers. */
  includeAudiences?: AudienceId[];
  /** Audiences to exclude. Exclusions are ALWAYS honoured, including for minors —
   *  an exclusion can only ever narrow reach, so it is safe under any policy. */
  excludeAudiences?: AudienceId[];
}

export interface SavedAudience {
  id: AudienceId;
  accountId: AdAccountId;
  kind: AudienceKind;
  name: string;
  /** Present for kind==='saved'. */
  targeting?: AdTargeting;
  /** Present for kind==='custom'. */
  source?: CustomAudienceSource;
  /** Present for kind==='lookalike': the seed audience and the similarity percentile. */
  seedAudienceId?: AudienceId;
  lookalikePercent?: number; // 1..10
  /** Server-estimated size. Absent while still building. */
  approxSize?: number;
  status: 'ready' | 'building' | 'too_small' | 'expired';
}

// ─── Restricted categories ───────────────────────────────────────────────────────

/** Verticals an advertiser must self-declare. Declaring one clamps the campaign to 18+
 *  regardless of what its targeting says. */
export type RestrictedCategory =
  | 'financial_services' | 'health_medical' | 'employment'
  | 'credentials' | 'weight_management';

/** Verticals that are simply not sold here, for any audience, ever. Enforced at
 *  creative review; listed in the model so the builder can say so up front. */
export type ProhibitedCategory =
  | 'gambling' | 'alcohol' | 'tobacco' | 'political' | 'adult' | 'weapons';

export const RESTRICTED_CATEGORIES: readonly RestrictedCategory[] = [
  'financial_services', 'health_medical', 'employment', 'credentials', 'weight_management',
];

export const PROHIBITED_CATEGORIES: readonly ProhibitedCategory[] = [
  'gambling', 'alcohol', 'tobacco', 'political', 'adult', 'weapons',
];

// ─── Budget & schedule ───────────────────────────────────────────────────────────

export type BudgetKind = 'daily' | 'lifetime';

export interface AdBudget {
  kind: BudgetKind;
  /** Always santim. The client displays birr; it never converts for the wire. */
  amount: Santim;
  currency: Currency;
}

export interface AdSchedule {
  /** Epoch seconds. */
  startUnix: number;
  /** Epoch seconds; absent = runs until paused or out of credit. Required when the
   *  budget kind is 'lifetime' — a lifetime budget with no end has nothing to pace against. */
  endUnix?: number;
}

// ─── Delivery state ──────────────────────────────────────────────────────────────

/** Where a campaign/ad set/ad actually stands. This is a STATE MACHINE, not a boolean:
 *  states change asynchronously without anyone touching the object (review completes,
 *  budget exhausts, schedule starts, credit runs out), which is why the advertiser
 *  screens are read-mostly views rather than forms over a table. */
export type DeliveryState =
  | 'draft'
  | 'in_review'
  | 'scheduled'
  | 'learning'          // gathering signal; results not yet representative
  | 'learning_limited'  // can't reach enough events to exit learning
  | 'active'
  | 'paused'
  | 'out_of_credit'
  | 'rejected'
  | 'completed';

/** States that should be rendered as a persistent BANNER with an action, never a toast.
 *  A terminal state the user scrolled past is a support ticket with an angry person
 *  attached to it. */
export const BANNER_STATES: readonly DeliveryState[] = ['rejected', 'out_of_credit', 'learning_limited'];

/** Relative ranking against other advertisers, shown as quintiles. Absent until there
 *  is enough delivery to rank honestly. */
export type DiagnosticRanking = 'below_average' | 'average' | 'above_average';

export interface DeliveryDiagnostics {
  quality?: DiagnosticRanking;
  engagementRate?: DiagnosticRanking;
  conversionRate?: DiagnosticRanking;
  /** Optimization events accumulated toward exiting the learning phase. */
  learningEvents?: number;
  /** How many are needed. Server-owned so it can be tuned without a client ship. */
  learningTarget?: number;
}

// ─── Creative ────────────────────────────────────────────────────────────────────

export type AdCtaLabel =
  | 'learn_more' | 'shop_now' | 'sign_up'
  | 'follow' | 'view_course' | 'contact' | 'get_app';

export const AD_CTA_LABELS: readonly AdCtaLabel[] = [
  'learn_more', 'shop_now', 'sign_up', 'follow', 'view_course', 'contact', 'get_app',
];

/** Narrows a label that came off the wire. Load-bearing for `resolveAdCta`: the Go
 *  service's `CTA.Label` is a plain string, so an empty one and a misspelt one both
 *  arrive as valid JSON and must not reach the label→copy lookup, which would render an
 *  empty brand-coloured bar. */
export function isAdCtaLabel(v: unknown): v is AdCtaLabel {
  return typeof v === 'string' && (AD_CTA_LABELS as readonly string[]).includes(v);
}

/** Where the CTA goes. A ROUTE is strongly preferred: it keeps the user in the app,
 *  it is measurable end-to-end, and it cannot be a phishing destination. A URL leaves
 *  the app entirely — see ./link, which is the only thing allowed to decide that a URL
 *  is safe to hand to the platform. */
export type AdTarget =
  | { kind: 'route'; route: string; params?: Record<string, unknown> }
  | { kind: 'url'; url: string };

export type AdMedia =
  | { kind: 'image'; url: string; width?: number; height?: number }
  | { kind: 'video'; url: string; posterUrl?: string; durationSecs: number };

/** The creative spec per placement. A creative that doesn't match letterboxes, and on
 *  Reels a video with no low rendition either stalls or wastes bandwidth on exactly the
 *  connections most Paxpia users have — Data Saver caps playback to 540×960. */
export interface CreativeSpec {
  aspect: string;
  width: number;
  height: number;
  maxDurationSecs?: number;
  minDurationSecs?: number;
  /** Renditions the HLS ladder MUST include. */
  requiredRenditions?: string[];
}

export const CREATIVE_SPECS: Record<AdPlacement, CreativeSpec> = {
  // 5:6, because the feed's media box is round(width * 1.2) — see mobile HomeScreen.
  precept: { aspect: '5:6', width: 1080, height: 1296 },
  // 9:16 full screen, short. 540×960 is mandatory: Data Saver caps the max rendition
  // there, and a ladder without it stalls on metered connections.
  reels: {
    aspect: '9:16', width: 1080, height: 1920,
    minDurationSecs: 5, maxDurationSecs: 15,
    requiredRenditions: ['540x960'],
  },
};

export interface AdCreativeDraft {
  id?: CreativeId;
  media: AdMedia;
  headline: string;
  body?: string;
  /**
   * OPTIONAL, and its absence is a first-class case rather than a missing field.
   *
   * An ad only gets a call-to-action bar when there is somewhere for it to lead. A Boost
   * whose author gave no link has no destination, and a button reading "Learn more" that
   * navigates back to the post already filling the screen is a promise the ad cannot
   * keep — the viewer taps it once, nothing happens that they asked for, and the next
   * sponsored bar they see is worth nothing.
   *
   * Never read this field directly to decide whether to render. Go straight to
   * `resolveAdCta` in ./link: the Go service stores `CTA` as a value struct, so an
   * omitted cta round-trips as `{label:'', target:{kind:''}}` — present, non-null, and
   * unusable. That function is the one place that knows all three shapes.
   */
  cta?: { label: AdCtaLabel; target: AdTarget };
  /** Advertiser brand colour for the CTA bar. Contrast-checked against BOTH themes at
   *  build time; a colour that fails is auto-darkened for light mode rather than
   *  rejected — see ./contrast. */
  brandColor?: string;
  /** App-install format: its own unit, not a variant of `cta`. The reference TikTok ad
   *  shows an install card AND a caption CTA simultaneously. */
  appInstall?: { iconUrl: string; appName: string; storeUrl: string };
}

/**
 * The ceiling on what an advertiser can type as a boost's caption, i.e. `headline`.
 *
 * 150 because two things downstream are already bounded and this has to sit inside both:
 * `boostName` truncates to 40 for the campaign name (so the caption's first clause is what
 * an advertiser recognises in a list), and the feed's sponsored card clamps its caption to a
 * few lines. A cap here is what keeps the ad's own copy from being the thing that overflows
 * either.
 *
 * TRUNCATE BY CODE POINT (`[...s].slice(0, n)`), not by `.slice()`. Fidel is in the BMP and
 * counts the same either way, but an emoji is a surrogate pair — a code-unit slice can land
 * between its halves and emit a replacement character into the ad's own copy. This is the
 * same reason the Go `boostName` truncates by rune.
 */
export const AD_CAPTION_MAX_LENGTH = 150;

// ─── The four objects ────────────────────────────────────────────────────────────

export type AccountRole = 'owner' | 'admin' | 'analyst';

export interface AdAccount {
  id: AdAccountId;
  ownerUserId: string;
  name: string;
  currency: Currency;
  /** Prepaid Ad Credit, in santim. v1 is prepaid only — no billing thresholds. */
  creditBalance: Santim;
  /** Optional hard ceiling across every campaign on the account. */
  spendCapLifetime?: Santim;
  /** Tax identification number, for VAT-compliant receipts. */
  tin?: string;
  roles: { userId: string; role: AccountRole }[];
  /** Account-level standing. A history of rejections degrades this. */
  standing: 'good' | 'limited' | 'suspended';
}

export interface Campaign {
  id: CampaignId;
  accountId: AdAccountId;
  name: string;
  objective: AdObjective;
  state: DeliveryState;
  restrictedCategories?: RestrictedCategory[];
  /** Campaign-level budget = campaign budget optimization: the system distributes
   *  across ad sets. Absent means each ad set carries its own budget. */
  budget?: AdBudget;
  createdUnix: number;
  /** Set by Boost so the manager can show where a campaign came from. */
  fromPostId?: string;
}

export interface AdSet {
  id: AdSetId;
  campaignId: CampaignId;
  name: string;
  targeting: AdTargeting;
  /** Empty array = automatic placements (all eligible). */
  placements: AdPlacement[];
  budget?: AdBudget;
  schedule: AdSchedule;
  optimizationGoal: OptimizationGoal;
  billingEvent: BillingEvent;
  bidStrategy: BidStrategy;
  /** Required for cost_per_result_goal and bid_cap; forbidden otherwise. */
  bidAmount?: Santim;
  attribution: AttributionSetting;
  state: DeliveryState;
  diagnostics?: DeliveryDiagnostics;
}

export interface Ad {
  id: AdId;
  adSetId: AdSetId;
  name: string;
  creative: AdCreativeDraft;
  state: DeliveryState;
  /** Verbatim, human-readable reason when state==='rejected'. Never summarise this in
   *  the UI — an unexplained rejection is the single largest support-ticket generator
   *  in every ads product ever built. */
  rejectionReason?: string;
  /** Whether an appeal has been filed and where it stands. */
  appeal?: { state: 'none' | 'pending' | 'upheld' | 'overturned'; filedUnix?: number };
}

// ─── Attribution ─────────────────────────────────────────────────────────────────

/** How long after seeing or clicking an ad a conversion still counts to it. */
export type AttributionSetting =
  | '1d_view_7d_click'   // the default, and the industry norm
  | '1d_view_1d_click'
  | '7d_click'
  | '1d_click';

/** Widest window in seconds, per setting — the TTL for the client's touch ledger. */
export const ATTRIBUTION_TTL_SECS: Record<AttributionSetting, number> = {
  '1d_view_7d_click': 7 * 86_400,
  '1d_view_1d_click': 1 * 86_400,
  '7d_click':         7 * 86_400,
  '1d_click':         1 * 86_400,
};

/** Conversions the app can observe. Because the whole funnel is in-app there is no
 *  pixel and no cross-site tracking — these are emitted from wherever they happen and
 *  joined against the touch ledger. */
export type AdConversionKind =
  | 'course_purchase' | 'enroll' | 'follow'
  | 'live_join' | 'message_started' | 'lead' | 'signup';

// ─── Delivery: what the server returns and what the client reports ───────────────

/** ONE ad served into ONE slot for ONE viewer. This is what `/ads/serve` returns. */
export interface AdFill {
  adId: AdId;
  campaignId: CampaignId;
  /** Opaque. The billing join key + dedupe key. See the note at the top of this file. */
  fillToken: FillToken;
  placement: AdPlacement;
  advertiser: {
    id: string;
    name: string;
    avatar: string;
    verified: boolean;
    /** Whether the viewer already follows them — drives the inline Follow button. */
    isFollowing?: boolean;
  };
  creative: AdCreativeDraft;
  /**
   * The ORGANIC post this ad was boosted from — `Campaign.fromPostId`, carried through to
   * the viewer.
   *
   * Absent for a campaign built in the web manager from an uploaded creative, because there
   * is no post behind it. Present for every Boost, and that is what makes the comment and
   * share affordances on a sponsored card real rather than decorative: a boosted post keeps
   * ONE comment thread and ONE share/repost ledger — the post's — exactly as it does on the
   * platforms this is modelled on. Without this field the client has nothing to point those
   * two buttons at, which is how they ended up merely re-opening the CTA link.
   *
   * It is a public post id and nothing more. Everything the viewer can then do with it
   * (read the thread, comment, repost, DM it) they could already do from the organic feed;
   * the ad is a second doorway to the same object, not a new permission.
   */
  fromPostId?: string;
  /** "Followed by <name> and N others", built server-side from the follow graph. */
  socialProof?: { firstFollowerName: string; othersCount: number };
  /** Powers the "Why am I seeing this?" sheet. Plain human sentences, server-authored
   *  so the explanation always matches what actually targeted the user. */
  disclosure: { reasons: string[] };
}

export interface AdServeResponse {
  fills: AdFill[];
  /** How long these fills stay valid, in seconds. */
  ttlSecs: number;
}

/** Everything the client can observe about a fill. Note what is NOT here: any amount.
 *  The client reports what happened; the server decides what it costs. */
export type AdEventType =
  | 'impression'      // 50% of pixels for >= 1 continuous second (and, on Reels, painted)
  | 'view_2s' | 'view_6s' | 'complete'
  | 'click'
  | 'hide' | 'report'
  | 'conversion';

export interface AdEvent {
  type: AdEventType;
  fillToken: FillToken;
  placement: AdPlacement;
  /** Client clock, ISO. The SERVER stamps its own and bills on that — phones have
   *  wrong clocks, sometimes deliberately. */
  tsClient: string;
  /** Monotonic per-process sequence, so the server can order a batch that arrived
   *  out of order without trusting the wall clock. */
  seq: number;
  /** Present on 'conversion'. */
  conversion?: { kind: AdConversionKind; valueSantim?: Santim };
  /** Present on 'report'. */
  reportReason?: string;
  /** Milliseconds of playback, on the view_/complete events. */
  watchedMs?: number;
}

// ─── Viewer-side preferences ─────────────────────────────────────────────────────

export interface AdPreferences {
  /** Advertiser ids the viewer has hidden. Honoured client-side immediately and
   *  server-side on the next serve. */
  hiddenAdvertisers: string[];
  /** Topic ids the viewer asked to see less of. */
  mutedTopics: string[];
}

// ─── Reporting ───────────────────────────────────────────────────────────────────

/** The advertiser-facing rollup. Deliberately mirrors the shapes in ./analytics
 *  (`Series`, `MetricWindow`, `TrustMix`) so ad reporting and creator analytics render
 *  through the same chart components rather than growing a second chart system. */
export interface AdInsights {
  campaignId: CampaignId;
  window: { from_unix: number; to_unix: number; bucket_seconds: number };
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  ctr: number;
  spend: Santim;
  cpm: Santim;
  cpc?: Santim;
  conversions: number;
  cpa?: Santim;
  roas?: number;
  /** Impressions that were NOT billed because they came from botty trust tiers. The
   *  advertiser sees this — it is the "were these real people?" answer, and no other
   *  platform in this market offers it. */
  filteredImpressions: number;
}

export type BreakdownDimension = 'placement' | 'age' | 'region' | 'language' | 'day';

export interface BreakdownRow {
  dimension: BreakdownDimension;
  key: string;
  impressions: number;
  clicks: number;
  spend: Santim;
  conversions: number;
}
