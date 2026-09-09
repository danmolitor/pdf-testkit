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
 * The stages are ordered from most to least certain so that identical content
 * (stage 1) and minor edits (stage 2) never fall through to remove+add — the
 * phantom-churn failure mode that makes a diff tool noisy.
 */
export function matchNodes(baseNodes: StructuralNode[], nextNodes: StructuralNode[]): MatchResult {
  const baseLeft = new Set(baseNodes);
  const nextLeft = new Set(nextNodes);
  const pairs: NodePair[] = [];
  const baseKey = structuralKeys(baseNodes);
  const nextKey = structuralKeys(nextNodes);
  const exactKey = (n: StructuralNode): string => baseKey.get(n) ?? nextKey.get(n) ?? `${n.role}|${n.normText ?? ''}|${n.headingLevel ?? ''}`;

  // Stage 1 — exact stable key: role + normText + headingLevel for text, and
  // for anonymous structure (containers, rows) the shape of what it holds
  // (see `structuralKeys`). Within a key, two passes:
  //
  //   1a. Same-slot first: a base pairs with the candidate at the same page
  //       and (near-)identical box. When one sibling LEAVES the bucket — a
  //       Text converted to a Heading changes its key, a deletion removes it
  //       outright — the survivors keep their true partners instead of
  //       cascading off-by-one into phantom cross-page "moves". (Surfaced by
  //       the 2026-09 heading retrofit: unchanged siblings on later pages
  //       reported as moved-to-different-page.)
  //   1b. Rank order for the remainder, so identical repeated content that
  //       genuinely shifted (reflow onto another page) still pairs and is
  //       reported as movement rather than remove+add churn.
  const nextByKey = groupBy([...nextLeft], exactKey);
  const baseByKey = groupBy([...baseLeft], exactKey);
  const buckets: [StructuralNode[], StructuralNode[]][] = [];
  for (const [key, baseBucket] of baseByKey) {
    const nextBucket = nextByKey.get(key);
    if (nextBucket && nextBucket.length > 0) buckets.push([baseBucket, nextBucket]);
  }

  // Pass 1a — same page, same slot. Ties on centre distance are broken by
  // size, never by bucket position: a wrapper, the row inside it and the
  // cell inside that can all share one centre (the Northmoor footer), and
  // `d <= bestD` used to hand the wrapper to the cell. (Extraction-fidelity
  // experiment, 2026-09-09, finding F1.)
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
        pairs.push({ base, next: best });
        baseLeft.delete(base);
        nextLeft.delete(best);
        baseBucket.splice(baseBucket.indexOf(base), 1);
        nextBucket.splice(nextBucket.indexOf(best), 1);
      }
    }
  }

  // Pass 1c — same words at the same slot, cell on one side and text (or an
  // inferred heading) on the other. On the pdfjs path a label sits inside an inferred table in one
  // snapshot and outside it in the other (the table detector's membership
  // shifted), so its role flips. It is the same element; without this it
  // was reported removed and added, and the rank pass below would have
  // handed its by-text partner to a different element with the same words.
  // Runs before 1b so a slot beats a rank. Text↔heading is deliberately not
  // here: a text becoming a heading is a change worth reporting, and it is
  // reported as remove + add. (Extraction-fidelity experiment, 2026-09-09,
  // finding P5.)
  for (const base of [...baseLeft]) {
    if (!hasText(base)) continue;
    let best: StructuralNode | null = null;
    let bestD = POSITION_MATCH_TOL;
    for (const cand of nextLeft) {
      if (!hasText(cand) || !cellAndText(base, cand) || cand.pageIndex !== base.pageIndex || cand.normText !== base.normText) continue;
      const d = centerDistance(base.bbox, cand.bbox);
      if (d < bestD) {
        bestD = d;
        best = cand;
      }
    }
    if (best) {
      pairs.push({ base, next: best });
      baseLeft.delete(base);
      nextLeft.delete(best);
      for (const [baseBucket, nextBucket] of buckets) {
        const bi = baseBucket.indexOf(base);
        if (bi >= 0) baseBucket.splice(bi, 1);
        const ni = nextBucket.indexOf(best);
        if (ni >= 0) nextBucket.splice(ni, 1);
      }
    }
  }

  // Pass 1b — remaining siblings by (pageIndex, order) rank.
  for (const [baseBucket, nextBucket] of buckets) {
    for (const base of baseBucket) {
      const next = nextBucket.shift();
      if (!next) break;
      pairs.push({ base, next });
      baseLeft.delete(base);
      nextLeft.delete(next);
    }
  }

  // Stage 2 — fuzzy text for text/heading nodes (a changed number, a typo fix).
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
    if (best) {
      pairs.push({ base, next: best });
      baseLeft.delete(base);
      nextLeft.delete(best);
    }
  }

  // Stage 2.5 — positional fallback for text/heading nodes: same role, same
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
    if (best) {
      pairs.push({ base, next: best });
      baseLeft.delete(base);
      nextLeft.delete(best);
    }
  }

  // Stage 3 — structural pairing for tables (and other non-text containers)
  // nearest in page order. A table whose header changed (so stage 1 missed
  // it) still pairs; shape is a cost, not a gate, since a table that gained
  // a column or fifteen rows is the same table. (Before content signatures,
  // every table shared one stage-1 key and paired by rank regardless of
  // shape; this is no looser than that.)
  for (const base of [...baseLeft]) {
    if (isTexty(base)) continue;
    let best: StructuralNode | null = null;
    let bestCost = Infinity;
    for (const cand of nextLeft) {
      if (cand.role !== base.role) continue;
      const colsApart = base.table && cand.table ? Math.abs(base.table.cols - cand.table.cols) : 0;
      const cost = Math.abs(cand.pageIndex - base.pageIndex) * 1000 + Math.abs(cand.order - base.order) + colsApart * 50;
      if (cost < bestCost) {
        bestCost = cost;
        best = cand;
      }
    }
    if (best) {
      pairs.push({ base, next: best });
      baseLeft.delete(base);
      nextLeft.delete(best);
    }
  }

  return { pairs, added: [...nextLeft], removed: [...baseLeft] };
}

