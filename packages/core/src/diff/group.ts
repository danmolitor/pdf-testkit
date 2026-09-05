/**
 * Causal grouping of semantic events for *human-facing* output only.
 *
 * A single structural change fans out into a large flat event list: on the
 * FormePDF invoice fixture, adding 14 table rows produces 123 events — 97 of
 * them the table's own subtree, 14 downstream page shifts, 4 the new page's
 * repeated footer, and 6 the three totals actually changing value. Every one is
 * individually accurate, and the list is still useless: a reviewer scrolling
 * past 123 rows approves without reading, which is the exact failure mode a
 * semantic differ exists to prevent.
 *
 * This module does NOT change what `diffSnapshots` emits. `DiffResult.events`,
 * the `--json` output, and `shouldFail` all keep the full precise per-element
 * list — machine consumers must not lose resolution. Grouping is a *view*, never
 * a filter: the union of every group's `events` equals the input list exactly,
 * and a test asserts it.
 *
 * It lives in core rather than in each formatter because the CLI, the matcher
 * failure message, and the GitHub Action all render the same list and all have
 * the same problem; three independently-maintained copies of a causality
 * heuristic is a drift bug waiting to happen.
 */

import type { DiffOptions, SemanticEvent, SemanticEventType, Severity } from '../events.js';
import type { NodeRole, StructuralNode, StructuralSnapshot } from '../types.js';
import { matchNodes } from './match.js';

export type GroupKind =
  | 'single'
  | 'table-resized'
  | 'page-shift-cascade'
  | 'on-page-shift-cascade'
  | 'new-page-furniture'
  | 'value-changed';

export interface EventGroup {
  kind: GroupKind;
  /** The member event that defines this group's severity and headline. */
  root: SemanticEvent;
  /** Always equals `root.severity`: a group never absorbs anything more severe. */
  severity: Severity;
  /** One line. For a `single` group this is just `root.message`. */
  summary: string;
  /** Every member, root first. Union across all groups === the input, exactly. */
  events: SemanticEvent[];
}

/**
 * A group under construction. `label` is how a cascade should name this group
 * when citing it as a cause — "the table's growth" rather than the group's own
 * full summary line.
 */
interface RawGroup {
  kind: GroupKind;
  rootIdx: number;
  members: number[];
  summary: string;
  label?: string;
}

/**
 * Everything the table rules need to reason about a logical table in *either*
 * direction. Growing and shrinking a document are the same change seen from
 * opposite ends, so every lookup here comes in a base/next pair: a rule that
 * only indexes the new snapshot silently stops working the moment content is
 * deleted instead of inserted.
 */
interface TableCtx {
  baseById: Map<string, StructuralNode>;
  nextById: Map<string, StructuralNode>;
  baseToNext: Map<string, string>;
  nextToBase: Map<string, string>;
  contBase: Map<string, string>;
  contNext: Map<string, string>;
  eventIdxByBaseId: Map<string, number>;
  eventIdxByNextId: Map<string, number>;
}

const RANK: Record<Severity, number> = { info: 0, warn: 1, error: 2 };

/**
 * Below this, a cascade is already readable as a flat list and collapsing it
 * would only cost information.
 */
const MIN_CASCADE_MEMBERS = 3;

/** Roles that are structural children of a table rather than content of their own. */
const TABLE_PARTS = new Set<NodeRole>(['row', 'cell']);

/**
 * Events that say where a node went. The rest (`text-overflowed-container`,
 * `heading-hierarchy-changed`) are extra observations *about* a node that may
 * also have a structural event, so they must never displace it when answering
 * "what happened to this node".
 */
const STRUCTURAL = new Set<SemanticEventType>([
  'element-added',
  'element-removed',
  'element-moved-to-different-page',
  'table-moved',
]);

/**
 * Collapse `events` into causally-related groups. Pass the same `opts` used for
 * the `diffSnapshots` call that produced `events` so node matching agrees.
 */
