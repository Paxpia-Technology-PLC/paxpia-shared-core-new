// Gift catalog + coin-wallet logic — the platform-free single source of truth shared by
// web and mobile (lifted from Paxpia-mobile/src/data/liveData.ts, 2026-06-24). A gift's
// visual identity is its EMOJI; every render site (panel, toast, gift feed, chat chip,
// notification) resolves the emoji from here via `giftEmojiFor()` so a gift can NEVER
// render a generic box glyph.
//
// Wallet ops are PURE reducers over `WalletState`: `debitGift` guards on balance and
// returns a discriminated result; `creditCoins` is idempotent by `purchaseId` so a
// retried purchase can't double-credit. STORAGE stays platform-specific (mobile MMKV /
// web localStorage / the wallet backend once wired) — this module owns only the rules,
// exactly like the overlay modules own fold rules but not transport. See
// paxpia-docs/SHARED-LIFT-BACKLOG-2026-06-24.md §Gifting + paxpia-docs/wallet.md.

export type GiftCategory = 'popular' | 'special' | 'luxury';

/** A catalog gift. Structurally compatible with mobile's `LiveGift` so the mobile
 *  catalog can re-export this without churn. */
export interface GiftInfo {
  id: string;
  name: string;
  emoji: string;
  coinCost: number;
  category: GiftCategory;
  gradientColors: string[];
}

export interface GiftCategoryInfo {
  id: GiftCategory;
  label: string;
}

export interface CoinPackage {
  id: string;
  coins: number;
  price: string;
  bonusCoins?: number;
  isPopular?: boolean;
}

// ─── Catalog (single source of truth) ─────────────────────────────────────────

export const GIFT_CATALOG: GiftInfo[] = [
  // Popular
  { id: 'rose',      name: 'Rose',      emoji: '🌹', coinCost: 1,    category: 'popular', gradientColors: ['#FF6B9D', '#FF4081'] },
  { id: 'like',      name: 'Like',      emoji: '👍', coinCost: 5,    category: 'popular', gradientColors: ['#4FC3F7', '#0288D1'] },
  { id: 'candy',     name: 'Candy',     emoji: '🍬', coinCost: 10,   category: 'popular', gradientColors: ['#F48FB1', '#E91E63'] },
  { id: 'ice_cream', name: 'Ice Cream', emoji: '🍦', coinCost: 15,   category: 'popular', gradientColors: ['#81D4FA', '#29B6F6'] },
  { id: 'pizza',     name: 'Pizza',     emoji: '🍕', coinCost: 20,   category: 'popular', gradientColors: ['#FFCC80', '#FF9800'] },
  { id: 'fire',      name: 'Fire',      emoji: '🔥', coinCost: 25,   category: 'popular', gradientColors: ['#FF7043', '#E64A19'] },
  // Special
  { id: 'star',      name: 'Star',      emoji: '⭐', coinCost: 50,   category: 'special', gradientColors: ['#FFF176', '#F9A825'] },
  { id: 'trophy',    name: 'Trophy',    emoji: '🏆', coinCost: 100,  category: 'special', gradientColors: ['#FFD54F', '#F57F17'] },
  { id: 'unicorn',   name: 'Unicorn',   emoji: '🦄', coinCost: 150,  category: 'special', gradientColors: ['#CE93D8', '#9C27B0'] },
  { id: 'rocket',    name: 'Rocket',    emoji: '🚀', coinCost: 200,  category: 'special', gradientColors: ['#80DEEA', '#00BCD4'] },
  // Luxury
  { id: 'diamond',   name: 'Diamond',   emoji: '💎', coinCost: 500,  category: 'luxury',  gradientColors: ['#80D8FF', '#40C4FF'] },
  { id: 'crown',     name: 'Crown',     emoji: '👑', coinCost: 1000, category: 'luxury',  gradientColors: ['#FFD700', '#FFA000'] },
  { id: 'castle',    name: 'Castle',    emoji: '🏯', coinCost: 2000, category: 'luxury',  gradientColors: ['#B39DDB', '#7E57C2'] },
  { id: 'galaxy',    name: 'Galaxy',    emoji: '🌌', coinCost: 5000, category: 'luxury',  gradientColors: ['#9C27B0', '#4A148C'] },
];

export const GIFT_CATEGORIES: GiftCategoryInfo[] = [
  { id: 'popular', label: 'Popular' },
  { id: 'special', label: 'Special' },
  { id: 'luxury',  label: 'Luxury' },
];

