import { describe, it, expect } from 'vitest';
import { diffSnapshots, groupEvents } from '@pdf-testkit/core';
import { node, snapshot } from './helpers';
import type { StructuralNode } from '@pdf-testkit/core';

/**
 * Regression (extraction-fidelity experiment, 2026-09-09, findings F2/F3):
 * table identity was positional. Two tables that swapped places reported as
 * "moved 243pt" AND "shrank 3×5 → 3×2" each, on every extraction path; after a
 * page-count change the shape-only fallback crossed two unrelated tables.
 * A table's identity is its content: header cells and column count.
 */
function table(id: string, order: number, box: { x: number; y: number; width: number; height: number }, rows: string[][]): StructuralNode[] {
  const out: StructuralNode[] = [];
  const cols = rows[0]!.length;
  out.push(node({ id: `0:table:${id}`, role: 'table', order, bbox: box, table: { rows: rows.length, cols } }));
  const rowH = box.height / rows.length;
  const colW = box.width / cols;
  rows.forEach((cells, r) => {
    const rid = `0:row:${id}-${r}`;
    out.push(node({ id: rid, role: 'row', order: order + 1 + r * (cols + 1), parentId: `0:table:${id}`, bbox: { x: box.x, y: box.y + r * rowH, width: box.width, height: rowH } }));
    cells.forEach((text, c) => out.push(node({ id: `0:cell:${id}-${r}-${c}`, role: 'cell', order: order + 2 + r * (cols + 1) + c, parentId: rid, text, bbox: { x: box.x + c * colW, y: box.y + r * rowH, width: colW, height: rowH } })));
  });
  return out;
}
const APPLIED = [['Applied to', 'Reference', 'Document', 'Applied', 'Balance'], ['Invoice INV-4417', 'PO 44-7712', '4,647.07', '4,046.59', '0.00'], ['Credit note CN-0392', 'RMA-1188', '(600.48)', '(600.48)', '0.00']];
const SUMMARY = [['Invoiced', '4,647.07'], ['Credits applied', '(600.48)'], ['Cash received', '4,046.59']];

