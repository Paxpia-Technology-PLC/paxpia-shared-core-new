// Unit tests for @paxpia/core/wallet — the gift catalog + coin-wallet rules lifted from
// Paxpia-mobile (2026-06-24). Pure reducers, no platform deps. Same harness as the
// sibling tests:
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/walletGift.test.ts
//
// Asserts: catalog integrity (14 gifts, unique ids, real emojis, valid categories) ·
// emoji resolution priority (explicit → catalog → 🎁, never a box) · coin-package math
// (face+bonus) · debitGift success is PURE + carries the gift · insufficient returns the
// shortfall + the gift (to open the shop) · unknown gift rejected · canAfford · creditCoins
// adds AND is idempotent by purchaseId · purchasePackage credits face+bonus idempotently ·
// emptyWallet floors junk input.

import {
  GIFT_CATALOG,
  GIFT_CATEGORIES,
  COIN_PACKAGES,
  GIFT_FALLBACK_EMOJI,
  giftEmojiFor,
  giftById,
  coinsForPackage,
  emptyWallet,
  debitGift,
  canAfford,
  creditCoins,
  purchasePackage,
} from '../src/wallet/gift.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

// ── 1. CATALOG INTEGRITY ─────────────────────────────────────────────────────────
{
  ok(GIFT_CATALOG.length === 14, 'catalog has 14 gifts');
  ok(new Set(GIFT_CATALOG.map((g) => g.id)).size === 14, 'gift ids are unique');
  ok(GIFT_CATALOG.every((g) => !!g.emoji && g.emoji.trim().length > 0), 'every gift has a non-empty emoji');
  const cats = new Set(['popular', 'special', 'luxury']);
  ok(GIFT_CATALOG.every((g) => cats.has(g.category)), 'every gift has a valid category');
  ok(GIFT_CATALOG.every((g) => Number.isInteger(g.coinCost) && g.coinCost > 0), 'every gift has a positive integer coinCost');
  ok(GIFT_CATALOG.every((g) => Array.isArray(g.gradientColors) && g.gradientColors.length === 2), 'every gift has a 2-stop gradient');
  eq(GIFT_CATEGORIES.map((c) => c.id), ['popular', 'special', 'luxury'], 'categories present in order');
  ok(COIN_PACKAGES.length === 6, 'six coin packages');
}

// ── 2. EMOJI RESOLUTION (never a box) ────────────────────────────────────────────
{
  eq(giftEmojiFor({ id: 'rose' }), '🌹', 'catalog emoji resolved by id');
  eq(giftEmojiFor({ emoji: '🎈', id: 'rose' }), '🎈', 'explicit emoji wins over the catalog');
  eq(giftEmojiFor({ id: 'does-not-exist' }), GIFT_FALLBACK_EMOJI, 'unknown id falls back to 🎁 (never a box)');
  eq(giftEmojiFor({ emoji: '   ', id: 'rose' }), '🌹', 'a blank explicit emoji is ignored, catalog used');
  eq(giftEmojiFor({}), GIFT_FALLBACK_EMOJI, 'no hints → fallback glyph');
  ok(giftById('crown')?.coinCost === 1000, 'giftById returns the full catalog entry');
  ok(giftById('nope') === undefined, 'giftById on an unknown id → undefined');
}

// ── 3. COIN PACKAGE MATH (face + bonus) ──────────────────────────────────────────
{
  const p660 = COIN_PACKAGES.find((p) => p.id === 'c660')!;
  eq(coinsForPackage(p660), 720, 'package coins = face + bonus (660 + 60)');
  const p65 = COIN_PACKAGES.find((p) => p.id === 'c65')!;
  eq(coinsForPackage(p65), 65, 'a package with no bonus = face value');
}

// ── 4. debitGift SUCCESS (pure) ──────────────────────────────────────────────────
{
  const w = emptyWallet(100);
  const r = debitGift(w, 'trophy'); // costs 100
  ok(r.ok === true, 'debit succeeds when affordable');
  if (r.ok) {
    eq(r.wallet.coinBalance, 0, 'balance decremented by the gift cost');
    eq(r.spent, 100, 'spent equals the gift cost');
    eq(r.gift.id, 'trophy', 'result carries the resolved gift');
  }
  eq(w.coinBalance, 100, 'debit is PURE — the input wallet is unchanged');
}

// ── 5. debitGift INSUFFICIENT ────────────────────────────────────────────────────
{
  const w = emptyWallet(10);
  const r = debitGift(w, 'trophy'); // costs 100
  ok(r.ok === false, 'debit fails when the wallet is too poor');
  if (!r.ok && r.reason === 'insufficient-balance') {
    eq(r.shortfall, 90, 'shortfall = cost - balance');
    eq(r.gift.id, 'trophy', 'an insufficient result still names the gift (to open the coins shop)');
  } else {
    ok(false, 'expected an insufficient-balance result');
  }
}

// ── 6. debitGift UNKNOWN ─────────────────────────────────────────────────────────
{
  const r = debitGift(emptyWallet(1000), 'not-a-gift');
  ok(r.ok === false && r.reason === 'unknown-gift', 'an unknown gift id → unknown-gift');
}

// ── 7. canAfford ─────────────────────────────────────────────────────────────────
{
  const w = emptyWallet(50);
  ok(canAfford(w, 'star') === true, 'can afford a 50-coin gift with exactly 50 coins');
  ok(canAfford(w, 'trophy') === false, 'cannot afford a 100-coin gift with 50');
  ok(canAfford(w, 'nope') === false, 'cannot afford an unknown gift');
}

// ── 8. creditCoins + IDEMPOTENCY ─────────────────────────────────────────────────
{
  let w = emptyWallet(0);
  w = creditCoins(w, 660, 'purchase-1');
  eq(w.coinBalance, 660, 'coins credited');
  const same = creditCoins(w, 660, 'purchase-1'); // SAME purchase id (a retry)
  ok(same === w, 're-applying the SAME purchase id is a no-op (same ref) — no double credit');
  w = creditCoins(w, 330, 'purchase-2');
  eq(w.coinBalance, 990, 'a NEW purchase id credits again');
}

// ── 9. purchasePackage (face+bonus, idempotent) ──────────────────────────────────
{
  const pkg = COIN_PACKAGES.find((p) => p.id === 'c660')!; // 660 + 60 = 720
  let w = emptyWallet(0);
  w = purchasePackage(w, pkg, 'order-9');
  eq(w.coinBalance, 720, 'a package purchase credits face + bonus');
  const again = purchasePackage(w, pkg, 'order-9');
  ok(again === w, 'a duplicate package purchase (same id) is idempotent');
}

// ── 10. emptyWallet floors junk input ────────────────────────────────────────────
{
  eq(emptyWallet(-5).coinBalance, 0, 'a negative initial balance floors to 0');
  eq(emptyWallet(10.9).coinBalance, 10, 'a fractional initial balance floors down');
}

// ── report ───────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`walletGift: ${passed} assertions passed`);
