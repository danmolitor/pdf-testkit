import type { BBox, OverflowInfo } from '../../types.js';
import { round1 } from '../../geometry.js';
import type { PdfTextRun } from './textRuns.js';

/**
 * Content box inferred from the bounding box of a page's text. FormePDF gives a
 * real content box; here we approximate it, so overflow from this path is
 * explicitly best-effort (documented in the reliability matrix).
 */
export function inferContentBox(runs: PdfTextRun[], pageWidth: number, pageHeight: number): BBox {
  if (runs.length === 0) return { x: 0, y: 0, width: pageWidth, height: pageHeight };
  const minX = Math.min(...runs.map((r) => r.x));
  const maxX = Math.max(...runs.map((r) => r.x + r.width));
  const minY = Math.min(...runs.map((r) => r.y));
  const maxY = Math.max(...runs.map((r) => r.y + r.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Conservative overflow detector: flags a run whose right edge extends past the
 * expected (mirror-margin) text column by more than a line's worth. Tuned to
 * under-report rather than cry wolf — a false overflow is exactly the noise this
 * tool exists to avoid.
 */
export function buildOverflowModel(
  runs: PdfTextRun[],
  pageWidth: number,
): (run: PdfTextRun) => OverflowInfo | null {
  if (runs.length === 0) return () => null;
  const leftMargin = Math.min(...runs.map((r) => r.x));
  const rightLimit = pageWidth - leftMargin;
  return (run) => {
    const over = run.x + run.width - rightLimit;
    if (over > Math.max(2, run.fontSize)) {
      return { axis: 'x', overflowPts: round1(over), container: 'page-content' };
    }
    return null;
  };
}
