import { describe, expect, it } from 'vitest';
import { diffSnapshots, groupEvents } from '@pdf-testkit/core';
import { node, snapshot } from './helpers';

const bbox = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/**
 * A table that loses rows keeps its top edge; its centre rises by half the
 * lost height. Deciding "moved" by centre distance called that a move (seen
 * on the first real PDF through the hosted service: "Table moved on page 1"
 * with before and after both at top 163pt). A resize and a move are different
 * findings, as they already are for every other element.
 */
describe('table-resized', () => {
  it('a table that shrinks in place is resized, not moved', () => {
    const a = snapshot([node({ id: '0:table:0', role: 'table', table: { rows: 23, cols: 4 }, bbox: bbox(40, 163, 516, 414) })]);
    const b = snapshot([node({ id: '0:table:0', role: 'table', table: { rows: 8, cols: 4 }, bbox: bbox(40, 163, 516, 144) })]);
    const { events } = diffSnapshots(a, b);
    expect(events.filter((e) => e.type === 'table-moved')).toEqual([]);
    const resized = events.filter((e) => e.type === 'table-resized');
    expect(resized).toHaveLength(1);
    expect(resized[0]).toMatchObject({ fromRows: 23, fromCols: 4, toRows: 8, toCols: 4, pageIndex: 0, heightDelta: -270 });
    expect(resized[0]!.message).toBe('table shrank 23×4 → 8×4 on page 1');
  });

  it('a table whose origin shifts is moved, and says by how much', () => {
    const a = snapshot([node({ id: '0:table:0', role: 'table', table: { rows: 8, cols: 4 }, bbox: bbox(40, 163, 516, 144) })]);
    const b = snapshot([node({ id: '0:table:0', role: 'table', table: { rows: 8, cols: 4 }, bbox: bbox(40, 213, 516, 144) })]);
    const { events } = diffSnapshots(a, b);
    expect(events.filter((e) => e.type === 'table-resized')).toEqual([]);
    const moved = events.filter((e) => e.type === 'table-moved');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ distancePts: 50 });
    expect(moved[0]!.message).toBe('table moved 50pt on page 1');
  });

  it('the resize is the root of its group, so the cascade folds under it', () => {
    const cells = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => node({ id: `0:cell:${prefix}${i}`, role: 'cell', parentId: '0:table:0', text: `c${i}`, bbox: bbox(40, 181 + i * 18, 120, 14) }));
    const a = snapshot([node({ id: '0:table:0', role: 'table', table: { rows: 23, cols: 4 }, bbox: bbox(40, 163, 516, 414) }), ...cells(22, 'a')]);
    const b = snapshot([node({ id: '0:table:0', role: 'table', table: { rows: 8, cols: 4 }, bbox: bbox(40, 163, 516, 144) }), ...cells(7, 'a')]);
    const { events } = diffSnapshots(a, b);
    const groups = groupEvents(a, b, events);
    const table = groups.find((g) => g.kind === 'table-resized');
    expect(table?.root.type).toBe('table-resized');
    expect(table!.events.length).toBeGreaterThan(1);
  });
});
