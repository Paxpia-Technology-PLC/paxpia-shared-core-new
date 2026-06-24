// VIDEO COMMENTS — the persistent, threaded comment model (social service) lifted out
// of Paxpia-mobile's `CommentsSheet.tsx` + `socialApi.ts` so web + mobile share ONE
// flat→tree walk, ONE optimistic-like reducer, and ONE transport contract (2026-06-24,
// per paxpia-docs/SHARED-LIFT-BACKLOG-2026-06-24.md §Comments). This is the COMMENTS
// analog of the gift/wallet lift: pure types + logic here, the rn-web view in
// @paxpia/ui/social/CommentsPanel, the fetch/axios impl per platform behind `CommentsApi`.
//
// Distinct from EPHEMERAL live-stream chat (`@paxpia/core/streaming/chat.ts`): that is a
// fire-and-forget LiveKit data-track ring buffer; THIS is durable, paginated, nested
// (replies ≤ maxDepth), like/edit/delete-able social-graph state served by the social
// service (`/api/v1/social/videos/{id}/comments`). Web has never had a consumer; this
// module + CommentsPanel give it threaded comments for the first time.
//
// Author hydration is OUT of scope here: a `BackendComment` carries only `UserID`. The
// platform resolves name/avatar (mobile `useResolvedUser`, web's equivalent) at the
// render edge — core returns bare author ids so it stays platform-free, exactly like the
// listings rows. `maxDepth` is a parameter (default 3 ≡ depths 0..3) so the tree depth is
// a policy the caller owns, not a constant baked into the walk.

/** A comment row exactly as the social service returns it (PascalCase fields mirror the
 *  Go struct on the wire — kept verbatim from mobile's `socialApi.BackendComment` so the
 *  shared type IS the over-the-wire shape and neither client has to remap). `ParentID`
 *  null ⇒ a top-level comment; otherwise it's a reply to that id. `LikedByMe` is
 *  meaningful only for an authenticated caller (false for guests). */
export interface BackendComment {
  ID: string;
  VideoID: string;
  UserID: string;
  ParentID: string | null;
  Content: string;
  LikeCount: number;
  LikedByMe: boolean;
  CreatedAt: string;
  UpdatedAt: string;
}

/** The DEFAULT maximum nesting depth (0-indexed): depths 0,1,2,3 render → 4 levels.
 *  Mirrors mobile's `MAX_DEPTH = 3`. Callers can override via `buildCommentTree`'s arg. */
export const DEFAULT_COMMENT_MAX_DEPTH = 3;

/** One node in the FLATTENED display list the list renderer consumes — a `BackendComment`
 *  plus the render metadata the walk derives (depth, whether its replies are expanded /
 *  in-flight, and how many replies are known). `replyCount === undefined` means "replies
 *  not yet fetched" (show a neutral "View replies" affordance); a number (incl. 0) means
 *  they're known. This is the shape mobile called `FlatItem`; lifted unchanged so the
 *  shared CommentsPanel renders the same rows the mobile sheet does. */
export interface CommentNode {
  comment: BackendComment;
  /** 0 for a top-level comment; +1 per reply level. Never exceeds `maxDepth`. */
  depth: number;
  /** Are this comment's replies currently expanded in the UI? */
  expanded: boolean;
  /** Number of fetched replies, or `undefined` when replies haven't been loaded yet. */
  replyCount: number | undefined;
  /** True when this comment is the DEEPEST renderable level (depth === maxDepth): it can
   *  still be liked/edited/deleted but can neither be replied to nor host children. */
  isLeaf: boolean;
}

/** The per-comment like view-state the optimistic reducer owns, keyed by comment id. The
 *  render layer reads `{count, liked}` for each row from here, falling back to the
 *  comment's own `LikeCount`/`LikedByMe` until an entry exists. */
export interface CommentLikeState {
  count: number;
  liked: boolean;
}

/** The keyed like store (comment id → like view-state). Pure value; the platform holds it
 *  in React state and folds it with {@link optimisticLikeToggle}. */
export type CommentLikeMap = Record<string, CommentLikeState>;

/** Flatten a nested comment forest into the ordered display list the list renderer walks.
 *  PURE — same inputs → same list on web + mobile, so the thread renders identically.
 *
 *  - `top`            the top-level comments, newest-first as the service returns them.
 *  - `repliesByParent` parent-id → its fetched replies (absent ⇒ not yet loaded).
 *  - `expanded`       parent-id → whether its replies are shown (absent/false ⇒ collapsed).
 *  - `maxDepth`       deepest renderable depth (default {@link DEFAULT_COMMENT_MAX_DEPTH}).
 *
 *  A parent's replies are descended into ONLY when it is expanded, its replies are loaded,
 *  AND it is above `maxDepth` (so the tree can never render deeper than the policy). This
 *  is mobile's `displayList` `walk`, lifted verbatim. */
export function buildCommentTree(
  top: BackendComment[],
  repliesByParent: Record<string, BackendComment[] | undefined>,
  expanded: Record<string, boolean | undefined>,
  maxDepth: number = DEFAULT_COMMENT_MAX_DEPTH,
): CommentNode[] {
  const out: CommentNode[] = [];
  const walk = (items: BackendComment[], depth: number): void => {
    for (const c of items) {
      const replies = repliesByParent[c.ID];
      const isExpanded = !!expanded[c.ID];
      out.push({
        comment: c,
        depth,
        expanded: isExpanded,
        replyCount: replies?.length,
        isLeaf: depth >= maxDepth,
      });
      // Descend only when expanded, loaded, AND there's room below maxDepth.
      if (isExpanded && replies && depth < maxDepth) {
        walk(replies, depth + 1);
      }
    }
  };
  walk(top, 0);
  return out;
}

