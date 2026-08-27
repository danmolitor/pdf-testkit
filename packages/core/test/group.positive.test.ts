import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { diffSnapshots, groupEvents, type StructuralSnapshot } from '@pdf-testkit/core';
import { node, snapshot } from './helpers';

/**
 * Grouping exists to make a large diff readable. The reference case is the real
 * FormePDF invoice from the dogfood run: growing the line-item table from 5 to
 * 19 rows produces 123 individually-accurate events, and a reviewer scrolling
 * past 123 rows approves without reading — the exact failure this tool exists
 * to prevent.
 *
 * The union assertion appears in every case on purpose. Grouping is a *view*,
 * never a filter; the moment a group can drop an event, the summary becomes a
 * thing you cannot trust, and `--verbose` stops being a faithful expansion.
 */
function fixture(name: string): StructuralSnapshot {
  const url = new URL(`../../fixtures/snapshots/${name}.snapshot.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as StructuralSnapshot;
}

const INVOICE_BASELINE = fixture('invoice-baseline');
const INVOICE_GROWN = fixture('invoice-grown');

/** Every input event appears in exactly one group, and nothing else does. */
function expectLosslessView(groups: { events: unknown[] }[], events: unknown[]): void {
  const union = groups.flatMap((g) => g.events);
  expect(union).toHaveLength(events.length);
  expect(new Set(union)).toEqual(new Set(events));
}

/**
 * The same fixture pair, run both ways.
 *
 * Growing a document and shrinking it are one change seen from opposite ends, so
 * every rule here has to hold for both. The first version of this module
 * collapsed the growth into 6 findings and the identical deletion into 86,
 * because every index it consulted was built from the *new* snapshot — a table
 * fragment that only exists in the baseline had nothing to be looked up by, so
 * all 72 of its descendants fell out as loose rows. A suite that only ever ran
 * one direction could not see that, and did not.
 */
const DIRECTIONS = [
  {
    name: 'growing the line-item table from 5 rows to 19',
    baseline: INVOICE_BASELINE,
    next: INVOICE_GROWN,
    table: { delta: '+15 rows, +81 cells', shape: '(6×4 → 21×5)', verb: 'table grew' },
    // The table only spans a page break in the grown document.
    span: 'now spans pages 1–2',
    cascade: { dir: 'shifted +1 page', hops: '1→2, 2→3', cause: "following the table's growth" },
    furniture: '+4 repeated header/footer elements on the new page',
    values: [
      'text "$14350.00" → "$41158.00"',
      'text "$1148.00" → "$3292.64"',
      'text "$15498.00" → "$44450.64"',
    ],
  },
  {
    name: 'shrinking it back from 19 rows to 5',
    baseline: INVOICE_GROWN,
    next: INVOICE_BASELINE,
    table: { delta: '-15 rows, -81 cells', shape: '(21×5 → 6×4)', verb: 'table shrank' },
    span: null,
    cascade: { dir: 'shifted -1 page', hops: '2→1, 3→2', cause: 'following the table shrinking' },
    furniture: '-4 repeated header/footer elements on the removed page',
    values: [
      'text "$41158.00" → "$14350.00"',
      'text "$3292.64" → "$1148.00"',
      'text "$44450.64" → "$15498.00"',
    ],
  },
] as const;

for (const d of DIRECTIONS) {
  describe(`groupEvents — the 19-line-item invoice, ${d.name}`, () => {
    const result = diffSnapshots(d.baseline, d.next);
    const groups = groupEvents(d.baseline, d.next, result.events);

    it('is the 123-event diff this feature was built for', () => {
      expect(result.events).toHaveLength(123);
    });

    it('collapses to a summary a person can actually read', () => {
      expect(groups.length).toBeLessThanOrEqual(8);
      expect(groups.map((g) => g.kind).sort()).toEqual([
        'new-page-furniture',
        'page-shift-cascade',
        'table-resized',
        'value-changed',
        'value-changed',
        'value-changed',
      ]);
    });

    it('loses nothing — the union of all groups is exactly the event list', () => {
      expectLosslessView(groups, result.events);
    });

    it('names the table resize as one finding with its real shape', () => {
      const table = groups.find((g) => g.kind === 'table-resized')!;
      // Both ends of the shape come from the fragments that exist on each side,
      // not from the events in the group: on the shrink, the baseline's second
      // fragment produces no event of its own, and reading the shape off the
      // event list reported a 21-row table as a 9-row one.
      expect(table.summary).toBe(
        `${d.table.verb} ${d.table.delta} ${d.table.shape}${d.span ? `, ${d.span}` : ''}`,
      );
      // The bulk of the diff: 97 subtree adds/removes plus the table's own event.
      expect(table.events).toHaveLength(98);
    });

    it('attributes the downstream page shifts to the table, by delta not destination', () => {
      const cascade = groups.find((g) => g.kind === 'page-shift-cascade')!;
      expect(cascade.summary).toContain(d.cascade.dir);
      expect(cascade.summary).toContain(d.cascade.cause);
      // Two different destinations under one cause — summarising as "everything
      // moved to page 3" would be flatly wrong.
      expect(cascade.summary).toContain(d.cascade.hops);
      expect(cascade.events).toHaveLength(14);
      expect(cascade.events.every((e) => e.type === 'element-moved-to-different-page')).toBe(true);
    });

    it('folds the appearing/vanishing page\'s repeated footer into the page-count change', () => {
      const furniture = groups.find((g) => g.kind === 'new-page-furniture')!;
      expect(furniture.root.type).toBe('page-count-changed');
      expect(furniture.summary).toContain(d.furniture);
    });

    it('keeps the three changed totals visible instead of burying them', () => {
      // The one thing on this diff a reviewer must not miss: three amounts
      // moved by roughly 3x, sitting at rows 16 and 121-123 of 123.
      const values = groups.filter((g) => g.kind === 'value-changed');
      expect(values.map((g) => g.summary)).toEqual([...d.values]);
    });

    it('never blames a value change for a page shift', () => {
      // A string swapped for another in place cannot push content across a page
      // boundary. Before the fix the shrink read "4 elements shifted -1 page
      // following text "$44450.64" → "$15498.00"" — fluent and wrong.
      for (const g of groups) expect(g.summary).not.toMatch(/following text "/);
    });

    it('sorts errors above warnings', () => {
      expect(groups[0]!.severity).toBe('error');
      expect(groups.slice(1).every((g) => g.severity === 'warn')).toBe(true);
    });

    it('never disagrees with its own root about severity', () => {
      for (const g of groups) expect(g.severity).toBe(g.root.severity);
    });
  });
}

describe('groupEvents — direction symmetry', () => {
  // Stated as its own contract rather than left implicit in the two suites
  // above: a new rule that reads only one snapshot will pass every
  // growth-direction assertion and fail here.
  it('finds the same shape of change whichever way it ran', () => {
    const shape = (a: StructuralSnapshot, b: StructuralSnapshot) => {
      const result = diffSnapshots(a, b);
      return groupEvents(a, b, result.events).map((g) => `${g.kind}:${g.events.length}`);
    };
    expect(shape(INVOICE_GROWN, INVOICE_BASELINE)).toEqual(shape(INVOICE_BASELINE, INVOICE_GROWN));
  });
});

describe('groupEvents — a table that spills across an existing page break', () => {
  /**
   * The FormePDF invoice again, but with the padding raised just enough to push
   * the last rows onto a page that already existed. The page *count* never
   * changes, and that used to be the only trigger for continuation detection —
   * so the fragment appearing at the top of page 2 was read as a brand-new
   * table, and the diff announced "table added (4×5)" for rows that had merely
   * flowed over. Whether a table wraps and whether the document gained a page
   * are independent facts; treating one as evidence of the other is the bug.
   */
  const cell = (id: string, parentId: string, page: number, order: number, text: string) =>
    node({ id, role: 'cell', text, parentId, pageIndex: page, order, bbox: { x: 48, y: 100 + order * 20, width: 172, height: 20 } });

  /** A table fragment: `rows` rows of 3 cells, ids namespaced by `tag`. */
  const fragment = (tag: string, page: number, top: number, rows: number, startOrder: number) => {
    const tableId = `${page}:table:${tag}`;
    const out = [
      node({
        id: tableId, role: 'table', text: null, pageIndex: page, order: startOrder,
        table: { rows, cols: 3 },
        bbox: { x: 48, y: top, width: 516, height: rows * 20 },
      }),
    ];
    for (let r = 0; r < rows; r++) {
      const rowId = `${page}:row:${tag}${r}`;
      out.push(node({
        id: rowId, role: 'row', text: null, parentId: tableId, pageIndex: page,
        order: startOrder + 1 + r * 4, bbox: { x: 48, y: top + r * 20, width: 516, height: 20 },
      }));
      for (let c = 0; c < 3; c++) {
        out.push(cell(`${page}:cell:${tag}${r}${c}`, rowId, page, startOrder + 2 + r * 4 + c, `${tag}-r${r}c${c}`));
      }
    }
    return out;
  };

  // Page 1 already exists in the baseline — it holds the appendix. All that
  // changes is where the table stops.
  const appendix = (page: number, order: number, y: number) =>
    node({ id: `${page}:text:appendix`, text: 'Appendix A', pageIndex: page, order, bbox: { x: 48, y, width: 200, height: 14 } });

  const base = snapshot([...fragment('0', 0, 300, 3, 0), appendix(1, 0, 48)], { pageCount: 2 });
  const next = snapshot(
    [...fragment('0', 0, 300, 3, 0), ...fragment('0', 1, 48, 2, 0), appendix(1, 100, 200)],
    { pageCount: 2 },
  );

  const result = diffSnapshots(base, next);
  const groups = groupEvents(base, next, result.events);

  it('reads the new fragment as the same table continuing, not a second table', () => {
    const table = groups.find((g) => g.kind === 'table-resized');
    expect(table).toBeDefined();
    expect(table!.summary).toBe('table grew +2 rows, +6 cells (3×3 → 5×3), now spans pages 1–2');
  });

  it('puts the whole spilled fragment in that one group', () => {
    const table = groups.find((g) => g.kind === 'table-resized')!;
    // The fragment itself, 2 rows, 6 cells.
    expect(table.events).toHaveLength(9);
    expect(groups.some((g) => g.summary.startsWith('table added'))).toBe(false);
  });

  it('loses nothing', () => {
    expectLosslessView(groups, result.events);
  });
});

describe('groupEvents — synthetic cases', () => {
  it('collapses a contiguous run of shifted elements into one cascade', () => {
    const base = Array.from({ length: 8 }, (_, i) =>
      node({ id: `0:text:${i}`, text: `paragraph ${i}`, pageIndex: 0, order: i }),
    );
    // The first two stay; a page break pushes the remaining six to page 2.
    const next = base.map((n, i) =>
      i < 2 ? n : node({ ...n, id: `1:text:${i - 2}`, pageIndex: 1, order: i - 2 }),
    );
    const a = snapshot(base, { pageCount: 1 });
    const b = snapshot(next, { pageCount: 2 });

    const result = diffSnapshots(a, b);
    const groups = groupEvents(a, b, result.events);

    expect(result.events).toHaveLength(7);
    expect(groups).toHaveLength(2);
    const cascade = groups.find((g) => g.kind === 'page-shift-cascade')!;
    expect(cascade.events).toHaveLength(6);
    expect(cascade.summary).toContain('6 elements shifted +1 page');
    expectLosslessView(groups, result.events);
  });

  it('pairs a removed and re-added value at the same slot rather than collapsing it', () => {
    const totals = (amount: string) =>
      snapshot([
        node({ id: '0:container:0', role: 'container', text: null, order: 0, bbox: { x: 40, y: 200, width: 300, height: 40 } }),
        node({ id: '0:text:0', text: 'Total Due', parentId: '0:container:0', order: 1, bbox: { x: 40, y: 200, width: 80, height: 14 } }),
        node({ id: '0:text:1', text: amount, parentId: '0:container:0', order: 2, bbox: { x: 240, y: 200, width: amount.length * 7, height: 14 } }),
      ]);
    const a = totals('$100.00');
    const b = totals('$1,250.00');

    const result = diffSnapshots(a, b);
    const groups = groupEvents(a, b, result.events);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('value-changed');
    expect(groups[0]!.summary).toBe('text "$100.00" → "$1,250.00"');
    expectLosslessView(groups, result.events);
  });

  it('returns an empty list for an empty diff', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'same' })]);
    expect(groupEvents(a, a, [])).toEqual([]);
  });
});
