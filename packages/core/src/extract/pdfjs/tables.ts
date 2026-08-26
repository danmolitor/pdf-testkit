import type { BBox } from '../../types.js';
import { median } from '../../geometry.js';
import type { PdfTextRun } from './textRuns.js';

export interface DetectedCell {
  bbox: BBox;
  text: string;
  runs: PdfTextRun[];
}
export interface DetectedRow {
  bbox: BBox;
  cells: DetectedCell[];
}
export interface DetectedTable {
  bbox: BBox;
  rows: DetectedRow[];
  cols: number;
}

/**
 * The single hardest problem in v0.1: PDF has no native concept of a table, so
 * one is inferred from the geometry of text runs. Heuristic (borderless, text-
 * driven — ruled/border-only tables need operator-list parsing and are deferred):
 *
 *   1. Group runs into row bands by y (tolerance from median line height).
 *   2. Cluster run left-edges across the page into columns.
 *   3. A table = a maximal run of >= 3 consecutive bands that each populate
 *      >= 2 of the same columns.
 *
 * Emits low-confidence regions (callers tag them ~0.5); false positives/negatives
 * are expected on merged/wrapped cells and are managed via `minConfidence`.
 */
export function detectTables(runs: PdfTextRun[]): DetectedTable[] {
  if (runs.length < 6) return [];

  const heights = runs.map((r) => r.height).filter((h) => h > 0);
  const rowTol = Math.max(2, 0.6 * median(heights));
  const bands = groupBands(runs, rowTol);
  if (bands.length < 3) return [];

  const charWidths = runs.map((r) => r.width / Math.max(1, r.text.length)).filter((w) => w > 0);
  const colTol = Math.max(4, (median(charWidths) || median(heights) * 0.5) * 2);
  const columns = clusterValues(
    bands.flatMap((b) => b.map((r) => r.x)),
    colTol,
  );
  const colOf = (x: number): number => nearestIndex(columns, x, colTol);
  const bandCols = bands.map((b) => new Set(b.map((r) => colOf(r.x)).filter((i) => i >= 0)));

  const tables: DetectedTable[] = [];
  let i = 0;
  while (i < bands.length) {
    if (bandCols[i]!.size < 2) {
      i++;
      continue;
    }
    let j = i;
    while (
      j + 1 < bands.length &&
      bandCols[j + 1]!.size >= 2 &&
      intersectionSize(bandCols[i]!, bandCols[j + 1]!) >= 2
    ) {
      j++;
    }
    if (j - i + 1 >= 3) {
      tables.push(buildTable(bands.slice(i, j + 1), columns, colTol));
    }
    i = j + 1;
  }
  return tables;
}

function groupBands(runs: PdfTextRun[], rowTol: number): PdfTextRun[][] {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const bands: PdfTextRun[][] = [];
  let current: PdfTextRun[] = [];
  let bandY = -Infinity;
  for (const r of sorted) {
    if (current.length === 0 || Math.abs(r.y - bandY) <= rowTol) {
      current.push(r);
      bandY = current.length === 1 ? r.y : bandY;
    } else {
      bands.push(current);
      current = [r];
      bandY = r.y;
    }
  }
  if (current.length) bands.push(current);
  return bands.map((b) => b.sort((a, c) => a.x - c.x));
}

function buildTable(bands: PdfTextRun[][], columns: number[], colTol: number): DetectedTable {
  const rows: DetectedRow[] = bands.map((band) => {
    const byCol = new Map<number, PdfTextRun[]>();
    for (const r of band) {
      const c = nearestIndex(columns, r.x, colTol);
      const key = c >= 0 ? c : columns.length + Math.round(r.x);
      const bucket = byCol.get(key);
      if (bucket) bucket.push(r);
      else byCol.set(key, [r]);
    }
    const cells: DetectedCell[] = [...byCol.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, cellRuns]) => ({
        bbox: unionBBox(cellRuns),
        text: cellRuns
          .sort((a, b) => a.x - b.x)
          .map((r) => r.text)
          .join(' ')
          .trim(),
        runs: cellRuns,
      }));
    return { bbox: unionBBox(band), cells };
  });
  const cols = Math.max(0, ...rows.map((r) => r.cells.length));
  return { bbox: unionBBox(bands.flat()), rows, cols };
}

function unionBBox(runs: PdfTextRun[]): BBox {
  const minX = Math.min(...runs.map((r) => r.x));
  const maxX = Math.max(...runs.map((r) => r.x + r.width));
  const minY = Math.min(...runs.map((r) => r.y));
  const maxY = Math.max(...runs.map((r) => r.y + r.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 1-D gap clustering: values within `tol` of the running group join it. */
function clusterValues(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const centers: number[] = [];
  let group: number[] = [];
  for (const v of sorted) {
    const last = group[group.length - 1];
    if (last !== undefined && v - last > tol) {
      centers.push(mean(group));
      group = [];
    }
    group.push(v);
  }
  if (group.length) centers.push(mean(group));
  return centers;
}

function nearestIndex(centers: number[], x: number, tol: number): number {
  let bestI = -1;
  let bestD = tol;
  for (let i = 0; i < centers.length; i++) {
    const d = Math.abs((centers[i] as number) - x);
    if (d <= bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return bestI;
}

function intersectionSize(a: Set<number>, b: Set<number>): number {
  let n = 0;
  for (const v of a) if (b.has(v)) n++;
  return n;
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}
