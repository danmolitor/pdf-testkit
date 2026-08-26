import { describe, it, expect } from 'vitest';
import { fromFormeLayout, FormeShapeError, type FormeLayoutInfo } from '@pdf-testkit/core';
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

  it('does not throw on the representative layout', () => {
    expect(() => fromFormeLayout(sampleLayout())).not.toThrow();
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

describe('fromFormeLayout shape guard', () => {
  // Text hidden under an unrecognized node shape — the exact drift class that
  // silently misclassified before. The guard must catch this loudly.
  const drifted: FormeLayoutInfo = {
    pages: [
      {
        width: 595,
        height: 842,
        contentX: 40,
        contentY: 40,
        contentWidth: 520,
        contentHeight: 762,
        elements: [
          // Unrecognized nodeType carrying text directly (real text lives on
          // TextLine children; this simulates that carrier being renamed).
          { nodeType: 'GlyphRun', x: 40, y: 40, width: 200, height: 14, textContent: 'hidden treasure' },
        ],
      },
    ],
  };

  it('throws FormeShapeError when layout text is dropped', () => {
    expect(() => fromFormeLayout(drifted)).toThrow(FormeShapeError);
    expect(() => fromFormeLayout(drifted)).toThrow(/dropped 1\/1 text fragment/);
  });

  it('names the unfamiliar nodeType in the error for debuggability', () => {
    expect(() => fromFormeLayout(drifted)).toThrow(/GlyphRun/);
  });

  it('can be disabled via assertShape: false', () => {
    expect(() => fromFormeLayout(drifted, { assertShape: false })).not.toThrow();
  });

  it('stays quiet on a benign unrecognized container with no dropped text', () => {
    const benign: FormeLayoutInfo = {
      pages: [
        {
          width: 595,
          height: 842,
          contentX: 40,
          contentY: 40,
          contentWidth: 520,
          contentHeight: 762,
          elements: [
            { nodeType: 'FancyChart', x: 40, y: 40, width: 200, height: 100 }, // graphic, no text
            { nodeType: 'Text', x: 40, y: 150, width: 200, height: 14, textContent: 'Caption text' },
          ],
        },
      ],
    };
    expect(() => fromFormeLayout(benign)).not.toThrow();
  });
});
