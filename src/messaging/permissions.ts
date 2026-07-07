// MESSAGING PERMISSIONS — the PURE authority model for delete / thread-management /
// posting / promotion, lifted into @paxpia/core so web + mobile gate the UI the
// SAME way the messaging service gates the API. This is the client mirror of the
// server-enforced rules (plan §1a); the client uses it to hide/disable affordances,
// the server re-checks everything — never trust the client for authorization.
//
// The vocabulary (see ./types.ts):
//   • ParticipantRole = 'owner' | 'admin' | 'member' — authority WITHIN a thread.
//   • moderator       = an EXTERNAL staff grant (`moderator` in the JWT), forwarded
//                       to messaging as a header. It is NOT a participant role; it
//                       grants stealth read + override delete across ALL threads.
//
// Everything here is a pure boolean function of plain facts — no I/O, no React, no
// platform. Exhaustive over the role union so a new role can't silently fall through.

import type { ThreadKind } from './types';

/** The everyone-scope "own message" delete window: a poster may delete their OWN
 *  message for EVERYONE only within 24h of sending. Owner/admin/moderator deletes
 *  have NO window. Kept here (not magic-numbered at call sites) so web + mobile use
 *  the identical cutoff the server enforces. */
export const OWN_DELETE_EVERYONE_WINDOW_SEC = 24 * 60 * 60;

/** The delete scope: 'me' hides the message only for the caller (always allowed on
 *  any message the caller can see); 'everyone' tombstones it for the whole thread
 *  (authority-gated + windowed for a poster). */
export type DeleteScope = 'me' | 'everyone';

/** The facts a delete-authority decision is made from. Snake-free (this is the
 *  domain layer); callers map wire fields → these. */
export interface DeleteContext {
  /** The signed-in caller's user id. */
  callerId: string;
  /** The caller's role in the thread the message lives in (`undefined` when the
   *  caller is not a participant — e.g. a moderator acting via the staff header). */
  callerRole?: ParticipantRoleOrUnknown;
  /** True when the caller holds the external staff `moderator` grant. */
  isModerator?: boolean;
  /** The message author's user id. */
  messageSenderId: string;
  /** When the message was sent (unix seconds) — for the poster's 24h window. */
  messageCreatedAtUnix: number;
  /** The delete scope being attempted. Defaults to 'everyone' (the gated case);
   *  'me' is always permitted for a message the caller can see. */
  scope?: DeleteScope;
  /** "Now" in unix seconds (injected so the decision is pure + testable). Defaults
   *  to the real clock when omitted. */
  nowUnix?: number;
}

/** A role that may be an unknown string off the wire, or absent (non-participant). */
export type ParticipantRoleOrUnknown = 'owner' | 'admin' | 'member' | string | undefined;

/** True iff the role is a thread MANAGER (owner or admin) — the authority tier that
 *  can moderate the thread (delete any message, promote/demote, post in a channel).
 *  Exhaustive + tolerant of unknown wire strings (anything not owner/admin ⇒ false). */
export function isThreadManager(role: ParticipantRoleOrUnknown): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * canDeleteMessage — the single delete-authority decision (plan §1a):
 *   • 'me' scope           → always allowed (the caller only hides it for themself).
 *   • poster, everyone     → allowed within {@link OWN_DELETE_EVERYONE_WINDOW_SEC}.
 *   • owner/admin, everyone→ allowed for ANY message in their thread, NO window.
 *   • moderator, everyone  → allowed for ANY message, NO window (staff override →
 *                            server sets moderation_status='blocked').
 * PURE. The server re-enforces the same rule; this only drives the UI.
 */
export function canDeleteMessage(ctx: DeleteContext): boolean {
  const scope = ctx.scope ?? 'everyone';
  // "Delete for me" only affects the caller's own view — anyone who can see the
  // message can hide it locally.
  if (scope === 'me') return true;

  // Staff override: a moderator can everyone-delete anything, no window, no
  // membership. (Sets moderation_status='blocked' server-side.)
  if (ctx.isModerator) return true;

  // Thread manager (owner/admin): any message in the thread, no window.
  if (isThreadManager(ctx.callerRole)) return true;

  // Poster deleting their OWN message for everyone: only inside the 24h window.
  if (ctx.callerId === ctx.messageSenderId) {
    const now = ctx.nowUnix ?? Math.floor(Date.now() / 1000);
    return now - ctx.messageCreatedAtUnix <= OWN_DELETE_EVERYONE_WINDOW_SEC;
  }

  return false;
}

/** canManageThread — may this role edit thread settings (title/avatar), manage
 *  membership (add/remove), and promote/demote? Owner + admin only. PURE. */
export function canManageThread(role: ParticipantRoleOrUnknown): boolean {
  return isThreadManager(role);
}

/**
 * canPost — may a participant with `role` SEND a message into a thread of `kind`?
 *   • dm / group → everyone posts (any role).
 *   • channel    → only owner/admin post; a member reads + reacts (no post).
 * A missing role (non-participant) can never post. PURE + exhaustive over kind.
 */
export function canPost(kind: ThreadKind, role: ParticipantRoleOrUnknown): boolean {
  if (!role) return false; // not a participant → cannot post
  switch (kind) {
    case 'dm':
    case 'group':
      return true;
    case 'channel':
      return isThreadManager(role);
    default:
      // Unknown/forward-compat kind: fail CLOSED to manager-only, matching the
      // most-restrictive real kind (channel). Never open posting to a kind we
      // don't understand.
      return isThreadManager(role);
  }
}

/**
 * canPromote — may `callerRole` change `targetRole`'s role (promote member→admin or
 * demote admin→member)? Plan §1a / §1b: caller must be owner/admin; the OWNER is
 * un-demotable (nobody can change an owner's role). An admin cannot act on another
 * admin's role is NOT required by the contract (owner/admin both manage members),
 * but NO caller may ever demote/alter the owner. PURE.
 *
 * Note: this gates the *authority to act*; the caller also can't promote ABOVE
 * admin (there is no "make owner" transfer in this contract) — that's enforced by
 * the API accepting only `{role:'admin'|'member'}`. Here we only answer "may the
 * caller touch the target's role at all".
 */
export function canPromote(
  callerRole: ParticipantRoleOrUnknown,
  targetRole: ParticipantRoleOrUnknown,
): boolean {
  // Only a thread manager can change roles.
  if (!isThreadManager(callerRole)) return false;
  // The owner's role is immutable — nobody demotes the owner.
  if (targetRole === 'owner') return false;
  return true;
}

/** canReact — may a participant react to a message? Every participant (any role) may
 *  react in dm/group/channel (a channel member can react even though they can't
 *  post). A non-participant cannot. PURE — included for a symmetric, exhaustive
 *  surface the UI gates the reaction bar with. */
export function canReact(role: ParticipantRoleOrUnknown): boolean {
  return !!role;
}
