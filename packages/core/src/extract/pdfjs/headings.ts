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
 * Size ratio to the body baseline at which a run is H1..H5. A size-separated
 * run that clears none of these is H5; a weight-only heading is H6.
 *
 * Levels are ABSOLUTE bands, not ranks among the sizes present. They used to be
 * ranks: the largest size seen was H1, the next H2, and so on. That made every
 * run's level depend on which other sizes the document happened to contain,
 * so adding rows to a table (which changed which runs the table detector
 * consumed, and so which sizes remained in the prose set) re-ranked unrelated
 * text and fired heading-hierarchy-changed at error severity. Extraction-
 * fidelity experiment, 2026-09-09, finding P2. A band depends only on the
 * run's own size and the body size.
 */
const LEVEL_BANDS: ReadonlyArray<readonly [ratio: number, level: number]> = [
  [2.4, 1],
  [1.8, 2],
  [1.5, 3],
  [1.3, 4],
];

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
  const bandOf = (r: PdfTextRun): number => {
    const ratio = bodySize > 0 ? r.fontSize / bodySize : 1;
    for (const [min, level] of LEVEL_BANDS) if (ratio >= min) return level;
    return 5;
  };

  return {
    bodySize,
    isHeading: (r) => sizeSeparated(r) || boldSeparated(r),
    levelOf: (r) => (sizeSeparated(r) ? bandOf(r) : 6),
    confidenceOf: (r) => (sizeSeparated(r) ? 0.8 : 0.5),
  };
}
