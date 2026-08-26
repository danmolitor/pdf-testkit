import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fromFormeLayout } from '../extract/fromFormeLayout.js';
import { fromPdf } from '../extract/fromPdf.js';
import type { StructuralSnapshot } from '../types.js';

/**
 * Resolve a filesystem path to a structural snapshot. Accepts a `.pdf` (parsed
 * via pdfjs), a `.json` StructuralSnapshot (used as-is), or a `.json` FormePDF
 * LayoutInfo (converted). Shared by the CLI and the GitHub Action so both accept
 * PDFs and snapshots interchangeably.
 */
export async function loadSnapshotFromFile(path: string): Promise<StructuralSnapshot> {
  if (extname(path).toLowerCase() === '.json') {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    if (raw && raw['contentHash'] && Array.isArray(raw['nodes'])) {
      return raw as unknown as StructuralSnapshot;
    }
    if (raw && Array.isArray(raw['pages'])) {
      return fromFormeLayout(raw as never, { source: { name: path } });
    }
    throw new Error(`${path}: JSON is neither a StructuralSnapshot nor a FormePDF LayoutInfo`);
  }
  const bytes = new Uint8Array(await readFile(path));
  return fromPdf(bytes, { source: { name: path } });
}