export function groupEvents(
  baseline: StructuralSnapshot,
  next: StructuralSnapshot,
  events: SemanticEvent[],
  opts: DiffOptions = {},
): EventGroup[] {
  if (events.length === 0) return [];

  const ignore = new Set<NodeRole>(opts.ignoreRoles ?? []);
  const baseNodes = baseline.nodes.filter((n) => !ignore.has(n.role));
  const nextNodes = next.nodes.filter((n) => !ignore.has(n.role));

  const baseById = byId(baseNodes);
  const nextById = byId(nextNodes);
  const baseRank = readingRank(baseNodes);
  const nextRank = readingRank(nextNodes);

  // Re-run the matcher rather than threading its result out of `diffSnapshots`:
  // it is deterministic over the same inputs, and grouping needs the *pairing*
  // (which base node became which next node) that the flat event list drops.
  const { pairs } = matchNodes(baseNodes, nextNodes);
  const baseToNext = new Map<string, string>();
  const nextToBase = new Map<string, string>();
  for (const p of pairs) {
    baseToNext.set(p.base.id, p.next.id);
    nextToBase.set(p.next.id, p.base.id);
  }

  // Event indices that carry a resolvable node, split by which snapshot the id
  // belongs to. `element-removed` is the only one pointing at the baseline.
  // One node can produce several events (an added cell that also overflows), so
  // a structural event always wins the slot over a decorative one.
  const eventIdxByNextId = new Map<string, number>();
  const eventIdxByBaseId = new Map<string, number>();
  events.forEach((e, i) => {
    if (!('nodeId' in e)) return;
    const into = e.type === 'element-removed' ? eventIdxByBaseId : eventIdxByNextId;
    const held = into.get(e.nodeId);
    if (held != null && !STRUCTURAL.has(e.type)) return;
    if (held != null && STRUCTURAL.has(events[held]!.type)) return;
    into.set(e.nodeId, i);
  });

  const pageCountIdx = events.findIndex((e) => e.type === 'page-count-changed');
  const repeated = repeatedNormTexts(nextNodes);
  /** The document lost pages rather than gaining them. */
  const shed = next.pageCount < baseline.pageCount;

  /**
   * Where a node sits in the *new* document's reading order. A removed node has
   * no position there at all, so it borrows the slot just after the last
   * surviving thing that preceded it in the baseline — which is exactly where
   * its absence is felt, and lets a deletion be cited as the cause of a shift.
   */
  const baseByRank = new Map<number, StructuralNode>();
  for (const n of baseNodes) {
    const r = baseRank.get(n.id);
    if (r != null) baseByRank.set(r, n);
  }
  const rankInNext = (nodeId: string): number | null => {
    const direct = nextRank.get(nodeId);
    if (direct != null) return direct;
    const from = baseRank.get(nodeId);
    if (from == null) return null;
    for (let r = from - 1; r >= 0; r--) {
      const prev = baseByRank.get(r);
      const mapped = prev == null ? undefined : baseToNext.get(prev.id);
      const rank = mapped == null ? undefined : nextRank.get(mapped);
      if (rank != null) return rank + 0.5;
    }
    return -0.5; // Removed from the very top of the document.
  };

  /** -1 = unclaimed. Otherwise the index of the group this event belongs to. */
  const claim: number[] = new Array(events.length).fill(-1);
  const groups: RawGroup[] = [];

  const open = (kind: GroupKind, rootIdx: number, summary: string, label?: string): number => {
    const id = groups.length;
    groups.push({ kind, rootIdx, members: [rootIdx], summary, label });
    claim[rootIdx] = id;
    return id;
  };
  const attach = (groupId: number, idx: number): void => {
    if (claim[idx] !== -1) return;
    claim[idx] = groupId;
    groups[groupId]!.members.push(idx);
  };

  // ── Rule 4 — paired value change ───────────────────────────────────────────
  // Runs FIRST, and deliberately pairs rather than collapses. A removed+added
  // text at the same slot is a real content change (here: three totals moving
  // by ~3x). Letting a later rule fold it into a "downstream cascade" summary
  // would hide the one fact in the whole diff a reviewer must not miss.
  for (const [removedIdx, addedIdx] of pairValueChanges(events, baseById, nextById, baseToNext)) {
    const removed = events[removedIdx]!;
    const added = events[addedIdx]!;
    const before = 'textPreview' in removed ? removed.textPreview : '';
    const after = 'textPreview' in added ? added.textPreview : '';
    const role = 'role' in added ? added.role : 'element';
    const id = open('value-changed', addedIdx, `${role} "${before}" → "${after}"`);
    attach(id, removedIdx);
  }

  // ── Rule 3 — page furniture ────────────────────────────────────────────────
  // A page that did not exist in the baseline brings a fresh copy of every
  // repeated fixed element with it; a page that goes away takes its copy with
  // it. Either way those adds/removes are a restatement of `page-count-changed`,
  // not independent findings — so the rule reads whichever snapshot holds the
  // pages that only exist on one side.
  if (pageCountIdx !== -1) {
    const side = shed
      ? {
          type: 'element-removed' as const,
          nodes: baseNodes,
          index: baseById,
          eventIdx: eventIdxByBaseId,
          repeated: repeatedNormTexts(baseNodes),
          firstGonePage: next.pageCount,
        }
      : {
          type: 'element-added' as const,
          nodes: nextNodes,
          index: nextById,
          eventIdx: eventIdxByNextId,
          repeated,
          firstGonePage: baseline.pageCount,
        };
    const furniture: number[] = [];
    for (const root of subtreeRoots(side.type, events, claim, side.index, side.eventIdx)) {
      if (root.node.pageIndex < side.firstGonePage) continue;
      // A table row is content wherever it sits. Line-item text can repeat
      // across pages by coincidence, and mistaking that for a running footer
      // would drag half a table into the page-count group.
      if (root.node.role === 'table' || TABLE_PARTS.has(root.node.role)) continue;
      const subtree = collectSubtree(root.node, side.nodes);
      if (!subtree.some((n) => n.normText != null && side.repeated.has(n.normText))) continue;
      for (const n of subtree) {
        const idx = side.eventIdx.get(n.id);
        if (idx != null && claim[idx] === -1) furniture.push(idx);
      }
    }
    if (furniture.length > 0) {
      const id = open(
        'new-page-furniture',
        pageCountIdx,
        furnitureSummary(events[pageCountIdx]!, furniture.length),
        'the page-count change',
      );
      for (const idx of furniture) attach(id, idx);
    }
  }

  // ── Rule 1 — table subtree resize ──────────────────────────────────────────
  // Restricted to row/cell/table roles on purpose. "Anything added under a node
  // that changed" would swallow a new paragraph inside a container that merely
  // moved; a row or a cell, by contrast, has no meaning apart from its table.
  // A table that spans a page break carries a continuation fragment, which the
  // extractor reports as a whole separate table. Those are resolved back to the
  // fragment that actually paired — on *both* sides, since the fragment that
  // exists alone lives in the baseline when the table shrank.
  const tables: TableCtx = {
    baseById,
    nextById,
    baseToNext,
    nextToBase,
    contBase: continuationAnchors(baseNodes, baseRank, repeatedNormTexts(baseNodes)),
    contNext: continuationAnchors(nextNodes, nextRank, repeated),
    eventIdxByBaseId,
    eventIdxByNextId,
  };

  // Bucket first, open second. The headline event is whichever fragment of the
  // chain reported one, which is not knowable until every member is in hand: a
  // table that spills onto a page it did not previously reach is announced by
  // the *new* fragment, not by the anchor the rows are attributed to.
  const byTable = new Map<string, number[]>(); // canonical table key -> event indices
  for (let i = 0; i < events.length; i++) {
    if (claim[i] !== -1) continue;
    const e = events[i]!;
    // element-moved joined with the same-page-movement work: a cell that
    // repositioned when its table gained a column is the resize, not a
    // separate finding.
    if (
      e.type !== 'element-added' &&
      e.type !== 'element-removed' &&
      e.type !== 'element-moved' &&
      e.type !== 'element-resized'
    )
      continue;

    const key = owningTable(e, tables);
    if (key == null) continue;
    const bucket = byTable.get(key);
    if (bucket) bucket.push(i);
    else byTable.set(key, [i]);
  }

  const tableGroups = new Map<string, number>(); // canonical table key -> group id
  for (const [key, members] of byTable) {
    // A chain whose fragments all survived intact reports nothing of its own;
    // the earliest row/cell change then stands in as the headline.
    const rootIdx = tableRootIdx(key, tables) ?? members[0]!;
    if (claim[rootIdx] !== -1) continue;
    const gid = open('table-resized', rootIdx, '');
    tableGroups.set(key, gid);
    for (const i of members) attach(gid, i);
  }
  for (const [key, gid] of tableGroups) {
    const g = groups[gid]!;
    const { summary, label } = tableSummary(key, tables, g.members, events);
    g.summary = summary;
    g.label = label;
  }

  // ── Rule 2 — uniform page-shift cascade ────────────────────────────────────
  // Partitioned by page *delta*, not destination: on the invoice fixture 8
  // elements go page 1→2 and 6 go page 2→3, so "everything moved to page 3"
  // would be flatly wrong. Partitioning by delta also separates two independent
  // insertions automatically, since they produce +1 and +2 regions.
  const movesByDelta = new Map<number, number[]>();
  events.forEach((e, i) => {
    if (claim[i] !== -1 || e.type !== 'element-moved-to-different-page') return;
    const d = e.toPage - e.fromPage;
    const bucket = movesByDelta.get(d);
    if (bucket) bucket.push(i);
    else movesByDelta.set(d, [i]);
  });

  for (const [delta, idxs] of movesByDelta) {
    if (idxs.length < MIN_CASCADE_MEMBERS) continue;
    const ranked = idxs
      .map((i) => ({ i, rank: nextRank.get((events[i] as { nodeId: string }).nodeId) ?? -1 }))
      .filter((m) => m.rank >= 0)
      .sort((a, b) => a.rank - b.rank);
    if (ranked.length < MIN_CASCADE_MEMBERS) continue;

    // A shared delta does not imply a shared cause: two separate insertions in
    // different parts of a document both push everything after them one page
    // down. Split the bucket into contiguous document runs and judge each on
    // its own, so a genuine two-region regression reports as two findings
    // rather than one false "everything shifted" line.
    const movedIds = new Set(ranked.map((m) => (events[m.i] as { nodeId: string }).nodeId));
    for (const run of contiguousRuns(ranked, nextNodes, nextRank, eventIdxByNextId, repeated, movedIds)) {
      if (run.length < MIN_CASCADE_MEMBERS) continue;
      const cause = nearestPrecedingCause(groups, events, rankInNext, run[0]!.rank, pageCountIdx);
      if (cause == null) continue; // No root -> no group. "These moved, cause unknown" helps nobody.
      const id = open(
        'page-shift-cascade',
        run[0]!.i,
        cascadeSummary(run.length, delta, run.map((m) => m.i), events, cause),
      );
      for (const m of run) attach(id, m.i);
    }
  }

  // ── Rule 2b — on-page shift cascade ────────────────────────────────────────
  // Same phenomenon as Rule 2 with a page delta of zero: content grows
  // mid-page and everything after it slides down (or shrinks and slides up)
  // WITHOUT crossing a page boundary. These are `element-moved` events (new
  // with the same-page-movement work) and without this rule they land as a
  // pile of "moved 30pt on page 1" singles — individually accurate,
  // collectively unreadable, all consequences of one cause.
  {
    const idxs: number[] = [];
    events.forEach((e, i) => {
      if (claim[i] !== -1 || e.type !== 'element-moved') return;
      idxs.push(i);
    });
    if (idxs.length >= MIN_CASCADE_MEMBERS) {
      const ranked = idxs
        .map((i) => ({ i, rank: nextRank.get((events[i] as { nodeId: string }).nodeId) ?? -1 }))
        .filter((m) => m.rank >= 0)
        .sort((a, b) => a.rank - b.rank);
      const movedIds = new Set(ranked.map((m) => (events[m.i] as { nodeId: string }).nodeId));
      for (const run of contiguousRuns(ranked, nextNodes, nextRank, eventIdxByNextId, repeated, movedIds)) {
        if (run.length < MIN_CASCADE_MEMBERS) continue;
        const cause = nearestPrecedingCause(groups, events, rankInNext, run[0]!.rank, pageCountIdx);
        if (cause == null) continue;
        const id = open(
          'on-page-shift-cascade',
          run[0]!.i,
          onPageCascadeSummary(run.map((m) => m.i), events, cause),
        );
        for (const m of run) attach(id, m.i);
      }
    }
  }

  // ── Everything else stays exactly as the diff reported it ──────────────────
  for (let i = 0; i < events.length; i++) {
    if (claim[i] === -1) open('single', i, events[i]!.message);
  }

  return finalize(groups, events);
}

