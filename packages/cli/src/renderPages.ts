import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderPages } from '@pdf-testkit/core';

export interface PageManifestEntry {
  index: number;
  file: string;
  widthPx: number;
  heightPx: number;
  byteSize: number;
  sha256: string;
}

export interface PagesManifest {
  rendererId: string;
  dpi: number;
  format: 'image/webp';
  pages: PageManifestEntry[];
}

/** `page-<index>.webp` — the index is the 0-based page index, as in the snapshot. */
export const pageFileName = (index: number): string => `page-${index}.webp`;

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Render every page of a PDF file into `outDir` and describe what was written. */
export async function renderPagesToDir(
  pdfPath: string,
  outDir: string,
  opts: { dpi?: number; quality?: number } = {},
): Promise<PagesManifest> {
  const bytes = new Uint8Array(await readFile(pdfPath));
  const rendered = await renderPages(bytes, opts);
  await mkdir(outDir, { recursive: true });
  const pages: PageManifestEntry[] = [];
  for (const p of rendered.pages) {
    const file = pageFileName(p.index);
    await writeFile(join(outDir, file), p.bytes);
    pages.push({ index: p.index, file, widthPx: p.widthPx, heightPx: p.heightPx, byteSize: p.bytes.length, sha256: sha256Hex(p.bytes) });
  }
  return { rendererId: rendered.rendererId, dpi: rendered.dpi, format: rendered.format, pages };
}
