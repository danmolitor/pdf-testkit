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

  // Stage 1 — exact stable key (role + normText + headingLevel). Within a
  // key, two passes:
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
  for (const [key, baseBucket] of baseByKey) {
    const nextBucket = nextByKey.get(key);
    if (!nextBucket || nextBucket.length === 0) continue;

    // Pass 1a — same page, same slot.
    for (const base of [...baseBucket]) {
      let best: StructuralNode | null = null;
      let bestD = POSITION_MATCH_TOL;
      for (const cand of nextBucket) {
        if (cand.pageIndex !== base.pageIndex) continue;
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
        baseBucket.splice(baseBucket.indexOf(base), 1);
        nextBucket.splice(nextBucket.indexOf(best), 1);
      }
    }

    // Pass 1b — remaining siblings by (pageIndex, order) rank.
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

  // Stage 3 — structural pairing for tables (and other non-text containers) by
  // role + table signature, nearest in page order.
  for (const base of [...baseLeft]) {
    if (isTexty(base)) continue;
    let best: StructuralNode | null = null;
    let bestCost = Infinity;
    for (const cand of nextLeft) {
      if (cand.role !== base.role) continue;
      if (!sameTableShape(base, cand)) continue;
      const cost = Math.abs(cand.pageIndex - base.pageIndex) * 1000 + Math.abs(cand.order - base.order);
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

function exactKey(n: StructuralNode): string {
  return `${n.role}|${n.normText ?? ''}|${n.headingLevel ?? ''}`;
}

function isTexty(n: StructuralNode): boolean {
  return n.role === 'text' || n.role === 'heading';
}

function sameTableShape(a: StructuralNode, b: StructuralNode): boolean {
  if (!a.table || !b.table) return true; // non-tables: shape is irrelevant
  return a.table.rows === b.table.rows && a.table.cols === b.table.cols;
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
