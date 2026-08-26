import { round1 } from '../geometry.js';

/**
 * Given the set of font sizes that belong to headings, return a function that
 * maps a font size to a heading level 1..6. Distinct sizes are clustered (0.5pt
 * tolerance) and ranked largest-first: the biggest tier is H1.
 *
 * Both extractors share this. For FormePDF the input is the sizes of nodes
 * already known to be headings; for pdfjs it is the candidate sizes surfaced by
 * font-size clustering.
 */
export function buildHeadingLevelMap(sizes: number[]): (size: number) => number {
  const tiers = clusterTiers(sizes);
  return (size: number): number => {
    if (tiers.length === 0) return 1;
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < tiers.length; i++) {
      const d = Math.abs((tiers[i] as number) - size);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    return Math.min(bestI + 1, 6);
  };
}

/** Descending, de-duplicated size tiers (sizes within 0.5pt collapse to one). */
function clusterTiers(sizes: number[]): number[] {
  const uniq = [...new Set(sizes.map(round1))].sort((a, b) => b - a);
  const tiers: number[] = [];
  for (const s of uniq) {
    const last = tiers[tiers.length - 1];
    if (last !== undefined && Math.abs(last - s) <= 0.5) continue;
    tiers.push(s);
  }
  return tiers;
}