export const COIN_PACKAGES: CoinPackage[] = [
  { id: 'c65',   coins: 65,   price: '$0.99' },
  { id: 'c330',  coins: 330,  price: '$4.99',  bonusCoins: 30 },
  { id: 'c660',  coins: 660,  price: '$9.99',  bonusCoins: 60,  isPopular: true },
  { id: 'c1321', coins: 1321, price: '$19.99', bonusCoins: 121 },
  { id: 'c3303', coins: 3303, price: '$49.99', bonusCoins: 303 },
  { id: 'c6607', coins: 6607, price: '$99.99', bonusCoins: 607 },
];

const GIFT_BY_ID: Record<string, GiftInfo> = Object.fromEntries(
  GIFT_CATALOG.map((g) => [g.id, g]),
);

/** A real gift glyph fallback — NEVER a default box/placeholder. Used when a gift's
 *  emoji is absent (an unknown id off the wire, or a synthesized toast). */
export const GIFT_FALLBACK_EMOJI = '🎁';

/** Resolve a gift's display emoji. Priority: an explicit non-empty emoji → the catalog
 *  emoji for the id → 🎁. Always returns a real glyph (the box icon can never surface). */
export function giftEmojiFor(opts: { emoji?: string | null; id?: string | null }): string {
  const explicit = opts.emoji?.trim();
  if (explicit) return explicit;
  if (opts.id) {
    const hit = GIFT_BY_ID[opts.id];
    if (hit?.emoji) return hit.emoji;
  }
  return GIFT_FALLBACK_EMOJI;
}

/** Look up the full catalog entry for a gift id (or undefined if unknown). */
export function giftById(id?: string | null): GiftInfo | undefined {
  return id ? GIFT_BY_ID[id] : undefined;
}

/** Total coins a package grants (face value + bonus). */
export function coinsForPackage(pkg: CoinPackage): number {
  return pkg.coins + (pkg.bonusCoins ?? 0);
}

// ─── Wallet (pure reducers; storage is platform-specific) ─────────────────────

export interface WalletState {
  coinBalance: number;
  /** Idempotency guard: the last applied coin-purchase id (a retried purchase is a no-op). */
  lastPurchaseId?: string;
}

/** A fresh wallet. Negatives/fractions are floored to a clean non-negative integer. */
export function emptyWallet(initialBalance = 0): WalletState {
  return { coinBalance: Math.max(0, Math.floor(initialBalance)) };
}

export type DebitResult =
  | { ok: true; wallet: WalletState; gift: GiftInfo; spent: number }
  | { ok: false; reason: 'unknown-gift' }
  | { ok: false; reason: 'insufficient-balance'; gift: GiftInfo; shortfall: number };

/** Debit a gift send from the wallet. PURE — returns a discriminated result and never
 *  mutates `wallet`. On success the caller broadcasts the `overlay.gift` toast; on
 *  `insufficient-balance` it should open the coins shop (see mobile's send flow). */
export function debitGift(wallet: WalletState, giftId: string): DebitResult {
  const gift = GIFT_BY_ID[giftId];
  if (!gift) return { ok: false, reason: 'unknown-gift' };
  if (wallet.coinBalance < gift.coinCost) {
    return { ok: false, reason: 'insufficient-balance', gift, shortfall: gift.coinCost - wallet.coinBalance };
  }
  return {
    ok: true,
    wallet: { ...wallet, coinBalance: wallet.coinBalance - gift.coinCost },
    gift,
    spent: gift.coinCost,
  };
}

/** Whether the wallet can currently afford a gift (false for unknown ids). */
export function canAfford(wallet: WalletState, giftId: string): boolean {
  const gift = GIFT_BY_ID[giftId];
  return !!gift && wallet.coinBalance >= gift.coinCost;
}

/** Credit coins from a purchase. IDEMPOTENT by `purchaseId` — re-applying the same
 *  purchase returns the SAME state ref (so a network retry / double-tap can't double
 *  the balance). PURE. */
export function creditCoins(wallet: WalletState, coins: number, purchaseId: string): WalletState {
  if (wallet.lastPurchaseId === purchaseId) return wallet; // already applied
  const add = Math.max(0, Math.floor(coins));
  return { coinBalance: wallet.coinBalance + add, lastPurchaseId: purchaseId };
}

/** Credit a whole coin package (face + bonus), idempotent by the package's purchase id. */
export function purchasePackage(wallet: WalletState, pkg: CoinPackage, purchaseId: string): WalletState {
  return creditCoins(wallet, coinsForPackage(pkg), purchaseId);
}
