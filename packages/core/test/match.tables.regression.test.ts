import { describe, it, expect } from 'vitest';
import { diffSnapshots } from '@pdf-testkit/core';
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
});