/**
 * Enforce the hard severity invariant, then order for reading.
 *
 * A group never contains an event more severe than its root. An overflow error
 * riding along on an added table cell, or a heading break sitting inside a
 * shifted run, is ejected to its own top-level row rather than being quietly
 * demoted into a warn-level summary. Severity has to mean the same thing
 * everywhere or the gate stops meaning anything.
 */
function finalize(raw: RawGroup[], events: SemanticEvent[]): EventGroup[] {
  // `at` is the root's index in the original event list; it orders groups within
  // a severity band so output follows the order the diff engine reported.
  const built: { at: number; group: EventGroup }[] = [];
  for (const g of raw) {
    const root = events[g.rootIdx]!;
    const kept: number[] = [];
    for (const idx of g.members) {
      if (idx !== g.rootIdx && RANK[events[idx]!.severity] > RANK[root.severity]) {
        const ejected = events[idx]!;
        built.push({
          at: idx,
          group: { kind: 'single', root: ejected, severity: ejected.severity, summary: ejected.message, events: [ejected] },
        });
        continue;
      }
      kept.push(idx);
    }
    kept.sort((a, b) => (a === g.rootIdx ? -1 : b === g.rootIdx ? 1 : a - b));
    // A group that lost everything but its root is just that event again.
    const kind = kept.length === 1 ? 'single' : g.kind;
    built.push({
      at: g.rootIdx,
      group: {
        kind,
        root,
        severity: root.severity,
        summary: kind === 'single' ? root.message : g.summary,
        events: kept.map((i) => events[i]!),
      },
    });
  }
  built.sort((a, b) => RANK[b.group.severity] - RANK[a.group.severity] || a.at - b.at);
  return built.map((b) => b.group);
}