/**
 * Stage-1 keys. Everything with text keys on what it says. A container keys
 * on what it holds, so a wrapper (one container inside) and the cell inside
 * it (one text inside) are never one bucket even when their boxes coincide.
 * Descendant text is included two levels down: it is the identity a reader
 * would give the box ("the page-number cell"). Rows and tables keep the
 * role-only key: a row's identity is its slot in its table, and a table's is
 * handled by its own stage.
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
    else keys.set(n, `${n.role}|${n.normText ?? ''}|${n.headingLevel ?? ''}`);
  }
  return keys;
}

/**
 * A table's identity is its content, not its place in reading order: the
 * column count and the text of its first row (the header, on every path).
 * Two tables that swap places keep their signatures and pair with themselves;
 * a table that grows rows keeps its header and pairs with itself; two tables
 * with the same shape but different headers are never one bucket. Rows
 * without a header text (a headerless grid) fall back to column count alone.
 * (Extraction-fidelity experiment, 2026-09-09, findings F2 and F3.)
 */
function tableSignature(table: StructuralNode, children: Map<string, StructuralNode[]>): string {
  const rows = (children.get(table.id) ?? []).filter((r) => r.role === 'row').sort((a, b) => a.order - b.order);
  const header = rows[0] ? (children.get(rows[0].id) ?? []).filter((c) => c.role === 'cell').sort((a, b) => a.order - b.order).map((c) => c.normText ?? '').filter(Boolean).join('\u0001') : '';
  // The header alone: a table that gained a column keeps its header text
  // apart from the new cell, and the stage-3 fallback (nearest in reading
  // order, any shape) picks that up. Column count is the identity only for
  // a headerless grid.
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

function groupBy(
  items: StructuralNode[],
  key: (item: StructuralNode) => string,
): Map<string, StructuralNode[]> {
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
