import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { diffSnapshots, fromPdf } from '@pdf-testkit/core';
import { node, snapshot } from './helpers';

/**
 * Regression (extraction-fidelity experiment, 2026-09-09, finding P5): on the
 * pdfjs path, unchanged labels were reported as removed and added when an
 * inferred table's membership shifted. Swapping the receipt's two tables put
 * the metadata grid ("RECEIVED", "BANK REFERENCE", "Cleveland, OH 44115")
 * inside a phantom 5×5 table in one snapshot and outside it in the other; the
 * role flipped between cell and text, the stage-1 key changed with it, and
 * the same words at the same slot became remove + add churn.
 */
describe('a label that changes role at the same slot is the same element', () => {
  const box = { x: 57, y: 200, width: 60, height: 8 };
  it('cell in one snapshot, text in the other: no add, no remove, no event', () => {
    const base = snapshot([node({ id: '0:cell:0', role: 'cell', parentId: '0:row:0', text: 'RECEIVED', bbox: box, confidence: 0.5 })]);
    const next = snapshot([node({ id: '0:text:0', role: 'text', text: 'RECEIVED', bbox: box, confidence: 0.9 })]);
    const r = diffSnapshots(base, next);
    expect(r.stats.added + r.stats.removed).toBe(0);
    expect(r.events.filter((e) => e.type === 'element-added' || e.type === 'element-removed')).toEqual([]);
  });
});

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/phantom-removals/${name}.pdf`, import.meta.url)));
describe.each(['forme', 'takumi'] as const)('swapping two tables on the receipt — %s output', (producer) => {
  it('reports no label as removed or added: every word survives the swap', async () => {
    const base = await fromPdf(fixture(`${producer}-receipt`));
    const swapped = await fromPdf(fixture(`${producer}-receipt-tables-swapped`));
    const r = diffSnapshots(base, swapped);
    // Text-bearing churn only. The inferred 5×5 table that swallowed the
    // metadata grid loses two anonymous rows when the grid falls out of it;
    // those rows have no words and the table-resized event already states
    // the shape change.
    const churn = r.events.filter((e) => (e.type === 'element-removed' || e.type === 'element-added') && 'textPreview' in e && e.textPreview).map((e) => e.message);
    expect(churn).toEqual([]);
  });
});
