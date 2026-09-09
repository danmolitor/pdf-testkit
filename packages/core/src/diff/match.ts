import type { StructuralNode } from '../types.js';
import { centerDistance } from '../geometry.js';
import { textSimilarity } from '../text/normalize.js';

export interface NodePair {
  base: StructuralNode;
  next: StructuralNode;
}

export interface MatchResult {
  pairs: NodePair[];
  added: StructuralNode[]; // present in next, unmatched
  removed: StructuralNode[]; // present in base, unmatched
}

const FUZZY_THRESHOLD = 0.85;
/** Boxes closer than this (center-to-center, points) are the same slot. Below a
 * line height, so a deleted paragraph (which shifts others by a full line) never
 * false-matches, while an in-place text edit always does. */
const POSITION_MATCH_TOL = 4;

/**
 * Pair baseline nodes with new-run nodes so the diff engine can tell a *moved*
 * element from a *removed + added* pair. Staged and greedy; each matched node
 * leaves the pool.
 *
 * Tables pair first, on their content (`tableSignature`), so that a row's
 * identity can be its slot within its own matched table rather than its rank
 * among every row in the document. Then everything else, in stages ordered
 * from most to least certain so that identical content (stage 1) and minor
 * edits (stage 2) never fall through to remove+add — the phantom-churn failure
 * mode that makes a diff tool noisy.
 */
