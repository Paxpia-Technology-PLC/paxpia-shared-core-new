// Unit tests for the WHITEBOARD-ON-DOC ANNOTATION model (Message D item 2 / Contract
// v2.1 P4). The annotation board IS a whiteboard board whose id is DERIVED from the doc
// + page + mode (`wbann:<docId>:<page>` single / `wbann:<docId>` scroll). So persistence
// + swap + viewer-render + resync come from the EXISTING whiteboard store/module — these
// tests prove the doc-scoped id derivation yields exactly the right SWAP/persist/isolate
// behaviour over the converged `ViewerState.boards`.
//
// Asserts:
//   1. ID DERIVATION — single keys per (doc,page); scroll keys per doc; parse round-trips.
//   2. PERSIST + SWAP across a PAGE FLIP (single mode) — page-1 strokes hidden on page-2
//      (blank), page-1 RESTORED on flip back; both survive in the converged store.
//   3. PERSIST + SWAP across a DOC SWITCH — doc-A board untouched while doc-B is active;
//      switching back re-presents doc-A's strokes.
//   4. PER-PAGE ISOLATION in single mode — a stroke on page 1 is NOT on page 2's board.
//   5. SCROLL mode — one board per doc (page-independent): strokes drawn at different
//      pages all land in the SAME `wbann:<docId>` board.
//   6. VIEWER RENDERS — a remote `overlay.wb.*` on the ann board id folds into the SAME
//      converged store a viewer reads via `boardStrokes(annBoardId)`.
//   7. RESYNC SNAPS-TO-CURRENT — the annotation board's transform resync reads the
//      board's persisted view (current), never a backlog (inherits Bug-2 fix).
//
// Runs under Node's native TS type-stripping (same harness as the sibling tests):
//     node --import ./test/ts-resolve.mjs --experimental-strip-types test/docAnnotation.test.ts

