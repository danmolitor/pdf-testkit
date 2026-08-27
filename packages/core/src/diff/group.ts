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
  | 'table-grew'
  | 'page-shift-cascade'
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
  const nextRank = readingRank(nextNodes);

  // Re-run the matcher rather than threading its result out of `diffSnapshots`:
  // it is deterministic over the same inputs, and grouping needs the *pairing*
  // (which base node became which next node) that the flat event list drops.
  const { pairs } = matchNodes(baseNodes, nextNodes);
  const baseToNext = new Map<string, string>();
  for (const p of pairs) baseToNext.set(p.base.id, p.next.id);

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

  /** -1 = unclaimed. Otherwise the index of the group this event belongs to. */
  const claim: number[] = new Array(events.length).fill(-1);
  const groups: { kind: GroupKind; rootIdx: number; members: number[]; summary: string }[] = [];

  const open = (kind: GroupKind, rootIdx: number, summary: string): number => {
    const id = groups.length;
    groups.push({ kind, rootIdx, members: [rootIdx], summary });
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

  // ── Rule 3 — new-page furniture ────────────────────────────────────────────
  // A page that did not exist in the baseline brings a fresh copy of every
  // repeated fixed element with it. Those adds are a restatement of
  // `page-count-changed`, not independent findings.
  if (pageCountIdx !== -1) {
    const furniture: number[] = [];
    for (const root of addedSubtreeRoots(events, claim, nextById, eventIdxByNextId)) {
      if (root.node.pageIndex < baseline.pageCount) continue;
      const subtree = collectSubtree(root.node, nextNodes);
      if (!subtree.some((n) => n.normText != null && repeated.has(n.normText))) continue;
      for (const n of subtree) {
        const idx = eventIdxByNextId.get(n.id);
        if (idx != null && claim[idx] === -1) furniture.push(idx);
      }
    }
    if (furniture.length > 0) {
      const id = open('new-page-furniture', pageCountIdx, furnitureSummary(events[pageCountIdx]!, furniture.length));
      for (const idx of furniture) attach(id, idx);
    }
  }

  // ── Rule 1 — table subtree growth ──────────────────────────────────────────
  // Restricted to row/cell/table roles on purpose. "Anything added under a node
  // that changed" would swallow a new paragraph inside a container that merely
  // moved; a row or a cell, by contrast, has no meaning apart from its table.
  // A table that starts spanning pages gains a continuation fragment, which the
  // extractor reports as a whole new table. Resolve those to the fragment that
  // actually paired, so one logical table produces one group rather than two.
  const continuationOf = continuationFragments(events, nextById, eventIdxByNextId, nextRank, pageCountIdx !== -1);

  const tableGroups = new Map<string, number>(); // primary next table id -> group id
  for (let i = 0; i < events.length; i++) {
    if (claim[i] !== -1) continue;
    const e = events[i]!;
    if (e.type !== 'element-added' && e.type !== 'element-removed') continue;

    const owner = owningTable(e, baseById, nextById, baseToNext, eventIdxByNextId, continuationOf);
    if (owner == null) continue;

    let gid = tableGroups.get(owner);
    if (gid == null) {
      const rootIdx = eventIdxByNextId.get(owner);
      if (rootIdx == null || claim[rootIdx] !== -1) continue;
      gid = open('table-grew', rootIdx, '');
      tableGroups.set(owner, gid);
    }
    attach(gid, i);
  }
  for (const [tableId, gid] of tableGroups) {
    groups[gid]!.summary = tableSummary(tableId, baseById, nextById, baseToNext, groups[gid]!.members, events);
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
    for (const run of contiguousRuns(ranked, nextNodes, nextRank, eventIdxByNextId, repeated)) {
      if (run.length < MIN_CASCADE_MEMBERS) continue;
      const cause = nearestPrecedingCause(groups, events, nextRank, run[0]!.rank, pageCountIdx);
      if (cause == null) continue; // No root -> no group. "These moved, cause unknown" helps nobody.
      const id = open(
        'page-shift-cascade',
        run[0]!.i,
        cascadeSummary(run.length, delta, run.map((m) => m.i), events, cause),
      );
      for (const m of run) attach(id, m.i);
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
function finalize(
  raw: { kind: GroupKind; rootIdx: number; members: number[]; summary: string }[],
  events: SemanticEvent[],
): EventGroup[] {
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

/** Added nodes whose parent is not itself added — the tops of added subtrees. */
function addedSubtreeRoots(
  events: SemanticEvent[],
  claim: number[],
  nextById: Map<string, StructuralNode>,
  eventIdxByNextId: Map<string, number>,
): { idx: number; node: StructuralNode }[] {
  const isAdded = (id: string): boolean => {
    const idx = eventIdxByNextId.get(id);
    return idx != null && events[idx]!.type === 'element-added';
  };
  const out: { idx: number; node: StructuralNode }[] = [];
  events.forEach((e, i) => {
    if (claim[i] !== -1 || e.type !== 'element-added') return;
    const node = nextById.get(e.nodeId);
    if (!node) return;
    if (node.parentId != null && isAdded(node.parentId)) return;
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
  const to = pageCount.type === 'page-count-changed' ? pageCount.to : 0;
  return `${pageCount.message} (+${extra} repeated header/footer element${extra === 1 ? '' : 's'} on the new page${to > 0 ? '' : 's'})`;
}

// ── Rule 1 helpers ──────────────────────────────────────────────────────────

/**
 * Map each *added* table node to the table fragment that already paired. Only
 * applies when the page count grew: absent that, a new table really is a new
 * table and deserves its own top-level event.
 */
function continuationFragments(
  events: SemanticEvent[],
  nextById: Map<string, StructuralNode>,
  eventIdxByNextId: Map<string, number>,
  nextRank: Map<string, number>,
  pageCountGrew: boolean,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!pageCountGrew) return out;

  const eventTypeOf = (id: string): string | undefined => {
    const i = eventIdxByNextId.get(id);
    return i == null ? undefined : events[i]!.type;
  };
  // The primary is the earliest table carrying a non-additive event, i.e. one
  // the matcher recognised as the same table as in the baseline.
  let primary: string | null = null;
  for (const [id, n] of nextById) {
    if (n.role !== 'table') continue;
    const type = eventTypeOf(id);
    if (type == null || type === 'element-added') continue;
    if (primary == null || (nextRank.get(id) ?? 0) < (nextRank.get(primary) ?? 0)) primary = id;
  }
  if (primary == null) return out;

  for (const [id, n] of nextById) {
    if (n.role === 'table' && id !== primary && eventTypeOf(id) === 'element-added') out.set(id, primary);
  }
  return out;
}

/** The primary next-snapshot table id that owns this add/remove, or null. */
function owningTable(
  e: SemanticEvent,
  baseById: Map<string, StructuralNode>,
  nextById: Map<string, StructuralNode>,
  baseToNext: Map<string, string>,
  eventIdxByNextId: Map<string, number>,
  continuationOf: Map<string, string>,
): string | null {
  const fromBase = e.type === 'element-removed';
  const idx = fromBase ? baseById : nextById;
  const node = 'nodeId' in e ? idx.get(e.nodeId) : undefined;
  if (!node) return null;

  if (node.role === 'table') return fromBase ? null : (continuationOf.get(node.id) ?? null);
  if (!TABLE_PARTS.has(node.role)) return null;

  let cur: StructuralNode | undefined = node;
  while (cur?.parentId != null) {
    const parent: StructuralNode | undefined = idx.get(cur.parentId);
    if (!parent) return null;
    if (parent.role === 'table') {
      const nextId = fromBase ? baseToNext.get(parent.id) : parent.id;
      if (nextId == null) return null;
      // Rows and cells under a continuation fragment belong to the same table.
      const primary = continuationOf.get(nextId) ?? nextId;
      return eventIdxByNextId.has(primary) ? primary : null;
    }
    cur = parent;
  }
  return null;
}

function tableSummary(
  tableId: string,
  baseById: Map<string, StructuralNode>,
  nextById: Map<string, StructuralNode>,
  baseToNext: Map<string, string>,
  members: number[],
  events: SemanticEvent[],
): string {
  let baseTable: StructuralNode | undefined;
  for (const [baseId, nextId] of baseToNext) {
    if (nextId === tableId) baseTable = baseById.get(baseId);
  }
  // Every table fragment in the group, including the paired one.
  const fragments = [nextById.get(tableId)].filter(Boolean) as StructuralNode[];
  let rows = 0;
  let cells = 0;
  for (const m of members) {
    const e = events[m]!;
    if (!('nodeId' in e)) continue;
    const removed = e.type === 'element-removed';
    const n = (removed ? baseById : nextById).get(e.nodeId);
    if (!n) continue;
    const sign = removed ? -1 : 1;
    if (n.role === 'row') rows += sign;
    else if (n.role === 'cell') cells += sign;
    // Only added tables: the group's own root is the primary fragment, already
    // seeded above, and counting it twice doubles the reported row total.
    else if (n.role === 'table' && e.type === 'element-added') fragments.push(n);
  }
  const pages = [...new Set(fragments.map((f) => f.pageIndex + 1))].sort((a, b) => a - b);
  const shape = baseTable?.table
    ? `${baseTable.table.rows}×${baseTable.table.cols} → ${fragments.reduce((s, f) => s + (f.table?.rows ?? 0), 0)}×${fragments[0]?.table?.cols ?? '?'}`
    : 'table';
  const delta = [
    rows !== 0 ? `${rows > 0 ? '+' : ''}${rows} row${Math.abs(rows) === 1 ? '' : 's'}` : null,
    cells !== 0 ? `${cells > 0 ? '+' : ''}${cells} cell${Math.abs(cells) === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const span = pages.length > 1 ? `, now spans pages ${pages[0]}–${pages[pages.length - 1]}` : '';
  return `table ${rows < 0 ? 'shrank' : 'grew'} ${delta} (${shape})${span}`;
}

// ── Rule 2 helpers ──────────────────────────────────────────────────────────

/**
 * The nearest group root that precedes the whole run in document order — this
 * is what turns "23 things moved" into "23 things moved *because of this*".
 * `page-count-changed` has no position, so it is the last-resort cause.
 */
function nearestPrecedingCause(
  groups: { kind: GroupKind; rootIdx: number; members: number[]; summary: string }[],
  events: SemanticEvent[],
  nextRank: Map<string, number>,
  firstMemberRank: number,
  pageCountIdx: number,
): { kind: GroupKind; summary: string } | null {
  let best: { kind: GroupKind; summary: string } | null = null;
  let bestRank = -1;
  for (const g of groups) {
    // A cascade is an effect, never a cause; citing one would produce
    // "N moved following M moved following the real thing".
    if (g.kind === 'page-shift-cascade') continue;
    const root = events[g.rootIdx]!;
    if (!('nodeId' in root)) continue;
    const rank = nextRank.get(root.nodeId);
    if (rank == null || rank >= firstMemberRank) continue;
    if (rank > bestRank) {
      bestRank = rank;
      best = { kind: g.kind, summary: g.summary };
    }
  }
  if (best) return best;
  if (pageCountIdx !== -1) return { kind: 'single', summary: events[pageCountIdx]!.message };
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
): { i: number; rank: number }[][] {
  const byRank = new Map<number, StructuralNode>();
  for (const n of nextNodes) {
    const r = nextRank.get(n.id);
    if (r != null) byRank.set(r, n);
  }
  const isFurniture = (n: StructuralNode): boolean =>
    collectSubtree(n, nextNodes).some((d) => d.normText != null && repeated.has(d.normText));

  const bridges = (from: number, to: number): boolean => {
    for (let r = from + 1; r < to; r++) {
      const node = byRank.get(r);
      if (!node) return false;
      if (eventIdxByNextId.has(node.id)) continue; // changed for its own reasons
      if (isFurniture(node)) continue; // page-anchored, correctly did not move
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

function cascadeSummary(
  count: number,
  delta: number,
  idxs: number[],
  events: SemanticEvent[],
  cause: { kind: GroupKind; summary: string },
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
  const label =
    cause.kind === 'table-grew'
      ? "the table's growth"
      : cause.kind === 'new-page-furniture'
        ? 'the page-count change'
        : cause.summary;
  return `${count} elements shifted ${dir} page${Math.abs(delta) === 1 ? '' : 's'} (${hops.join(', ')}) following ${label}`;
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