export function matchNodes(baseNodes: StructuralNode[], nextNodes: StructuralNode[]): MatchResult {
  const baseLeft = new Set(baseNodes);
  const nextLeft = new Set(nextNodes);
  const pairs: NodePair[] = [];
  const pool = { baseLeft, nextLeft, pairs };

  // ── Phase T — tables, by content ───────────────────────────────────────────
  const baseKeys = structuralKeys(baseNodes);
  const nextKeys = structuralKeys(nextNodes);
  const structuralKey = (n: StructuralNode): string => baseKeys.get(n) ?? nextKeys.get(n) ?? '';
  const tablePairToken = new Map<string, string>(); // `${side}:${tableId}` -> token shared by the pair
  {
    const bT = baseNodes.filter((n) => n.role === 'table');
    const nT = nextNodes.filter((n) => n.role === 'table');
    const before = pairs.length;
    stageOne(pool, bT, nT, structuralKey, { crossRole: false });
    // A table whose header changed (so stage 1 missed it) still pairs, nearest
    // in reading order; shape is a cost, not a gate, since a table that gained
    // a column or fifteen rows is the same table. Before content signatures
    // every table shared one key and paired by rank regardless of shape, so
    // this is no looser than it was.
    for (const base of bT) {
      if (!baseLeft.has(base)) continue;
      let best: StructuralNode | null = null;
      let bestCost = Infinity;
      for (const cand of nT) {
        if (!nextLeft.has(cand)) continue;
        const colsApart = base.table && cand.table ? Math.abs(base.table.cols - cand.table.cols) : 0;
        const cost = Math.abs(cand.pageIndex - base.pageIndex) * 1000 + Math.abs(cand.order - base.order) + colsApart * 50;
        if (cost < bestCost) {
          bestCost = cost;
          best = cand;
        }
      }
      if (best) take(pool, base, best);
    }
    for (let i = before; i < pairs.length; i++) {
      tablePairToken.set(`base:${pairs[i]!.base.id}`, `t${i}`);
      tablePairToken.set(`next:${pairs[i]!.next.id}`, `t${i}`);
    }
  }

  // ── Stage 1 — exact stable key ─────────────────────────────────────────────
  // Text and headings key on what they say; a container on what it holds
  // (`structuralKeys`). A row keys on its matched table, so rows pair by slot
  // and rank within their own table: keyed on the role alone, every row in the
  // document was one bucket, inserting a row in the first table shifted the
  // pairing of every row after it, and the last row of the last table came out
  // "added". A row whose table did not pair keeps a side-specific key and
  // stays unpaired here.
  const rowKey = (n: StructuralNode, side: 'base' | 'next'): string => {
    const token = n.parentId ? tablePairToken.get(`${side}:${n.parentId}`) : undefined;
    return token ? `row|${token}` : `row|${side}:${n.parentId ?? '-'}`;
  };
  // A cell keys on its text WITHIN its matched table: two tables that both
  // carry "4,647.07" must not trade cells when they swap places. A cell whose
  // table did not pair (a continuation fragment of a table that spilled onto
  // a new page) keeps the plain text key, so it can still pair with the cell
  // it was before the reflow.
  // Ids are per snapshot (`0:row:5` names a different row on each side once
  // a row is inserted above it), so each side looks its parents up on its own
  // side only.
  const baseById = new Map(baseNodes.map((n) => [n.id, n] as const));
  const nextById = new Map(nextNodes.map((n) => [n.id, n] as const));
  const cellKey = (n: StructuralNode, side: 'base' | 'next', plain: string): string => {
    const row = n.parentId ? (side === 'base' ? baseById : nextById).get(n.parentId) : undefined;
    const token = row?.parentId ? tablePairToken.get(`${side}:${row.parentId}`) : undefined;
    return token ? `cell|${token}|${n.normText ?? ''}` : plain;
  };
  const stageKey = new Map<StructuralNode, string>();
  for (const n of baseNodes) stageKey.set(n, n.role === 'row' ? rowKey(n, 'base') : n.role === 'cell' ? cellKey(n, 'base', baseKeys.get(n) ?? '') : baseKeys.get(n) ?? '');
  for (const n of nextNodes) stageKey.set(n, n.role === 'row' ? rowKey(n, 'next') : n.role === 'cell' ? cellKey(n, 'next', nextKeys.get(n) ?? '') : nextKeys.get(n) ?? '');
  stageOne(pool, [...baseLeft], [...nextLeft], (n) => stageKey.get(n) ?? '', { crossRole: true });

  // ── Stage 2 — fuzzy text for text/heading nodes (a changed number, a typo fix).
  for (const base of [...baseLeft]) {
    if (!isTexty(base) || base.normText == null) continue;
    let best: StructuralNode | null = null;
    let bestScore = FUZZY_THRESHOLD;
    for (const cand of nextLeft) {
      if (cand.role !== base.role || cand.normText == null) continue;
      const score = textSimilarity(base.normText, cand.normText);
      if (score >= bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    if (best) take(pool, base, best);
  }

  // ── Stage 2.5 — positional fallback for text/heading nodes: same role, same
  // page, and near-identical box is the same element with edited content. This
  // is what stops a small text/punctuation edit from becoming remove+add churn
  // (the fuzzy stage can't catch every rewrite).
  for (const base of [...baseLeft]) {
    if (!isTexty(base)) continue;
    let best: StructuralNode | null = null;
    let bestD = POSITION_MATCH_TOL;
    for (const cand of nextLeft) {
      if (cand.role !== base.role || cand.pageIndex !== base.pageIndex) continue;
      const d = centerDistance(base.bbox, cand.bbox);
      if (d <= bestD) {
        bestD = d;
        best = cand;
      }
    }
    if (best) take(pool, base, best);
  }

  // ── Stage 3 — structural pairing for the remaining anonymous nodes (rows,
  // containers) by role, nearest in page order. Tables were settled in phase T.
  for (const base of [...baseLeft]) {
    if (isTexty(base) || base.role === 'table') continue;
    let best: StructuralNode | null = null;
    let bestCost = Infinity;
    for (const cand of nextLeft) {
      if (cand.role !== base.role) continue;
      const cost = Math.abs(cand.pageIndex - base.pageIndex) * 1000 + Math.abs(cand.order - base.order);
      if (cost < bestCost) {
        bestCost = cost;
        best = cand;
      }
    }
    if (best) take(pool, base, best);
  }

  return { pairs, added: [...nextLeft], removed: [...baseLeft] };
}

interface Pool {
  baseLeft: Set<StructuralNode>;
  nextLeft: Set<StructuralNode>;
  pairs: NodePair[];
}

function take(pool: Pool, base: StructuralNode, next: StructuralNode): void {
  pool.pairs.push({ base, next });
  pool.baseLeft.delete(base);
  pool.nextLeft.delete(next);
}

/**
 * Stage 1 over one set of candidates. Within a key, three passes:
 *
 *   1a. Same-slot first: a base pairs with the candidate at the same page and
 *       (near-)identical box. When one sibling LEAVES the bucket — a Text
 *       converted to a Heading changes its key, a deletion removes it
 *       outright — the survivors keep their true partners instead of
 *       cascading off-by-one into phantom cross-page "moves". Ties on centre
 *       distance are broken by size, never by bucket position: a wrapper, the
 *       row inside it and the cell inside that can all share one centre (the
 *       Northmoor footer), and `d <= bestD` used to hand the wrapper to the
 *       cell. (Extraction-fidelity experiment, 2026-09-09, finding F1.)
 *   1c. Same words at the same slot, cell on one side and text (or an inferred
 *       heading) on the other. On the pdfjs path a label sits inside an
 *       inferred table in one snapshot and outside it in the other (the table
 *       detector's membership shifted), so its role flips. It is the same
 *       element; without this it was reported removed and added, and the rank
 *       pass would have handed its by-text partner to a different element
 *       with the same words. Runs before 1b so a slot beats a rank.
 *       Text↔heading is deliberately not here: a paragraph that became a
 *       heading is a change worth reporting, and stays remove + add.
 *       (Finding P5.)
 *   1b. Rank order for the remainder, so identical repeated content that
 *       genuinely shifted (reflow onto another page) still pairs and is
 *       reported as movement rather than remove+add churn.
 */
function stageOne(
  pool: Pool,
  baseCands: StructuralNode[],
  nextCands: StructuralNode[],
  key: (n: StructuralNode) => string,
  opts: { crossRole: boolean },
): void {
  const nextByKey = groupBy(nextCands.filter((n) => pool.nextLeft.has(n)), key);
  const baseByKey = groupBy(baseCands.filter((n) => pool.baseLeft.has(n)), key);
  const buckets: [StructuralNode[], StructuralNode[]][] = [];
  for (const [k, baseBucket] of baseByKey) {
    const nextBucket = nextByKey.get(k);
    if (nextBucket && nextBucket.length > 0) buckets.push([baseBucket, nextBucket]);
  }

  // Pass 1a.
  for (const [baseBucket, nextBucket] of buckets) {
    for (const base of [...baseBucket]) {
      let best: StructuralNode | null = null;
      let bestD = POSITION_MATCH_TOL;
      let bestSize = Infinity;
      for (const cand of nextBucket) {
        if (cand.pageIndex !== base.pageIndex) continue;
        const d = centerDistance(base.bbox, cand.bbox);
        if (d > bestD) continue;
        const size = Math.abs(cand.bbox.width - base.bbox.width) + Math.abs(cand.bbox.height - base.bbox.height);
        if (d < bestD || size < bestSize) {
          bestD = d;
          bestSize = size;
          best = cand;
        }
      }
      if (best) {
        take(pool, base, best);
        baseBucket.splice(baseBucket.indexOf(base), 1);
        nextBucket.splice(nextBucket.indexOf(best), 1);
      }
    }
  }

  // Pass 1c.
  if (opts.crossRole) {
    for (const base of baseCands) {
      if (!pool.baseLeft.has(base) || !hasText(base)) continue;
      let best: StructuralNode | null = null;
      let bestD = POSITION_MATCH_TOL;
      for (const cand of pool.nextLeft) {
        if (!hasText(cand) || !cellAndText(base, cand) || cand.pageIndex !== base.pageIndex || cand.normText !== base.normText) continue;
        const d = centerDistance(base.bbox, cand.bbox);
        if (d < bestD) {
          bestD = d;
          best = cand;
        }
      }
      if (best) {
        take(pool, base, best);
        for (const [baseBucket, nextBucket] of buckets) {
          const bi = baseBucket.indexOf(base);
          if (bi >= 0) baseBucket.splice(bi, 1);
          const ni = nextBucket.indexOf(best);
          if (ni >= 0) nextBucket.splice(ni, 1);
        }
      }
    }
  }

  // Pass 1b.
  for (const [baseBucket, nextBucket] of buckets) {
    for (const base of baseBucket) {
      const next = nextBucket.shift();
      if (!next) break;
      take(pool, base, next);
    }
  }
}

/**
 * Stage-1 keys for everything but rows (which key on their matched table, see
 * `matchNodes`). Everything with text keys on what it says. A container keys
 * on what it holds, so a wrapper (one container inside) and the cell inside
 * it (one text inside) are never one bucket even when their boxes coincide.
 * Descendant text is included two levels down: it is the identity a reader
 * would give the box ("the page-number cell"). A table keys on its header
 * (`tableSignature`).
 */
function structuralKeys(nodes: StructuralNode[]): Map<StructuralNode, string> {
  const children = new Map<string, StructuralNode[]>();
  for (const n of nodes) {
    if (n.parentId == null) continue;
    const list = children.get(n.parentId);
    if (list) list.push(n);
    else children.set(n.parentId, [n]);
  }
  const keys = new Map<StructuralNode, string>();
  const describe = (n: StructuralNode, depth: number): string => {
    if (n.role === 'text' || n.role === 'heading' || n.role === 'cell') return `${n.role}:${n.normText ?? ''}`;
    const kids = children.get(n.id) ?? [];
    if (depth === 0) return `${n.role}(${kids.length})`;
    return `${n.role}[${kids.map((k) => describe(k, depth - 1)).join(',')}]`;
  };
  for (const n of nodes) {
    if (n.role === 'container') keys.set(n, `container|${describe(n, 2)}`);
    else if (n.role === 'table') keys.set(n, `table|${tableSignature(n, children)}`);
    else if (n.role === 'row') keys.set(n, 'row||');
    else keys.set(n, `${n.role}|${n.normText ?? ''}|${n.headingLevel ?? ''}`);
  }
  return keys;
}

/**
 * A table's identity is its content, not its place in reading order: the text
 * of its first row (the header, on every path), falling back to the column
 * count for a headerless grid. Two tables that swap places keep their
 * signatures and pair with themselves; a table that grows rows keeps its
 * header and pairs with itself; two tables with the same shape but different
 * headers are never one bucket. A table that gained a column keeps its header
 * text apart from the new cell, and the phase-T fallback (nearest in reading
 * order, any shape) picks that up. (Extraction-fidelity experiment,
 * 2026-09-09, findings F2 and F3.)
 */
function tableSignature(table: StructuralNode, children: Map<string, StructuralNode[]>): string {
  const rows = (children.get(table.id) ?? []).filter((r) => r.role === 'row').sort((a, b) => a.order - b.order);
  const header = rows[0]
    ? (children.get(rows[0].id) ?? [])
        .filter((c) => c.role === 'cell')
        .sort((a, b) => a.order - b.order)
        .map((c) => c.normText ?? '')
        .filter(Boolean)
        .join('')
    : '';
  return header ? `h:${header}` : `cols:${table.table?.cols ?? ''}`;
}

function isTexty(n: StructuralNode): boolean {
  return n.role === 'text' || n.role === 'heading';
}

function hasText(n: StructuralNode): boolean {
  return (n.role === 'text' || n.role === 'heading' || n.role === 'cell') && n.normText != null && n.normText !== '';
}

/** One side is a cell, the other is not: the inferred-table membership flip. Text↔heading is excluded on purpose. */
function cellAndText(a: StructuralNode, b: StructuralNode): boolean {
  return a.role !== b.role && (a.role === 'cell' || b.role === 'cell');
}

function byReadingOrder(a: StructuralNode, b: StructuralNode): number {
  return a.pageIndex - b.pageIndex || a.order - b.order;
}

function groupBy(items: StructuralNode[], key: (item: StructuralNode) => string): Map<string, StructuralNode[]> {
  const map = new Map<string, StructuralNode[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  // Keep each bucket in reading order for stable stage-1 pairing.
  for (const bucket of map.values()) bucket.sort(byReadingOrder);
  return map;
}
