import { round1 } from '../../geometry.js';
import { buildHeadingLevelMap } from '../../text/headingLevels.js';
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
 * Infer heading levels for raw pdfjs runs by font-size clustering. The
 * char-count-weighted modal size is the body baseline; runs meaningfully larger
 * (or bold and slightly larger) are headings, ranked into H1..H6. Confidence is
 * 0.8 when a run is size-separated, 0.5 when only weight-distinguished — lower
 * than the FormePDF path, which knows heading roles outright.
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

  const candidateSizes = [
    ...new Set(runs.filter((r) => r.fontSize > bodySize * HEADING_RATIO).map((r) => round1(r.fontSize))),
  ];
  const levelFor = buildHeadingLevelMap(candidateSizes);

  const sizeSeparated = (r: PdfTextRun): boolean => r.fontSize > bodySize * HEADING_RATIO;
  const boldSeparated = (r: PdfTextRun): boolean => r.bold && r.fontSize >= bodySize * BOLD_RATIO;

  return {
    bodySize,
    isHeading: (r) => sizeSeparated(r) || boldSeparated(r),
    levelOf: (r) => (sizeSeparated(r) ? levelFor(round1(r.fontSize)) : 6),
    confidenceOf: (r) => (sizeSeparated(r) ? 0.8 : 0.5),
  };
}