// ── Rule 4 helpers ──────────────────────────────────────────────────────────

/**
 * A removed node and an added node are the *same slot* when they share a role,
 * their parents correspond, and they sit at the same ordinal among their
 * parent's same-role children.
 *
 * "Correspond" deliberately does not mean the matcher paired the two parents.
 * Layout containers are anonymous — a FormePDF `View` has no text — so they all
 * share the matcher's exact key and pair by global reading-order rank, which
 * shifts wholesale the moment one container is inserted. Anchoring on a matched
 * *child* instead (the "Subtotal" label next to the amount) is stable, because
 * that child has content to match on.
 */
function pairValueChanges(
  events: SemanticEvent[],
  baseById: Map<string, StructuralNode>,
  nextById: Map<string, StructuralNode>,
  baseToNext: Map<string, string>,
): [number, number][] {
  const removed: { idx: number; node: StructuralNode }[] = [];
  const added: { idx: number; node: StructuralNode }[] = [];
  events.forEach((e, i) => {
    if (e.type === 'element-removed') {
      const n = baseById.get(e.nodeId);
      if (n && isTexty(n.role)) removed.push({ idx: i, node: n });
    } else if (e.type === 'element-added') {
      const n = nextById.get(e.nodeId);
      if (n && isTexty(n.role)) added.push({ idx: i, node: n });
    }
  });
  if (removed.length === 0 || added.length === 0) return [];

  const baseSiblings = siblingOrdinals([...baseById.values()]);
  const nextSiblings = siblingOrdinals([...nextById.values()]);
  const parentAnchor = anchorParents(baseById, nextById, baseToNext);

  const taken = new Set<number>();
  const out: [number, number][] = [];
  for (const r of removed) {
    if (r.node.parentId == null) continue;
    const mappedParent = parentAnchor.get(r.node.parentId);
    if (mappedParent == null) continue;
    const match = added.find(
      (a) =>
        !taken.has(a.idx) &&
        a.node.role === r.node.role &&
        a.node.parentId === mappedParent &&
        nextSiblings.get(a.node.id) === baseSiblings.get(r.node.id),
    );
    if (match) {
      taken.add(match.idx);
      out.push([r.idx, match.idx]);
    }
  }
  return out;
}

