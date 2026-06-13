// Codified account model — the single source of truth for WHO someone is and
// WHAT they may do. Shared verbatim by web + mobile (and mirrored by the backend
// auth/social services) so the two clients can never drift on gating.
//
// Three ORTHOGONAL dimensions, deliberately kept independent:
//   1. tier   — the account's own paid level (free | premium). Self-monetization.
//   2. grants — explicitly-approved roles. `educator` is MANUALLY APPROVED and is
//               the gate for the course/dashboard surface; independent of tier
//               (an educator may be free or premium).
//   3. badge  — the profile verification mark (blue check / approved-educator).
//
// Per-channel super-subscriptions a user holds to OTHER creators live in
// ./subscriptions — they are NOT part of the account itself.

export type AccountTier = 'free' | 'premium';

export type Grant = 'educator' | 'moderator' | 'admin';

/** Profile verification badge. `verified` = generic blue check; `educator` =
 *  approved-educator badge (blue-check styled, distinct label/tooltip). */
export type VerificationBadge = 'none' | 'verified' | 'educator';

export interface Account {
  id: string;
  /** Unique, human, realistic — NEVER a UUID. */
  username: string;
  displayName: string;
  avatarUrl?: string;
  tier: AccountTier;
  grants: Grant[];
  badge: VerificationBadge;
  /** Wallet/coin balance (coins) for gifts + paid classes. */
  balance?: number;
  createdAtUnix?: number;
}

export function hasGrant(a: Pick<Account, 'grants'>, g: Grant): boolean {
  return a.grants.includes(g);
}
export function isEducator(a: Pick<Account, 'grants'>): boolean {
  return hasGrant(a, 'educator');
}
export function isPremium(a: Pick<Account, 'tier'>): boolean {
  return a.tier === 'premium';
}
/** Any badge other than 'none' shows a blue check on the profile. */
export function isVerified(a: Pick<Account, 'badge'>): boolean {
  return a.badge !== 'none';
}
