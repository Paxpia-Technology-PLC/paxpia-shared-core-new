// Money for the ads surfaces — ETB presentation, VAT, and the derived rate metrics.
//
// ── WHY INTEGER SANTIM ───────────────────────────────────────────────────────────
//
// Every amount in the ads model is an integer count of santim (1 birr = 100 santim).
// Floats are not acceptable on something that ends up on an invoice: 0.1 + 0.2 !== 0.3,
// and an advertiser reconciling a receipt against a bank statement will find the
// discrepancy long before you do.
//
// ── WHY THE CLIENT NEVER CONVERTS ────────────────────────────────────────────────
//
// These helpers FORMAT and they DERIVE RATIOS. They never price anything, never convert
// currency, and never compute what to charge. The server prices; the client displays.

import type { Santim } from './types';

export const SANTIM_PER_BIRR = 100;

/** Ethiopian VAT. Shown as a separate line on every receipt — a business cannot expense
 *  what it cannot document, and an ads product that can't issue a compliant receipt
 *  can't invoice a business at all. */
export const VAT_RATE = 0.15;

export function birrToSantim(birr: number): Santim {
  return Math.round(birr * SANTIM_PER_BIRR) as Santim;
}

export function santimToBirr(s: Santim): number {
  return s / SANTIM_PER_BIRR;
}

/**
 * Format santim as ETB for display.
 *
 * Compact form (`ETB 1.2K`) is for dense surfaces — stat tiles, list rows — where the
 * exact figure is noise. Anything the advertiser might reconcile against money that
 * actually left their account gets the exact form, always.
 */
export function fmtETB(s: Santim, opts: { compact?: boolean; whole?: boolean } = {}): string {
  const birr = santimToBirr(s);
  // `whole` is for CHOICES rather than amounts — budget rungs, presets. Compact would
  // render the 1,000-birr rung as "ETB 1.0K" while its neighbour shows "ETB 500", and a
  // row of options that change format mid-row is hard to compare at a glance. Exact
  // would render "ETB 1,000.00", which is precision nobody asked for on a chip.
  if (opts.whole) {
    return `ETB ${Math.round(birr).toLocaleString('en-US')}`;
  }
  if (opts.compact) {
    if (Math.abs(birr) >= 1_000_000) return `ETB ${(birr / 1_000_000).toFixed(1)}M`;
    if (Math.abs(birr) >= 1_000) return `ETB ${(birr / 1_000).toFixed(1)}K`;
    return `ETB ${Math.round(birr)}`;
  }
  return `ETB ${birr.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface VatBreakdown {
  /** What the advertiser spent, excluding tax. */
  net: Santim;
  vat: Santim;
  gross: Santim;
  ratePct: number;
}

/** Split a VAT-INCLUSIVE total into its net and tax parts. Prices are quoted inclusive
 *  here, so this is the direction a receipt actually needs. */
export function vatFromGross(gross: Santim): VatBreakdown {
  const net = Math.round(gross / (1 + VAT_RATE));
  return { net: net as Santim, vat: (gross - net) as Santim, gross, ratePct: VAT_RATE * 100 };
}

/** Add VAT to a net amount, for the rare surface that quotes exclusive. */
export function vatFromNet(net: Santim): VatBreakdown {
  const vat = Math.round(net * VAT_RATE);
  return { net, vat: vat as Santim, gross: (net + vat) as Santim, ratePct: VAT_RATE * 100 };
}

// ─── Derived rate metrics ────────────────────────────────────────────────────────
//
// All of these are RATIOS, and every one returns undefined rather than 0 or NaN when
// its denominator is empty. That distinction matters on a dashboard: "no clicks yet"
// and "a 0% click rate" mean different things to someone deciding whether to keep
// spending, and rendering the second when you mean the first is a lie.

/** Clicks ÷ impressions. The measure of whether an ad is any good, independent of how
 *  much exposure it happened to get — which is exactly why it is the multiplier in the
 *  auction: a brand-new ad has no click COUNT to compare, but it can have a predicted
 *  RATE. Returned as a fraction (0.01), not a percentage. */
export function ctr(clicks: number, impressions: number): number | undefined {
  return impressions > 0 ? clicks / impressions : undefined;
}

/** Cost per thousand impressions. */
export function cpm(spend: Santim, impressions: number): Santim | undefined {
  return impressions > 0 ? (Math.round((spend / impressions) * 1000) as Santim) : undefined;
}

export function cpc(spend: Santim, clicks: number): Santim | undefined {
  return clicks > 0 ? (Math.round(spend / clicks) as Santim) : undefined;
}

/** Cost per acquisition — the number that decides whether an advertiser stays. */
export function cpa(spend: Santim, conversions: number): Santim | undefined {
  return conversions > 0 ? (Math.round(spend / conversions) as Santim) : undefined;
}

/** Return on ad spend, as a multiple. */
export function roas(revenue: Santim, spend: Santim): number | undefined {
  return spend > 0 ? revenue / spend : undefined;
}

/** Average times each reached person saw the ad. */
export function frequency(impressions: number, reach: number): number | undefined {
  return reach > 0 ? impressions / reach : undefined;
}

/**
 * Effective CPM — any bid expressed as expected revenue per thousand impressions, so
 * bids of different KINDS can be compared in one auction.
 *
 * This is the whole trick behind "the highest bidder does not win". A 2.00 birr click
 * bid at a 1% predicted rate is worth 20 birr per thousand; a 1.00 birr click bid at 5%
 * is worth 50. The second advertiser wins while bidding half as much, because their ad
 * earns the platform more per slot. Relevance is literally convertible into money,
 * which is what keeps the feed from filling with whatever has the largest budget.
 *
 * The client never RUNS the auction — but it explains it, and the delivery diagnostics
 * are meaningless to an advertiser who doesn't know this is how they are ranked.
 */
export function eCPM(bidPerAction: Santim, predictedActionRate: number): Santim {
  return Math.round(bidPerAction * predictedActionRate * 1000) as Santim;
}

/** Format a fraction as a percentage string, e.g. 0.0123 → "1.23%". */
export function fmtPct(fraction: number | undefined, digits = 2): string {
  if (fraction === undefined || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}
