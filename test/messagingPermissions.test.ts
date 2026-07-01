// Unit tests for the shared MESSAGING PERMISSIONS model (plan §1a authority rules):
// delete authority (poster ≤24h / owner|admin / moderator), thread management,
// channel posting gate, and promote/demote authority (owner un-demotable).
//
// Runs under Node's native TS type-stripping (same harness as chat.test.ts):
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/messagingPermissions.test.ts

import {
  canDeleteMessage,
  canManageThread,
  canPost,
  canPromote,
  canReact,
  isThreadManager,
  OWN_DELETE_EVERYONE_WINDOW_SEC,
  type DeleteContext,
} from '../src/messaging/permissions.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}

const NOW = 1_700_000_000;
const del = (over: Partial<DeleteContext>): DeleteContext => ({
  callerId: 'u1',
  messageSenderId: 'u1',
  messageCreatedAtUnix: NOW,
  scope: 'everyone',
  nowUnix: NOW,
  ...over,
});

// ── isThreadManager / canManageThread: owner + admin only ─────────────────────
{
  ok(isThreadManager('owner'), 'owner is a manager');
  ok(isThreadManager('admin'), 'admin is a manager');
  ok(!isThreadManager('member'), 'member is NOT a manager');
  ok(!isThreadManager(undefined), 'non-participant is NOT a manager');
  ok(!isThreadManager('weird'), 'unknown role is NOT a manager');
  ok(canManageThread('owner') && canManageThread('admin'), 'owner/admin can manage thread');
  ok(!canManageThread('member') && !canManageThread(undefined), 'member/non-participant cannot manage');
}

// ── canDeleteMessage: 'me' scope always allowed ───────────────────────────────
{
  ok(canDeleteMessage(del({ scope: 'me', callerId: 'x', messageSenderId: 'y', callerRole: 'member' })),
    "'me' scope: any viewer may hide for themself");
}

// ── canDeleteMessage: poster + everyone within the 24h window ─────────────────
{
  ok(canDeleteMessage(del({ callerId: 'u1', messageSenderId: 'u1', messageCreatedAtUnix: NOW - 60 })),
    'poster deletes own message within window');
  ok(canDeleteMessage(del({ callerId: 'u1', messageSenderId: 'u1', messageCreatedAtUnix: NOW - OWN_DELETE_EVERYONE_WINDOW_SEC })),
    'poster at exactly the window boundary is allowed');
  ok(!canDeleteMessage(del({ callerId: 'u1', messageSenderId: 'u1', messageCreatedAtUnix: NOW - OWN_DELETE_EVERYONE_WINDOW_SEC - 1 })),
    'poster past the 24h window is DENIED');
  ok(!canDeleteMessage(del({ callerId: 'u1', messageSenderId: 'other', callerRole: 'member', messageCreatedAtUnix: NOW - 1 })),
    "a plain member cannot everyone-delete someone else's message");
}

// ── canDeleteMessage: owner/admin any message, no window ───────────────────────
{
  ok(canDeleteMessage(del({ callerId: 'mod1', messageSenderId: 'other', callerRole: 'owner', messageCreatedAtUnix: NOW - 999_999 })),
    'owner deletes any message with no window');
  ok(canDeleteMessage(del({ callerId: 'a1', messageSenderId: 'other', callerRole: 'admin', messageCreatedAtUnix: 1 })),
    'admin deletes any message with no window');
}

// ── canDeleteMessage: moderator override, no membership, no window ─────────────
{
  ok(canDeleteMessage(del({ callerId: 's1', messageSenderId: 'other', callerRole: undefined, isModerator: true, messageCreatedAtUnix: 1 })),
    'moderator override-deletes any message (no membership, no window)');
  ok(canDeleteMessage(del({ scope: 'me', isModerator: true, callerId: 's1', messageSenderId: 'x' })),
    "moderator 'me' scope still allowed");
}

// ── canPost: dm/group everyone; channel owner/admin only ──────────────────────
{
  ok(canPost('dm', 'member'), 'member posts in a dm');
  ok(canPost('group', 'member'), 'member posts in a group');
  ok(canPost('channel', 'owner'), 'owner posts in a channel');
  ok(canPost('channel', 'admin'), 'admin posts in a channel');
  ok(!canPost('channel', 'member'), 'member CANNOT post in a channel (read + react only)');
  ok(!canPost('dm', undefined), 'non-participant cannot post anywhere');
  ok(!canPost('group', undefined), 'non-participant cannot post in a group');
}

// ── canReact: any participant (incl. a channel member) may react ──────────────
{
  ok(canReact('member') && canReact('owner') && canReact('admin'), 'any participant may react');
  ok(!canReact(undefined), 'non-participant cannot react');
}

// ── canPromote: manager acts; owner un-demotable ──────────────────────────────
{
  ok(canPromote('owner', 'member'), 'owner promotes a member');
  ok(canPromote('owner', 'admin'), 'owner demotes an admin');
  ok(canPromote('admin', 'member'), 'admin promotes a member');
  ok(!canPromote('owner', 'owner'), 'NOBODY may change an owner role (owner un-demotable)');
  ok(!canPromote('admin', 'owner'), 'admin cannot touch the owner');
  ok(!canPromote('member', 'member'), 'a member cannot promote anyone');
  ok(!canPromote(undefined, 'member'), 'a non-participant cannot promote');
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`messagingPermissions: ${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`messagingPermissions: ${passed} passed`);