import {
  annBoardId,
  isAnnBoardId,
  parseAnnBoardId,
  docAnnotationStateFor,
  docAnnotationDocId,
  WB_ANN_PREFIX,
} from '../src/overlays/annotation.ts';
import {
  initialViewerState,
  applyWhiteboardMsg,
  applyWbPresenter,
  applyLiveSync,
  boardStrokes,
} from '../src/streaming/viewer.ts';
import { overlayModule } from '../src/overlays/registry.ts';
import { wbViewPersistKey } from '../src/streaming/persist.ts';
import type { WbStroke } from '../src/overlays/whiteboard.ts';
import type { ViewerState } from '../src/streaming/viewer.ts';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name} (got ${JSON.stringify(actual)})`);
}

const S = (id: string): WbStroke => ({ id, d: `M0 0 L10 ${id.length}`, color: '#ff3366', width: 6 });
/** Fold a local stroke onto an annotation board (the streamer-draws path). */
function draw(st: ViewerState, boardId: string, stroke: WbStroke): ViewerState {
  return applyWhiteboardMsg(st, { t: 'overlay.wb.stroke', v: 1, boardId, gen: 0, stroke });
}
/** The stroke ids currently on a board (what a viewer would PAINT for that board id). */
function ids(st: ViewerState, boardId: string): string[] {
  return boardStrokes(st, boardId).strokes.map((s) => s.id);
}
/** A minimal `doc`-kind OverlayInstance whose id IS the annotation docId (so the
 *  producer + viewer derive the SAME `wbann:<id>:<page>` board). */
function docOf(id: string, page = 0): Parameters<typeof applyLiveSync>[1]['doc'] {
  return { id, kind: 'doc', phase: 'active', gen: 1, payload: { title: id, pages: ['u'], page }, results: {} };
}

// ── 1. ID DERIVATION (the wbann:<docId>:<page> / wbann:<docId> scheme) ──────────
{
  eq(annBoardId('docA', 0, 'single'), 'wbann:docA:0', 'single mode keys per (doc,page) — page 0');
  eq(annBoardId('docA', 1, 'single'), 'wbann:docA:1', 'single mode keys per (doc,page) — page 1');
  eq(annBoardId('docA', 5, 'scroll'), 'wbann:docA', 'scroll mode keys per DOC (page ignored)');
  eq(annBoardId('docA', 0, 'scroll'), annBoardId('docA', 9, 'scroll'), 'scroll: any page → same per-doc board');
  ok(annBoardId('docA', 0, 'single') !== annBoardId('docA', 1, 'single'), 'single: different pages → different boards');
  ok(annBoardId('docA', 0, 'single') !== annBoardId('docB', 0, 'single'), 'single: different docs → different boards');

  ok(isAnnBoardId('wbann:docA:0'), 'isAnnBoardId true for an annotation id');
  ok(!isAnnBoardId('wb_tile_x'), 'isAnnBoardId false for a placed-tile board id');
  ok(WB_ANN_PREFIX === 'wbann:', 'the prefix is wbann:');

  eq(parseAnnBoardId('wbann:docA:3'), { docId: 'docA', page: 3 }, 'parse single → {docId,page}');
  eq(parseAnnBoardId('wbann:docA'), { docId: 'docA' }, 'parse scroll → {docId} (no page)');
  ok(parseAnnBoardId('wb_tile_x') === null, 'parse of a non-annotation id → null');

  const ds = docAnnotationStateFor('docA', 2, 'single', true);
  eq(ds, { on: true, boardId: 'wbann:docA:2', mode: 'single' }, 'docAnnotationStateFor builds the active descriptor');
}

// ── 2. PERSIST + SWAP across a PAGE FLIP (single mode) ─────────────────────────
{
  let st = initialViewerState();
  const DOC = 'lecture.pdf';
  const page1 = annBoardId(DOC, 0, 'single');
  const page2 = annBoardId(DOC, 1, 'single');

  // (a) On PAGE 1 the streamer draws two strokes.
  st = draw(st, page1, S('p1-a'));
  st = draw(st, page1, S('p1-b'));
  eq(ids(st, page1), ['p1-a', 'p1-b'], 'page-1 board has the two drawn strokes');

  // (b) FLIP to PAGE 2 → the ACTIVE board is page2 (blank): page-1 strokes are HIDDEN
  //     (a different key) but NOT discarded.
  eq(ids(st, page2), [], 'page-2 board is BLANK on flip (strokes SWAP, not bleed through)');
  ok(boardStrokes(st, page1).strokes.length === 2, 'page-1 strokes PERSIST in the store while page-2 is active');

  // Draw a stroke on page 2 — lands only on page-2's board.
  st = draw(st, page2, S('p2-x'));
  eq(ids(st, page2), ['p2-x'], 'page-2 board has only its own stroke');

  // (c) FLIP BACK to PAGE 1 → page-1 strokes are RESTORED exactly (re-addressed by key).
  eq(ids(st, page1), ['p1-a', 'p1-b'], 'flip BACK to page 1 RESTORES its strokes');
  eq(ids(st, page2), ['p2-x'], 'page-2 strokes still intact after flipping back to page 1');
}

// ── 3. PERSIST + SWAP across a DOC SWITCH ──────────────────────────────────────
{
  let st = initialViewerState();
  const aBoard = annBoardId('docA', 0, 'single');
  const bBoard = annBoardId('docB', 0, 'single');

  st = draw(st, aBoard, S('a1'));
  st = draw(st, aBoard, S('a2'));
  // Switch to docB (its board is a DIFFERENT key) → blank for docB; docA untouched.
  eq(ids(st, bBoard), [], 'switching to docB presents a BLANK annotation board');
  st = draw(st, bBoard, S('b1'));
  eq(ids(st, bBoard), ['b1'], 'docB board has only its own stroke');
  eq(ids(st, aBoard), ['a1', 'a2'], 'docA board UNTOUCHED by the doc switch');
  // Switch BACK to docA → strokes restored.
  eq(ids(st, aBoard), ['a1', 'a2'], 'switching back to docA re-presents its strokes');
}

// ── 4. PER-PAGE ISOLATION in single mode ───────────────────────────────────────
{
  let st = initialViewerState();
  const DOC = 'deck';
  st = draw(st, annBoardId(DOC, 0, 'single'), S('only-on-0'));
  ok(ids(st, annBoardId(DOC, 1, 'single')).length === 0, 'a page-0 stroke is NOT on page 1 (per-page isolation)');
  ok(ids(st, annBoardId(DOC, 2, 'single')).length === 0, 'a page-0 stroke is NOT on page 2');
  eq(ids(st, annBoardId(DOC, 0, 'single')), ['only-on-0'], 'the stroke stays on page 0 only');
}

// ── 5. SCROLL mode — one continuous board per doc ──────────────────────────────
{
  let st = initialViewerState();
  const DOC = 'reflow.epub';
  const scrollBoard = annBoardId(DOC, 0, 'scroll');
  // Strokes "drawn at different scroll positions" all key to the SAME per-doc board.
  st = draw(st, annBoardId(DOC, 0, 'scroll'), S('s1'));
  st = draw(st, annBoardId(DOC, 7, 'scroll'), S('s2')); // page arg ignored in scroll mode
  eq(ids(st, scrollBoard), ['s1', 's2'], 'scroll mode: all strokes land in ONE per-doc board (page-independent)');
}

// ── 6. VIEWER RENDERS the annotations (remote fold → boardStrokes) ─────────────
{
  // A viewer's converged store receives the streamer's `overlay.wb.*` on the ann board id
  // and reads it back via `boardStrokes(annBoardId)` — the exact path the DocOverlay
  // annotation layer paints from. (Snapshot REPLACES, like a late-joiner.)
  let viewer = initialViewerState();
  const DOC = 'shared.pdf';
  const board = annBoardId(DOC, 3, 'single');
  viewer = applyWhiteboardMsg(viewer, {
    t: 'overlay.wb.snapshot',
    v: 1,
    boardId: board,
    gen: 0,
    strokes: [S('v1'), S('v2'), S('v3')],
  });
  eq(ids(viewer, board), ['v1', 'v2', 'v3'], 'viewer renders the streamer annotations via boardStrokes(annBoardId)');
  // A viewer reading a DIFFERENT page's board sees nothing (the active board id is what
  // it paints — the descriptor drives which one).
  ok(ids(viewer, annBoardId(DOC, 4, 'single')).length === 0, 'viewer paints only the ACTIVE annotation board');
}

// ── 7. RESYNC SNAPS-TO-CURRENT (inherits the whiteboard module Bug-2 fix) ──────
{
  // The annotation board is a whiteboard board, so its transform resync is the whiteboard
  // module's onResync over the board's keyed view — snaps to the CURRENT converged value,
  // never a backlog. Drive the wb-presenter wire to pages of transforms; onResync reads
  // only the latest.
  let st = initialViewerState();
  const board = annBoardId('docZ', 0, 'single');
  const bkey = wbViewPersistKey(board);
  st = applyWbPresenter(st, board, { page: 0, zoom: 1, panX: 0, panY: 0 }); // A
  st = applyWbPresenter(st, board, { page: 0, zoom: 2, panX: 40, panY: 0 }); // B (during desync)
  st = applyWbPresenter(st, board, { page: 0, zoom: 3, panX: 160, panY: 0 }); // C (latest)
  const snap = overlayModule('whiteboard').onResync(st, bkey);
  ok(snap !== null, 'annotation board onResync returns a transform snap');
  eq(snap!.transform.zoom, 3, 'annotation resync snaps to CURRENT zoom 3 (not backlog A/B)');
  eq(snap!.transform.panX, 160, 'annotation resync snaps to CURRENT panX 160');
}

// ── 8. WIRE FOLD — live.sync.docAnn presence into ViewerState.docAnn ────────────
{
  // The viewer learns annotation presence ONLY from the streamer's `live.sync.docAnn`
  // (the strokes ride overlay.wb.* keyed by the board id). Folding it must: set on toggle,
  // carry-forward when absent, HIDE (on:false) without dropping strokes, and clear on
  // doc-clear / end-wipe.
  const DOC = 'lecture.pdf';
  const board = annBoardId(DOC, 0, 'single');

  // (a) Toggle ON arrives → state.docAnn folds; strokes drawn separately still render.
  let st = initialViewerState();
  st = draw(st, board, S('x'));
  st = applyLiveSync(st, {
    t: 'live.sync',
    v: 1,
    doc: docOf(DOC),
    docAnn: { on: true, boardId: board, mode: 'single' },
  });
  eq(st.docAnn, { on: true, boardId: board, mode: 'single' }, 'live.sync folds docAnn presence (on)');
  eq(ids(st, board), ['x'], 'the annotation strokes render from the converged board (content + presence are separate wires)');

  // (b) A later snapshot WITHOUT docAnn keeps the prior descriptor (carry-forward).
  st = applyLiveSync(st, { t: 'live.sync', v: 1, doc: docOf(DOC), docPresenter: { page: 0, zoom: 2, panX: 0, panY: 0 } });
  eq(st.docAnn?.on, true, 'a snapshot without docAnn carries the prior descriptor forward');

  // (c) Toggle OFF (on:false) → the layer HIDES but the strokes PERSIST (present-not-destroy).
  st = applyLiveSync(st, { t: 'live.sync', v: 1, doc: docOf(DOC), docAnn: { on: false, boardId: board, mode: 'single' } });
  eq(st.docAnn?.on, false, 'toggle-off folds on:false (layer hidden)');
  eq(ids(st, board), ['x'], 'toggle-off does NOT discard the annotation strokes (they persist in boards)');

  // (d) A doc-clear (doc:null, not an end-wipe) drops a stale annotation descriptor.
  st = applyLiveSync(st, { t: 'live.sync', v: 1, doc: null, scene: { id: 's', name: 's', items: [] } });
  ok(st.docAnn === null, 'a doc-clear drops the stale annotation descriptor');
  eq(ids(st, board), ['x'], 'a doc-clear still does NOT discard the strokes (re-serving the doc resumes them)');

  // (e) End-wipe clears the descriptor.
  let st2 = initialViewerState();
  st2 = applyLiveSync(st2, { t: 'live.sync', v: 1, doc: docOf(DOC), docAnn: { on: true, boardId: board, mode: 'single' } });
  st2 = applyLiveSync(st2, { t: 'live.sync', v: 1, doc: null, scene: null });
  ok(st2.docAnn === null, 'end-wipe clears the annotation descriptor');
  eq(st2.phase, 'ended', 'end-wipe still ends the stream');
}

// ── 9. PER-DOCUMENT IDENTITY (R7) — strokes tie to the DOC, not the slot ────────
{
  // The board must key off the DOCUMENT, so swapping a different doc into the same slot
  // starts BLANK (not the slot's old strokes). `docAnnotationDocId` keys off the
  // path-stripped sourceUrl (stable across re-grants + producer↔viewer), falling back to
  // the instance id when there's no url.
  ok(
    docAnnotationDocId('srv_a-doc', 'https://cdn/x/lecture.pdf?token=AAA') !==
      docAnnotationDocId('srv_a-doc', 'https://cdn/x/other.pdf?token=AAA'),
    'two different docs in the SAME slot → DIFFERENT board ids (no bleed)',
  );
  eq(
    docAnnotationDocId('srv_a-doc', 'https://cdn/x/lecture.pdf?token=AAA'),
    docAnnotationDocId('srv_a-doc', 'https://cdn/x/lecture.pdf?token=ZZZ-regranted'),
    'the SAME doc re-granted (new token query) → SAME board id (strokes resume)',
  );
  eq(docAnnotationDocId('inst-1', undefined), 'inst-1', 'no sourceUrl → falls back to the instance id');
  eq(docAnnotationDocId('inst-1', ''), 'inst-1', 'empty sourceUrl → falls back to the instance id');
}

// ── report ─────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`docAnnotation: ${passed} assertions passed`);