/**
 * base parent id -> next parent id, inferred from where that parent's *matched
 * children* ended up. Requires an outright winner: a tie means the children
 * disagree about where their parent went, and a guess there is worse than
 * declining to pair.
 */
function anchorParents(
  baseById: Map<string, StructuralNode>,
  nextById: Map<string, StructuralNode>,
  baseToNext: Map<string, string>,
): Map<string, string> {
  const votes = new Map<string, Map<string, number>>();
  for (const [baseId, nextId] of baseToNext) {
    const b = baseById.get(baseId);
    const n = nextById.get(nextId);
    if (!b?.parentId || !n?.parentId) continue;
    let bucket = votes.get(b.parentId);
    if (!bucket) votes.set(b.parentId, (bucket = new Map()));
    bucket.set(n.parentId, (bucket.get(n.parentId) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [baseParent, bucket] of votes) {
    const ranked = [...bucket].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 1 || ranked[0]![1] > ranked[1]![1]) out.set(baseParent, ranked[0]![0]);
  }
  return out;
}

function siblingOrdinals(nodes: StructuralNode[]): Map<string, number> {
  const byParent = new Map<string, StructuralNode[]>();
  for (const n of nodes) {
    const key = `${n.parentId ?? ''}|${n.role}`;
    const bucket = byParent.get(key);
    if (bucket) bucket.push(n);
    else byParent.set(key, [n]);
  }
  const out = new Map<string, number>();
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => a.pageIndex - b.pageIndex || a.order - b.order);
    bucket.forEach((n, i) => out.set(n.id, i));
  }
  return out;
}

// ── Rule 3 helpers ──────────────────────────────────────────────────────────

/** normTexts appearing on two or more pages — the running header/footer signature. */
function repeatedNormTexts(nodes: StructuralNode[]): Set<string> {
  const pages = new Map<string, Set<number>>();
  for (const n of nodes) {
    if (n.normText == null) continue;
    const seen = pages.get(n.normText);
    if (seen) seen.add(n.pageIndex);
    else pages.set(n.normText, new Set([n.pageIndex]));
  }
  const out = new Set<string>();
  for (const [text, seen] of pages) if (seen.size >= 2) out.add(text);
  return out;
}

/**
 * Nodes added (or removed) whose parent was not itself added (or removed) — the
 * tops of the subtrees that appeared or vanished wholesale.
 */
function subtreeRoots(
  type: 'element-added' | 'element-removed',
  events: SemanticEvent[],
  claim: number[],
  index: Map<string, StructuralNode>,
  eventIdx: Map<string, number>,
): { idx: number; node: StructuralNode }[] {
  const isSameChange = (id: string): boolean => {
    const idx = eventIdx.get(id);
    return idx != null && events[idx]!.type === type;
  };
  const out: { idx: number; node: StructuralNode }[] = [];
  events.forEach((e, i) => {
    if (claim[i] !== -1 || e.type !== type) return;
    const node = index.get(e.nodeId);
    if (!node) return;
    if (node.parentId != null && isSameChange(node.parentId)) return;
    out.push({ idx: i, node });
  });
  return out;
}

function collectSubtree(root: StructuralNode, nodes: StructuralNode[]): StructuralNode[] {
  const children = new Map<string, StructuralNode[]>();
  for (const n of nodes) {
    if (n.parentId == null) continue;
    const bucket = children.get(n.parentId);
    if (bucket) bucket.push(n);
    else children.set(n.parentId, [n]);
  }
  const out: StructuralNode[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    out.push(n);
    for (const c of children.get(n.id) ?? []) stack.push(c);
  }
  return out;
}

function furnitureSummary(pageCount: SemanticEvent, extra: number): string {
  if (pageCount.type !== 'page-count-changed') return pageCount.message;
  const shed = pageCount.to < pageCount.from;
  const pages = Math.abs(pageCount.to - pageCount.from);
  const noun = `repeated header/footer element${extra === 1 ? '' : 's'}`;
  const where = `${shed ? 'removed' : 'new'} page${pages === 1 ? '' : 's'}`;
  return `${pageCount.message} (${shed ? '-' : '+'}${extra} ${noun} on the ${where})`;
}

// ── Rule 1 helpers ──────────────────────────────────────────────────────────

/** Point tolerance for "same horizontal band" / "same top edge". */
const SAME_BAND_PTS = 2;

/**
 * Within one snapshot, map every table fragment that is a continuation of an
 * earlier one to the *head* of its chain. A table crossing a page break is
 * reported by the extractor as two whole tables, so without this a table that
 * wraps reads as two findings and the row counts in the headline are taken from
 * one fragment instead of all of them.
 *
 * The evidence is structural, and deliberately so. This used to run only when
 * the page count changed, on the reasoning that a table can only have started
 * wrapping if the document grew — but whether a table wraps and whether the
 * document gained a page are independent facts. Raise a cell's padding enough to
 * push the last rows onto a page that already existed and the page count never
 * moves, yet a fresh fragment appears; the diff then announced "table added" for
 * rows that had merely flowed over.
 *
 * So a fragment continues its predecessor when all four agree, which no pair of
 * genuinely distinct tables satisfies by accident:
 *
 *  - it sits on the very next page (a table cannot resume two pages later);
 *  - the column count matches (a split preserves the columns);
 *  - it occupies the same horizontal band, to the point;
 *  - nothing else on its page starts above it, since a continuation can only
 *    begin at the top of the content area. Repeated furniture is exempt: a
 *    running header is page-anchored and sits above everything by construction.
 *
 * Pairing is not consulted. It is a property of the *diff*, not of this
 * snapshot's structure, and asking it here is what tied the rule's behaviour to
 * the direction of the change in the first place.
 */
