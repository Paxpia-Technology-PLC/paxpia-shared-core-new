// weaveAds — inserting sponsored items into a feed array. PURE, and the single most
// test-worthy function in the ads client.
//
// ── WHY AN AD GETS ITS OWN ARRAY SLOT ────────────────────────────────────────────
//
// Not a node appended inside the cell of the post above it. This is a BILLING
// constraint, not a visual one: both feeds measure visibility with
// `onViewableItemsChanged`, which reports per CELL. The existing course-card splice
// appends its card inside the previous post's cell, so the list reports the POST's
// visibility and the course card has no measurable visibility of its own. Fine for a
// course card. Disqualifying for anything you charge money for — you would be invoicing
// an advertiser for a unit you cannot prove was on screen.
//
// Its own array slot gets each ad its own cell, its own viewability report, its own key
// and its own slot in the playback window.
//
// ── WHY THE KEY IS DERIVED FROM THE ANCHOR, NOT THE POSITION ────────────────────
//
// The synthetic item's id is `ad:<adId>:<anchorOrganicId>`. Deriving it from the
// neighbouring organic id rather than from an index means re-deriving after an append,
// a repost weave, or a restored scroll snapshot puts the same ad in the same place with
// the same key. No remount, no double impression, no scroll jump — and Reels snapshots,
// which persist an index, stay correct because they store ORGANIC indices and the ads
// re-weave deterministically around them.
//
// This is the same array-weaving pattern the feed already ships for reposts
// (`interleaveReposts` in mobile's repostStore), with a sparser cadence and a stricter
// purity rule: ads never enter the domain store, only the derived render array.

import type { AdFill, AdPlacement } from './types';

export interface WeaveCadence {
  /** Number of organic items before the FIRST ad. */
  firstAfter: number;
  /** Organic items between subsequent ads. */
  everyN: number;
}

/** Deliberately sparser than the course splice (every 5). An education feed with an ad
 *  every third card stops being an education feed; the inventory is worth more precisely
 *  because it is scarce. Reels never shows one before the 5th video — the first few
 *  swipes are where a session is won or lost. */
export const CADENCE: Record<AdPlacement, WeaveCadence> = {
  precept: { firstAfter: 3, everyN: 6 },
  reels:   { firstAfter: 4, everyN: 7 },
};

export interface WeaveOptions<T> {
  /** Build the platform's feed item from a fill. `anchorId` is the id of the organic
   *  item immediately above, and MUST be folded into the synthetic item's id. */
  toItem: (fill: AdFill, anchorId: string) => T;
  /** Read an item's stable id. */
  idOf: (item: T) => string;
  /**
   * Indices that already carry something promotional, which an ad must not stack on.
   *
   * On Precept this is the course splice, whose slots are `index % 5 === 0` starting at
   * index 0 — i.e. 0, 5, 10, 15, 20…  Ad anchors sit at `i ≡ 2 (mod 6)` — i.e. 2, 8,
   * 14, 20, 26…  The two collide where both hold, which by CRT is `i ≡ 20 (mod 30)`:
   * organic indices 20, 50, 80. Rare, but an ad plus a course card under one post reads
   * as a wall of promotion, so those slots are skipped and the ad waits for the next one.
   */
  isReservedSlot?: (index: number) => boolean;
  /** Override the cadence (tests, experiments). */
  cadence?: WeaveCadence;
}

/**
 * Weave `fills` into `organic`, returning a NEW array. `organic` is never mutated and
 * never inspected for ad-ness — the caller guarantees it is pure content.
 *
 * Returns `organic` by reference when there is nothing to do, so a memo downstream sees
 * an unchanged identity and no cell rebuilds.
 */
export function weaveAds<T>(
  organic: readonly T[],
  fills: readonly AdFill[],
  placement: AdPlacement,
  opts: WeaveOptions<T>,
): T[] {
  const { firstAfter, everyN } = opts.cadence ?? CADENCE[placement];

  if (!fills.length || !organic.length) return organic as T[];
  // A cadence that would divide by zero or march backwards is a programming error, not
  // a runtime condition — but returning the input is safer than looping forever.
  if (everyN <= 0 || firstAfter <= 0) return organic as T[];

  const out: T[] = [];
  let nextSlot = firstAfter;
  let adIdx = 0;

  for (let i = 0; i < organic.length; i++) {
    const item = organic[i];
    out.push(item);

    if (i + 1 !== nextSlot) continue;
    if (adIdx >= fills.length) continue;

    if (opts.isReservedSlot?.(i)) {
      // Skip this slot entirely and try again after another full interval, rather than
      // sliding the ad down by one — sliding would make the next slot land off-cadence
      // and cascade for the rest of the feed.
      nextSlot += everyN;
      continue;
    }

    out.push(opts.toItem(fills[adIdx], opts.idOf(item)));
    adIdx += 1;
    nextSlot += everyN;
  }

  return out;
}

/** The id every synthetic ad item carries. Exported so the mobile adapter and any test
 *  agree on the format rather than each building their own string. */
export function sponsoredItemId(adId: string, anchorOrganicId: string): string {
  return `ad:${adId}:${anchorOrganicId}`;
}

/** True for an id produced by `sponsoredItemId`. Cheap enough for a hot render path,
 *  and it means a leak-guard assertion needs no type information. */
export function isSponsoredItemId(id: string): boolean {
  return id.startsWith('ad:');
}

/**
 * How many ads a feed of `n` organic items can hold at a given cadence. Used by the
 * delivery hook to ask the server for the right number of fills instead of requesting a
 * fixed 10 and throwing most away — every unused fill is a wasted auction on the server
 * and a wasted row in its pacing ledger.
 */
export function slotCountFor(n: number, placement: AdPlacement, cadence?: WeaveCadence): number {
  const { firstAfter, everyN } = cadence ?? CADENCE[placement];
  if (n < firstAfter || everyN <= 0) return 0;
  return 1 + Math.floor((n - firstAfter) / everyN);
}
