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

describe('groupEvents — the 19-line-item invoice', () => {
  const result = diffSnapshots(INVOICE_BASELINE, INVOICE_GROWN);
  const groups = groupEvents(INVOICE_BASELINE, INVOICE_GROWN, result.events);

  it('is the 123-event diff this feature was built for', () => {
    expect(result.events).toHaveLength(123);
  });

  it('collapses to a summary a person can actually read', () => {
    expect(groups.length).toBeLessThanOrEqual(8);
    expect(groups.map((g) => g.kind).sort()).toEqual([
      'new-page-furniture',
      'page-shift-cascade',
      'table-grew',
      'value-changed',
      'value-changed',
      'value-changed',
    ]);
  });

  it('loses nothing — the union of all groups is exactly the event list', () => {
    expectLosslessView(groups, result.events);
  });

  it('names the table growth as one finding with its real shape', () => {
    const table = groups.find((g) => g.kind === 'table-grew')!;
    expect(table.summary).toContain('+15 rows');
    expect(table.summary).toContain('6×4 → 21×5');
    // The bulk of the diff: 97 subtree adds plus the table's own event.
    expect(table.events.length).toBeGreaterThan(90);
  });

  it('attributes the downstream page shifts to the table, by delta not destination', () => {
    const cascade = groups.find((g) => g.kind === 'page-shift-cascade')!;
    expect(cascade.summary).toContain('shifted +1 page');
    expect(cascade.summary).toContain("following the table's growth");
    // Two different destinations (1→2 and 2→3) under one cause — summarising as
    // "everything moved to page 3" would be flatly wrong.
    expect(cascade.summary).toContain('1→2, 2→3');
    expect(cascade.events.every((e) => e.type === 'element-moved-to-different-page')).toBe(true);
  });

  it('folds the new page\'s repeated footer into the page-count change', () => {
    const furniture = groups.find((g) => g.kind === 'new-page-furniture')!;
    expect(furniture.root.type).toBe('page-count-changed');
    expect(furniture.summary).toContain('repeated header/footer element');
  });

  it('keeps the three changed totals visible instead of burying them', () => {
    // The one thing on this diff a reviewer must not miss: three amounts moved
    // by roughly 3x. Currently they sit at rows 16 and 121-123 of 123.
    const values = groups.filter((g) => g.kind === 'value-changed');
    expect(values.map((g) => g.summary)).toEqual([
      'text "$14350.00" → "$41158.00"',
      'text "$1148.00" → "$3292.64"',
      'text "$15498.00" → "$44450.64"',
    ]);
  });

  it('sorts errors above warnings', () => {
    expect(groups[0]!.severity).toBe('error');
    expect(groups.slice(1).every((g) => g.severity === 'warn')).toBe(true);
  });

  it('never disagrees with its own root about severity', () => {
    for (const g of groups) expect(g.severity).toBe(g.root.severity);
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
