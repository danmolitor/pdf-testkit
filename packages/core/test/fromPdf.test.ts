import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { fromPdf } from '@pdf-testkit/core';

function fixture(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`../../fixtures/pdfs/${name}.pdf`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

/**
 * The pdfjs path is heuristic; assert counts and roles, not pixel-exact
 * coordinates. Coordinates can shift across pdfjs versions — rounding + position
 * thresholds absorb that, but exact positions are intentionally not asserted.
 */
describe('fromPdf (pdfjs extractor) on real fixtures', () => {
  it('extracts pages, text, and a table region from an invoice', async () => {
    const snap = await fromPdf(fixture('invoice'), { source: { name: 'invoice' } });
    expect(snap.producer).toBe('pdfjs');
    expect(snap.pageCount).toBeGreaterThanOrEqual(1);
    expect(snap.nodes.some((n) => n.role === 'text')).toBe(true);
    expect(snap.nodes.some((n) => n.role === 'table')).toBe(true);
  });

  it('detects headings with levels in a multi-page report', async () => {
    const snap = await fromPdf(fixture('report'));
    const headings = snap.nodes.filter((n) => n.role === 'heading');
    expect(headings.length).toBeGreaterThanOrEqual(1);
    expect(headings.every((h) => h.headingLevel != null && h.headingLevel >= 1)).toBe(true);
  });

  it('marks heuristic nodes with sub-1.0 confidence', async () => {
    const snap = await fromPdf(fixture('invoice'));
    expect(snap.nodes.every((n) => n.confidence <= 1)).toBe(true);
    expect(snap.nodes.some((n) => n.confidence < 1)).toBe(true);
  });

  it('is deterministic — same bytes yield the same content hash', async () => {
    const a = await fromPdf(fixture('catalog'));
    const b = await fromPdf(fixture('catalog'));
    expect(a.contentHash).toBe(b.contentHash);
  });
});