describe('table identity comes from content, not reading order', () => {
  it('two tables that swap places report as moved, never resized', () => {
    const base = snapshot([...table('a', 0, { x: 57, y: 278, width: 498, height: 54 }, APPLIED), ...table('b', 30, { x: 300, y: 347, width: 255, height: 64 }, SUMMARY)]);
    // Summary first now, applied-to beneath it. Same content, same shapes.
    const next = snapshot([...table('a', 0, { x: 300, y: 270, width: 255, height: 64 }, SUMMARY), ...table('b', 30, { x: 57, y: 357, width: 498, height: 54 }, APPLIED)]);
    const r = diffSnapshots(base, next);
    const tableEvents = r.events.filter((e) => e.type.startsWith('table'));
    expect(tableEvents.map((e) => e.type).sort()).toEqual(['table-moved', 'table-moved']);
    expect(r.stats.added).toBe(0);
    expect(r.stats.removed).toBe(0);
    // And the grouped summary says so: moved, with its rows and cells, not "changed, 21 repositioned".
    const groups = groupEvents(base, next, r.events);
    expect(groups.map((g) => g.summary).sort()).toEqual(['table moved 77pt on page 1 (9 elements with it)', 'table moved 79pt on page 1 (18 elements with it)']);
  });

  it('two tables with the same column count that swap places are told apart by their header', () => {
    const CHARGES = [['Description', 'Amount'], ['Consulting', '1,200.00'], ['Travel', '340.00']];
    const base = snapshot([...table('a', 0, { x: 57, y: 100, width: 300, height: 45 }, CHARGES), ...table('b', 30, { x: 57, y: 200, width: 300, height: 45 }, SUMMARY)]);
    const next = snapshot([...table('a', 0, { x: 57, y: 100, width: 300, height: 45 }, SUMMARY), ...table('b', 30, { x: 57, y: 200, width: 300, height: 45 }, CHARGES)]);
    const r = diffSnapshots(base, next);
    const tableEvents = r.events.filter((e) => e.type.startsWith('table'));
    expect(tableEvents.map((e) => e.message).sort()).toEqual(['table moved 100pt on page 1', 'table moved 100pt on page 1']);
    expect(r.stats.added + r.stats.removed).toBe(0);
  });

  it('a table that grows rows keeps its identity', () => {
    const base = snapshot([...table('a', 0, { x: 57, y: 278, width: 498, height: 54 }, APPLIED)]);
    const grown = [...APPLIED, ['Invoice INV-4433', 'PO 44-7730', '2,180.00', '2,180.00', '0.00']];
    const next = snapshot([...table('a', 0, { x: 57, y: 278, width: 498, height: 72 }, grown)]);
    const r = diffSnapshots(base, next);
    const resized = r.events.filter((e) => e.type === 'table-resized');
    expect(resized).toHaveLength(1);
    expect(resized[0]!.message).toBe('table grew 3×5 → 4×5 on page 1');
    // The five new cells are additions; no header cell is reported removed.
    expect(r.stats.removed).toBe(0);
    expect(r.stats.added).toBe(6);
  });

  it('two structurally similar tables on one page are not conflated', () => {
    const CHARGES = [['Description', 'Amount'], ['Consulting', '1,200.00'], ['Travel', '340.00']];
    const CREDITS = [['Description', 'Amount'], ['Early payment', '(50.00)'], ['Goodwill', '(25.00)']];
    const base = snapshot([...table('a', 0, { x: 57, y: 100, width: 300, height: 45 }, CHARGES), ...table('b', 30, { x: 57, y: 200, width: 300, height: 45 }, CREDITS)]);
    // Only the credits table moves down 60pt.
    const next = snapshot([...table('a', 0, { x: 57, y: 100, width: 300, height: 45 }, CHARGES), ...table('b', 30, { x: 57, y: 260, width: 300, height: 45 }, CREDITS)]);
    const r = diffSnapshots(base, next);
    const moved = r.events.filter((e) => e.type === 'table-moved');
    expect(moved).toHaveLength(1);
    expect(moved[0]!.message).toBe('table moved 60pt on page 1');
    expect(r.events.filter((e) => e.type === 'table-resized')).toEqual([]);
    // Every credits cell moved with it; no charges cell did.
    const cellMoves = r.events.filter((e) => e.type === 'element-moved' && 'role' in e && e.role === 'cell');
    expect(cellMoves.every((e) => 'textPreview' in e && ['Description', 'Amount', 'Early payment', '(50.00)', 'Goodwill', '(25.00)'].includes(e.textPreview as string))).toBe(true);
  });

  it('inserting a row into the first table does not shift the rows of the second', () => {
    // Rows used to key on their role alone, so every row in the document was
    // one bucket paired by rank: a row inserted in the first table shifted the
    // pairing of every row after it and the last row of the LAST table came out
    // "added" (the statement's activity table, in the experiment).
    const CHARGES = [['Description', 'Amount'], ['Consulting', '1,200.00'], ['Travel', '340.00']];
    const grown = [['Description', 'Amount'], ['Consulting', '1,200.00'], ['Software', '99.00'], ['Travel', '340.00']];
    const base = snapshot([...table('a', 0, { x: 57, y: 100, width: 300, height: 45 }, CHARGES), ...table('b', 30, { x: 57, y: 200, width: 300, height: 45 }, SUMMARY)]);
    const next = snapshot([...table('a', 0, { x: 57, y: 100, width: 300, height: 60 }, grown), ...table('b', 30, { x: 57, y: 215, width: 300, height: 45 }, SUMMARY)]);
    const r = diffSnapshots(base, next);
    const added = r.events.filter((e) => e.type === 'element-added');
    // One row and its two cells were added to the charges table; nothing was added to the summary table.
    expect(added.map((e) => ('role' in e ? e.role : '')).sort()).toEqual(['cell', 'cell', 'row']);
    const summaryRowsAdded = added.filter((e) => 'nodeId' in e && (e as { nodeId: string }).nodeId.startsWith('0:row:b'));
    expect(summaryRowsAdded).toEqual([]);
    expect(r.stats.removed).toBe(0);
  });

  it('cells with the same text in two tables do not trade places when the tables swap', () => {
    // "4,647.07", "4,046.59" and "(600.48)" appear in both the applied-to table
    // and the summary. Keyed on text alone, the rank pass paired them across
    // tables and reported cells moving 173pt when their tables moved 79pt.
    const base = snapshot([...table('a', 0, { x: 57, y: 278, width: 498, height: 54 }, APPLIED), ...table('b', 30, { x: 300, y: 347, width: 255, height: 64 }, SUMMARY)]);
    const next = snapshot([...table('a', 0, { x: 300, y: 270, width: 255, height: 64 }, SUMMARY), ...table('b', 30, { x: 57, y: 357, width: 498, height: 54 }, APPLIED)]);
    const r = diffSnapshots(base, next);
    const cellMoves = r.events.filter((e): e is Extract<typeof e, { type: 'element-moved' }> => e.type === 'element-moved' && 'role' in e && e.role === 'cell');
    expect(cellMoves.every((e) => e.distancePts <= 79)).toBe(true);
    expect(r.events.filter((e) => e.type === 'element-resized')).toEqual([]);
  });

  it('a table pushed down by a row inserted above it keeps every cell paired', () => {
    // Real ids are per-page ordinals: inserting a row in the first table
    // renumbers every row and cell after it, so `0:row:5` is table two's first
    // row in the baseline and the inserted row in the new run. A cell that
    // looked its table up across snapshots got the wrong token, and the
    // pushed table's cells came out "added" under the wrong table.
    const ordinal = (rows: string[][][], ys: number[]): StructuralNode[] => {
      const out: StructuralNode[] = [];
      let r = 0, c = 0, order = 0;
      rows.forEach((tbl, t) => {
        const cols = tbl[0]!.length;
        out.push(node({ id: `0:table:${t}`, role: 'table', order: order++, bbox: { x: 57, y: ys[t]!, width: 300, height: 15 * tbl.length }, table: { rows: tbl.length, cols } }));
        tbl.forEach((cells, i) => {
          const rid = `0:row:${r++}`;
          out.push(node({ id: rid, role: 'row', order: order++, parentId: `0:table:${t}`, bbox: { x: 57, y: ys[t]! + i * 15, width: 300, height: 15 } }));
          cells.forEach((text, j) => out.push(node({ id: `0:cell:${c++}`, role: 'cell', order: order++, parentId: rid, text, bbox: { x: 57 + j * (300 / cols), y: ys[t]! + i * 15, width: 300 / cols, height: 15 } })));
        });
      });
      return out;
    };
    const CHARGES = [['Description', 'Amount'], ['Consulting', '1,200.00'], ['Travel', '340.00']];
    const grown = [['Description', 'Amount'], ['Consulting', '1,200.00'], ['Software', '99.00'], ['Travel', '340.00']];
    const AGEING = [['Current', '1–30 days', 'Total'], ['4,046.59', '9,244.10', '35,731.24']];
    const base = snapshot(ordinal([CHARGES, AGEING], [100, 200]));
    const next = snapshot(ordinal([grown, AGEING], [100, 215]));
    const r = diffSnapshots(base, next);
    const added = r.events.filter((e) => e.type === 'element-added').map((e) => ('textPreview' in e ? e.textPreview : e.type));
    expect(added.sort()).toEqual(['', '99.00', 'Software']);
    const groups = groupEvents(base, next, r.events);
    expect(groups.map((g) => g.summary).sort()).toEqual(['table grew +1 row, +2 cells (3×2 → 4×2)', 'table moved 15pt on page 1 (8 elements with it)']);
  });
});
