import { round1 } from '../../geometry.js';
import type { PdfTextRun } from './textRuns.js';

export interface HeadingModel {
  bodySize: number;
  isHeading(run: PdfTextRun): boolean;
  levelOf(run: PdfTextRun): number;
  confidenceOf(run: PdfTextRun): number;
}

const HEADING_RATIO = 1.15;
const BOLD_RATIO = 1.05;

/**
 * Size ratio to the body baseline that puts a run in a band. Bands, not ranks
 * among the sizes present: levels used to be ranks (the largest size seen was
 * H1, the next H2, and so on), so every run's level depended on which other
 * sizes the document happened to contain, and adding rows to a table (which
 * changed what the table detector consumed, and so which sizes remained in
 * the prose set) re-ranked unrelated text and fired heading-hierarchy-changed
 * at error severity. Extraction-fidelity experiment, 2026-09-09, finding P2.
 *
 * The bands are anchored to the document's largest heading band, which is H1:
 * a document whose only heading is 20pt on a 12pt body has an H1, not an H3,
 * and the levels below keep their band distance from it. A middle tier
 * vanishing (the original failure) moves nothing; only the top heading
 * disappearing would, and a title rarely does.
 */
const BAND_RATIOS: readonly number[] = [2.4, 1.8, 1.5, 1.3];

/**
 * Infer heading levels for raw pdfjs runs by font size. The char-count-weighted
 * modal size is the body baseline; runs meaningfully larger (or bold and
 * slightly larger) are headings, placed into H1..H6 by their ratio to the body
 * size. Confidence is 0.8 when a run is size-separated, 0.5 when only
 * weight-distinguished — lower than the FormePDF path, which knows heading
 * roles outright.
 */
export function buildHeadingModel(runs: PdfTextRun[]): HeadingModel {
  const weightBySize = new Map<number, number>();
  for (const r of runs) {
    const s = round1(r.fontSize);
    weightBySize.set(s, (weightBySize.get(s) ?? 0) + r.charCount);
  }
  let bodySize = 0;
  let bestWeight = -1;
  for (const [size, w] of weightBySize) {
    if (w > bestWeight) {
      bestWeight = w;
      bodySize = size;
    }
  }

  const sizeSeparated = (r: PdfTextRun): boolean => r.fontSize > bodySize * HEADING_RATIO;
  const boldSeparated = (r: PdfTextRun): boolean => r.bold && r.fontSize >= bodySize * BOLD_RATIO;
  // 0 = the largest band … BAND_RATIOS.length = size-separated but below every band.
  const bandOf = (size: number): number => {
    const ratio = bodySize > 0 ? size / bodySize : 1;
    const i = BAND_RATIOS.findIndex((min) => ratio >= min);
    return i === -1 ? BAND_RATIOS.length : i;
  };
  const topBand = runs.filter(sizeSeparated).reduce((top, r) => Math.min(top, bandOf(r.fontSize)), BAND_RATIOS.length);

  return {
    bodySize,
    isHeading: (r) => sizeSeparated(r) || boldSeparated(r),
    levelOf: (r) => (sizeSeparated(r) ? Math.min(1 + bandOf(r.fontSize) - topBand, 5) : 6),
    confidenceOf: (r) => (sizeSeparated(r) ? 0.8 : 0.5),
  };
}
