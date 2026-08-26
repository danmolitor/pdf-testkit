import { describe, it, expect } from 'vitest';
import { fromFormeLayout } from '@pdf-testkit/core';
import { sampleLayout } from './helpers';

describe('fromFormeLayout (authoritative extractor)', () => {
  const snap = fromFormeLayout(sampleLayout(), { createdAt: '2026-01-01T00:00:00.000Z' });

  it('captures a single page', () => {
    expect(snap.pageCount).toBe(1);
    expect(snap.producer).toBe('formepdf');
  });

  it('assigns heading levels by descending font size (24pt -> H1, 18pt -> H2)', () => {
    const headings = snap.nodes.filter((n) => n.role === 'heading');
    expect(headings).toHaveLength(2);
    const byText = Object.fromEntries(headings.map((h) => [h.text, h.headingLevel]));
    expect(byText['Quarterly Results']).toBe(1);
    expect(byText['Revenue']).toBe(2);
  });

  it('detects the table shape (2 rows x 3 cols)', () => {
    const table = snap.nodes.find((n) => n.role === 'table');
    expect(table?.table).toEqual({ rows: 2, cols: 3 });
    expect(snap.nodes.filter((n) => n.role === 'row')).toHaveLength(2);
    expect(snap.nodes.filter((n) => n.role === 'cell')).toHaveLength(6);
  });

  it('flags the long line as overflowing the content box on the x axis', () => {
    const overflowed = snap.nodes.filter((n) => n.overflow);
    expect(overflowed.length).toBeGreaterThanOrEqual(1);
    expect(overflowed.every((n) => n.overflow?.axis === 'x')).toBe(true);
    expect(overflowed[0]!.overflow?.container).toBe('page-content');
  });

  it('marks every node authoritative (confidence 1)', () => {
    expect(snap.nodes.every((n) => n.confidence === 1)).toBe(true);
  });

  it('links cells to rows to the table via parentId', () => {
    const table = snap.nodes.find((n) => n.role === 'table')!;
    const rows = snap.nodes.filter((n) => n.role === 'row');
    expect(rows.every((r) => r.parentId === table.id)).toBe(true);
    const cells = snap.nodes.filter((n) => n.role === 'cell');
    const rowIds = new Set(rows.map((r) => r.id));
    expect(cells.every((c) => c.parentId != null && rowIds.has(c.parentId))).toBe(true);
  });
});