/** Can this depth host replies / a reply affordance? False once it's the deepest level. */
export function canReplyAt(depth: number, maxDepth: number = DEFAULT_COMMENT_MAX_DEPTH): boolean {
  return depth < maxDepth;
}

/** Read a comment's current like view-state: the optimistic entry if present, else the
 *  comment's own server fields. Lets the renderer always show a stable `{count, liked}`. */
export function likeStateFor(map: CommentLikeMap, comment: BackendComment): CommentLikeState {
  return map[comment.ID] ?? { count: comment.LikeCount, liked: comment.LikedByMe ?? false };
}

/** Seed/merge the like map from a freshly-fetched batch of comments (top-level or replies),
 *  so each row starts at its server count before any optimistic toggle. PURE. Existing
 *  entries are preserved unless `reset` is true (a fresh open / reload). */
export function seedLikeState(
  map: CommentLikeMap,
  comments: BackendComment[],
  reset = false,
): CommentLikeMap {
  const additions: CommentLikeMap = {};
  for (const c of comments) additions[c.ID] = { count: c.LikeCount, liked: c.LikedByMe ?? false };
  return reset ? additions : { ...map, ...additions };
}

/** Optimistically toggle a comment's like in the keyed store. PURE — returns a NEW map.
 *  `liked` is the CURRENT (pre-tap) liked state; the result flips it and adjusts the count
 *  by ±1 (clamped at 0). The platform applies this immediately, fires the network call,
 *  and on the server's authoritative reply overwrites the entry (or reverts on error by
 *  calling this again with the post-tap state). Mirrors mobile's optimistic `setLikeMap`. */
export function optimisticLikeToggle(
  state: CommentLikeMap,
  id: string,
  liked: boolean,
): CommentLikeMap {
  const cur = state[id] ?? { count: 0, liked };
  return {
    ...state,
    [id]: {
      count: liked ? Math.max(0, cur.count - 1) : cur.count + 1,
      liked: !liked,
    },
  };
}

/** Reconcile the like store against the server's authoritative result for one comment
 *  (after the POST/DELETE resolves). PURE. Use when the API returns the true count/liked. */
export function applyServerLike(
  state: CommentLikeMap,
  id: string,
  result: CommentLikeState,
): CommentLikeMap {
  return { ...state, [id]: { count: result.count, liked: result.liked } };
}

// ─── The transport seam (each platform supplies a fetch/axios impl) ───────────────
//
// Mirrors the `MaterialsClient` / `StudioConfigClient` pattern: core declares the
// CONTRACT; the platform binds it (mobile → the existing `socialApi.ts` functions;
// web → an axios/connect impl against the SAME `/api/v1/social/...` routes). Cursor
// pagination is preferred for new surfaces, but the current backend pages top-level
// comments by an integer `page` (20/page), so the list contract keeps `page` while
// allowing an optional `nextCursor` for when the service migrates. Auth lives in the
// impl (it holds the token), so the interface takes none — keeping core token-free.

/** A page of top-level comments. `page` echoes the requested page; `nextCursor` is set
 *  only once the service offers cursor pagination (empty/undefined ⇒ page-based). */
export interface CommentsPage {
  comments: BackendComment[];
  page: number;
  /** Cursor for the next page when the service supports it; absent on the page-based API. */
  nextCursor?: string;
}

/** A page of replies for one parent comment. Replies are currently returned whole (no
 *  paging) by the social service; `nextCursor` is reserved for when that changes. */
export interface RepliesPage {
  replies: BackendComment[];
  nextCursor?: string;
}

/** The authoritative like result the service returns for a comment like/unlike. */
export interface CommentLikeResult {
  commentId: string;
  count: number;
  liked: boolean;
}

/** The transport contract the shared comments logic + CommentsPanel consume. Each platform
 *  supplies an implementation (mobile wraps `socialApi.ts`; web an axios/connect client)
 *  against the social service's `/api/v1/social/...` routes. All methods are async and may
 *  reject; the UI handles the optimistic rollback. Token/auth is the impl's responsibility. */
export interface CommentsApi {
  /** List top-level comments for a video (page-based today; 1-indexed). */
  listComments(videoId: string, page?: number): Promise<CommentsPage>;
  /** List the replies of one comment (whole, no paging today). */
  listReplies(commentId: string): Promise<RepliesPage>;
  /** Post a new comment, or a reply when `parentId` is supplied. Returns the created row. */
  postComment(videoId: string, content: string, parentId?: string): Promise<BackendComment>;
  /** Edit a comment's body. Returns the updated row (new `Content`/`UpdatedAt`). */
  editComment(commentId: string, content: string): Promise<BackendComment>;
  /** Delete a comment (idempotent — a 404 is treated as already-gone by the impl). */
  deleteComment(commentId: string): Promise<void>;
  /** Toggle a comment's like. `liked` is the CURRENT state; impl POSTs (like) or DELETEs
   *  (unlike) and returns the authoritative count/liked, or `null` when the backend gave
   *  no body (the caller then keeps its optimistic value). */
  likeComment(commentId: string, liked: boolean): Promise<CommentLikeResult | null>;
}