function continuationAnchors(
  nodes: StructuralNode[],
  rank: Map<string, number>,
  repeated: Set<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  const tables = nodes
    .filter((n) => n.role === 'table')
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  if (tables.length < 2) return out;

  const byPage = new Map<number, StructuralNode[]>();
  for (const n of nodes) {
    const bucket = byPage.get(n.pageIndex);
    if (bucket) bucket.push(n);
    else byPage.set(n.pageIndex, [n]);
  }
  // Descendants share the fragment's top edge or sit below it, so they never
  // trip this; only genuine preceding content does.
  const startsPage = (t: StructuralNode): boolean =>
    !(byPage.get(t.pageIndex) ?? []).some(
      (n) =>
        n.bbox.y < t.bbox.y - SAME_BAND_PTS &&
        !(n.normText != null && repeated.has(n.normText)),
    );

  let head: StructuralNode | null = null;
  let tail: StructuralNode | null = null;
  for (const t of tables) {
    if (tail != null && continuesFrom(tail, t) && startsPage(t)) {
      out.set(t.id, head!.id);
      tail = t;
      continue;
    }
    head = t;
    tail = t;
  }
  return out;
}

/** The geometric half of the continuation test: same columns, same band, next page. */
function continuesFrom(prev: StructuralNode, cand: StructuralNode): boolean {
  return (
    cand.pageIndex === prev.pageIndex + 1 &&
    cand.table?.cols != null &&
    cand.table.cols === prev.table?.cols &&
    Math.abs(cand.bbox.x - prev.bbox.x) <= SAME_BAND_PTS &&
    Math.abs(cand.bbox.width - prev.bbox.width) <= SAME_BAND_PTS
  );
}

/**
 * The canonical key of the logical table this add/remove belongs to, or null.
 *
 * The key is side-prefixed (`next:<id>` / `base:<id>`) because a table only
 * present in the baseline has no new-snapshot id to be named by, and forcing one
 * is what made deletions ungroupable: every descendant of a vanished fragment
 * failed its `baseToNext` lookup and fell out as a loose row.
 */
function owningTable(e: SemanticEvent, t: TableCtx): string | null {
  const fromBase = e.type === 'element-removed';
  const index = fromBase ? t.baseById : t.nextById;
  const cont = fromBase ? t.contBase : t.contNext;
  const node = 'nodeId' in e ? index.get(e.nodeId) : undefined;
  if (!node) return null;

  let table: StructuralNode | undefined;
  if (node.role === 'table') {
    // A table's own add/remove groups only when it is a continuation fragment of
    // a table that survived; otherwise it is a finding in its own right.
    const anchor = cont.get(node.id);
    if (anchor == null) return null;
    table = index.get(anchor);
  } else {
    if (!TABLE_PARTS.has(node.role)) return null;
    let cur: StructuralNode | undefined = node;
    while (cur?.parentId != null) {
      const parent: StructuralNode | undefined = index.get(cur.parentId);
      if (!parent) return null;
      if (parent.role === 'table') {
        table = parent;
        break;
      }
      cur = parent;
    }
  }
  if (!table) return null;

  // Rows and cells under a continuation fragment belong to its anchor table.
  // Name the chain from the new snapshot wherever it exists there, so a removal
  // and an addition on the same table land under one key; a table present only
  // in the baseline keeps a `base:` key rather than being forced into an id it
  // does not have, which is what once made deletions ungroupable.
  const anchorId = cont.get(table.id) ?? table.id;
  if (!fromBase) return `next:${anchorId}`;
  const asNext = t.baseToNext.get(anchorId);
  return asNext != null ? `next:${asNext}` : `base:${anchorId}`;
}

function splitKey(key: string): { side: 'base' | 'next'; id: string } {
  const at = key.indexOf(':');
  return { side: key.slice(0, at) as 'base' | 'next', id: key.slice(at + 1) };
}

/**
 * The event index that heads this table's group: the earliest event reported
 * against any fragment of the chain, on either side. Looking only at the anchor
 * misses the common case — when a table starts wrapping, the anchor fragment is
 * unremarkable and it is the newly-appeared fragment that carries the event.
 */
