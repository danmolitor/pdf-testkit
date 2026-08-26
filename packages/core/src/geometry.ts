import type { BBox, OverflowInfo } from './types.js';

/** Round to 0.1pt so trivial float noise never creates a diff. */
export function round1(n: number): number {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}

export function roundBBox(b: BBox): BBox {
  return { x: round1(b.x), y: round1(b.y), width: round1(b.width), height: round1(b.height) };
}

/** Center-to-center distance between two boxes (used for on-page move detection). */
export function centerDistance(a: BBox, b: BBox): number {
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

/**
 * Overflow of `node` past `container`, or null if it fits (within `tol`).
 * Considers all four edges; reports the dominant axis and the max overshoot.
 */
export function computeOverflow(
  node: BBox,
  container: BBox,
  kind: OverflowInfo['container'],
  tol = 0.5,
): OverflowInfo | null {
  const overRight = node.x + node.width - (container.x + container.width);
  const overBottom = node.y + node.height - (container.y + container.height);
  const overLeft = container.x - node.x;
  const overTop = container.y - node.y;
  const xOver = Math.max(overRight, overLeft, 0);
  const yOver = Math.max(overBottom, overTop, 0);
  if (xOver <= tol && yOver <= tol) return null;
  const axis = xOver > tol && yOver > tol ? 'both' : xOver > tol ? 'x' : 'y';
  return { axis, overflowPts: round1(Math.max(xOver, yOver)), container: kind };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}
