// Subscriptions / super-followers — a viewer's relationship to a CREATOR.
//
//   follow — free.
//   super  — a paid super-subscription. Any super-subscription lasts 30 days
//            from its most recent renewal and grants: priority placement of the
//            creator's live/scheduled streams in the viewer's feed, an enriched
//            profile view (the creator's private/paid classes surfaced at top),
//            (future) scheduled-stream notifications, and access to the
//            creator's private / paid classes.

export type SubscriptionKind = 'follow' | 'super';

export const SUPER_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface Subscription {
  followerId: string;
  creatorId: string;
  kind: SubscriptionKind;
  /** Unix ms of the most recent super renewal (only meaningful for 'super'). */
  superSince?: number;
}

/** When the current super-subscription lapses, or null if not a live super. */
export function superExpiry(sub: Subscription): number | null {
  if (sub.kind !== 'super' || !sub.superSince) return null;
  return sub.superSince + SUPER_DURATION_MS;
}

/** A super is ACTIVE within 30 days of its last renewal; once lapsed it silently
 *  degrades to a plain follow for gating + priority purposes. */
export function isActiveSuper(sub: Subscription, nowMs: number): boolean {
  const exp = superExpiry(sub);
  return exp != null && nowMs < exp;
}

/** Does the viewer get priority/enriched treatment for this creator right now? */
export function isSuperFollower(sub: Subscription | undefined, nowMs: number): boolean {
  return !!sub && isActiveSuper(sub, nowMs);
}

/** May this viewer watch a creator's private / paid class? (super-followers do;
 *  the creator + admins always do — caller passes those through `override`.) */
export function canViewGatedStream(
  sub: Subscription | undefined,
  nowMs: number,
  override = false,
): boolean {
  return override || isSuperFollower(sub, nowMs);
}