function tableRootIdx(key: string, t: TableCtx): number | undefined {
  const { side, id } = splitKey(key);
  const baseAnchor = side === 'base' ? id : t.nextToBase.get(id);
  const nextAnchor = side === 'next' ? id : t.baseToNext.get(id);
  const candidates: number[] = [];
  for (const f of fragmentsOf(baseAnchor, t.baseById, t.contBase)) {
    const idx = t.eventIdxByBaseId.get(f.id);
    if (idx != null) candidates.push(idx);
  }
  for (const f of fragmentsOf(nextAnchor, t.nextById, t.contNext)) {
    const idx = t.eventIdxByNextId.get(f.id);
    if (idx != null) candidates.push(idx);
  }
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

/** The anchor fragment plus every continuation fragment that points at it. */
function fragmentsOf(
  anchorId: string | undefined,
  index: Map<string, StructuralNode>,
  cont: Map<string, string>,
): StructuralNode[] {
  if (anchorId == null) return [];
  const anchor = index.get(anchorId);
  const out = anchor ? [anchor] : [];
  for (const [id, a] of cont) {
    if (a !== anchorId) continue;
    const n = index.get(id);
    if (n) out.push(n);
  }
  return out.sort((a, b) => a.pageIndex - b.pageIndex || a.order - b.order);
}

/**
 * The table's before/after shape is read from the *structure* — every fragment
 * on each side — rather than from the group's member events. Scanning members
 * only ever sees the fragments that changed, so on a shrink it would miss the
 * baseline's continuation fragment entirely and report a 21-row table as a
 * 9-row one. Row and cell counts still come from the members, so the numbers in
 * the headline always agree with what is inside the group.
 */
function tableSummary(
  key: string,
  t: TableCtx,
  members: number[],
  events: SemanticEvent[],
): { summary: string; label: string } {
  const { side, id } = splitKey(key);
  const baseFrags = fragmentsOf(side === 'base' ? id : t.nextToBase.get(id), t.baseById, t.contBase);
  const nextFrags = fragmentsOf(side === 'next' ? id : t.baseToNext.get(id), t.nextById, t.contNext);

  let rows = 0;
  let cells = 0;
  let repositioned = 0;
  for (const m of members) {
    const e = events[m]!;
    if (!('nodeId' in e)) continue;
    if (e.type === 'element-moved' || e.type === 'element-resized') {
      // Repositioned, not added — counting it with sign +1 would inflate
      // the growth figure by every cell the new column pushed sideways.
      repositioned++;
      continue;
    }
    const removed = e.type === 'element-removed';
    const n = (removed ? t.baseById : t.nextById).get(e.nodeId);
    if (!n) continue;
    const sign = removed ? -1 : 1;
    if (n.role === 'row') rows += sign;
    else if (n.role === 'cell') cells += sign;
  }
  const delta = [
    rows !== 0 ? `${rows > 0 ? '+' : ''}${rows} row${Math.abs(rows) === 1 ? '' : 's'}` : null,
    cells !== 0 ? `${cells > 0 ? '+' : ''}${cells} cell${Math.abs(cells) === 1 ? '' : 's'}` : null,
    repositioned > 0 ? `${repositioned} repositioned` : null,
  ]
    .filter(Boolean)
    .join(', ');

  if (baseFrags.length === 0) {
    return { summary: `table added (${dims(nextFrags)})${delta ? `, ${delta}` : ''}`, label: 'the new table' };
  }
  if (nextFrags.length === 0) {
    return { summary: `table removed (${dims(baseFrags)})${delta ? `, ${delta}` : ''}`, label: 'the removed table' };
  }

  const before = totalRows(baseFrags);
  const after = totalRows(nextFrags);
  const verb = after < before ? 'shrank' : after > before ? 'grew' : 'changed';
  const pages = [...new Set(nextFrags.map((f) => f.pageIndex + 1))].sort((a, b) => a - b);
  const span = pages.length > 1 ? `, now spans pages ${pages[0]}–${pages[pages.length - 1]}` : '';
  return {
    summary: `table ${verb}${delta ? ` ${delta}` : ''} (${dims(baseFrags)} → ${dims(nextFrags)})${span}`,
    label: verb === 'shrank' ? 'the table shrinking' : "the table's growth",
  };
}

function totalRows(frags: StructuralNode[]): number {
  return frags.reduce((s, f) => s + (f.table?.rows ?? 0), 0);
}

function dims(frags: StructuralNode[]): string {
  return `${totalRows(frags)}×${frags[0]?.table?.cols ?? '?'}`;
}

// ── Rule 2 helpers ──────────────────────────────────────────────────────────

/**
 * The nearest group root that precedes the whole run in document order — this
 * is what turns "23 things moved" into "23 things moved *because of this*".
 * `page-count-changed` has no position, so it is the last-resort cause.
 */
function nearestPrecedingCause(
  groups: RawGroup[],
  events: SemanticEvent[],
  rankInNext: (nodeId: string) => number | null,
  firstMemberRank: number,
  pageCountIdx: number,
): { summary: string; label?: string } | null {
  let best: { summary: string; label?: string } | null = null;
  let bestRank = -Infinity;
  for (const g of groups) {
    // A cascade is an effect, never a cause; citing one would produce "N moved
    // following M moved following the real thing". A value change swaps one
    // string for another in place, so it cannot push content across a page
    // boundary and is never the reason a page shifted either.
    if (g.kind === 'page-shift-cascade' || g.kind === 'value-changed') continue;
    const root = events[g.rootIdx]!;
    if (!('nodeId' in root)) continue;
    const rank = rankInNext(root.nodeId);
    if (rank == null || rank >= firstMemberRank) continue;
    if (rank > bestRank) {
      bestRank = rank;
      best = { summary: g.summary, label: g.label };
    }
  }
  if (best) return best;
  if (pageCountIdx !== -1) return { summary: events[pageCountIdx]!.message };
  return null;
}

/**
 * Split a same-delta set of moves into maximal runs that are contiguous in
 * document order, tolerating two kinds of gap: a node that is the subject of
 * some other event in this diff, and a repeated fixed element.
 *
 * The second is not a fixture-specific escape hatch. A running header or footer
 * is page-anchored, so it correctly does *not* move when the content around it
 * shifts, and it will therefore break a downstream run at every single page
 * boundary in every document that has one.
 *
 * Anything else in the gap is content that stayed put while its neighbours
 * moved — which is not a cascade, so the run ends there.
 */
function contiguousRuns(
  ranked: { i: number; rank: number }[],
  nextNodes: StructuralNode[],
  nextRank: Map<string, number>,
  eventIdxByNextId: Map<string, number>,
  repeated: Set<string>,
  movedIds: Set<string>,
): { i: number; rank: number }[][] {
  const byRank = new Map<number, StructuralNode>();
  for (const n of nextNodes) {
    const r = nextRank.get(n.id);
    if (r != null) byRank.set(r, n);
  }
  const cache = new Map<string, StructuralNode[]>();
  const subtree = (n: StructuralNode): StructuralNode[] => {
    let s = cache.get(n.id);
    if (!s) cache.set(n.id, (s = collectSubtree(n, nextNodes)));
    return s;
  };

  const bridges = (from: number, to: number): boolean => {
    for (let r = from + 1; r < to; r++) {
      const node = byRank.get(r);
      if (!node) return false;
      if (eventIdxByNextId.has(node.id)) continue; // changed for its own reasons
      const inside = subtree(node);
      // Page-anchored, and so correctly did not move.
      if (inside.some((d) => d.normText != null && repeated.has(d.normText))) continue;
      // An anonymous layout container whose own children are in this very run.
      // Containers have no text to match on, so the matcher pairs them by
      // position and they often end up without a move event even though
      // everything they hold moved. That is a gap in the pairing, not content
      // that stayed behind — the evidence comes from the run itself, so this
      // can never bridge two unrelated regions together.
      if (inside.some((d) => d.id !== node.id && movedIds.has(d.id))) continue;
      return false;
    }
    return true;
  };

  const runs: { i: number; rank: number }[][] = [];
  let current: { i: number; rank: number }[] = [ranked[0]!];
  for (let k = 1; k < ranked.length; k++) {
    if (bridges(ranked[k - 1]!.rank, ranked[k]!.rank)) current.push(ranked[k]!);
    else {
      runs.push(current);
      current = [ranked[k]!];
    }
  }
  runs.push(current);
  return runs;
}

function onPageCascadeSummary(
  idxs: number[],
  events: SemanticEvent[],
  cause: { summary: string; label?: string },
): string {
  let down = 0;
  let up = 0;
  let minD = Infinity;
  let maxD = 0;
  const pages = new Set<number>();
  for (const i of idxs) {
    const e = events[i]!;
    if (e.type !== 'element-moved') continue;
    const dy = e.toBBox.y - e.fromBBox.y;
    if (dy >= 0) down++;
    else up++;
    minD = Math.min(minD, e.distancePts);
    maxD = Math.max(maxD, e.distancePts);
    pages.add(e.pageIndex + 1);
  }
  const dir = down >= up ? 'down' : 'up';
  const span = minD === maxD ? `${maxD}pt` : `${Math.round(minD)}–${Math.round(maxD)}pt`;
  const pageList = [...pages].sort((a, b) => a - b);
  const pageStr = pageList.length === 1 ? `page ${pageList[0]}` : `pages ${pageList[0]}–${pageList[pageList.length - 1]}`;
  return `${idxs.length} elements shifted ${dir} ${span} on ${pageStr} following ${cause.label ?? cause.summary}`;
}

function cascadeSummary(
  count: number,
  delta: number,
  idxs: number[],
  events: SemanticEvent[],
  cause: { summary: string; label?: string },
): string {
  const hops = [
    ...new Set(
      idxs.map((i) => {
        const e = events[i]!;
        return e.type === 'element-moved-to-different-page' ? `${e.fromPage + 1}→${e.toPage + 1}` : '';
      }),
    ),
  ]
    .filter(Boolean)
    .sort();
  const dir = delta > 0 ? `+${delta}` : `${delta}`;
  return `${count} elements shifted ${dir} page${Math.abs(delta) === 1 ? '' : 's'} (${hops.join(', ')}) following ${cause.label ?? cause.summary}`;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function byId(nodes: StructuralNode[]): Map<string, StructuralNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

function readingRank(nodes: StructuralNode[]): Map<string, number> {
  const out = new Map<string, number>();
  [...nodes]
    .sort((a, b) => a.pageIndex - b.pageIndex || a.order - b.order)
    .forEach((n, i) => out.set(n.id, i));
  return out;
}

function isTexty(role: NodeRole): boolean {
  return role === 'text' || role === 'heading';
}
