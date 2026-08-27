import { describe, it, expect } from 'vitest';
import { diffSnapshots, groupEvents } from '@pdf-testkit/core';
import { node, snapshot } from './helpers';

/**
 * The negative direction for grouping, and it carries the same weight as the
 * negative diff tests: things that are NOT one cause must never be summarised as
 * one cause. A false group is worse than no grouping at all — "23 elements
 * shifted following the table" reads as a single mechanical consequence, so if
 * one of those 23 actually moved for an unrelated reason, grouping has hidden a
 * regression rather than surfaced it.
 *
 * These must never be trimmed.
 */
describe('groupEvents — unrelated changes are NOT collapsed', () => {
  it('does not merge two same-delta shifts that sit in different parts of the document', () => {
    // Both regions shift +1 page, but a block of untouched content sits between
    // them: two separate insertions, not one cascade.
    const base = snapshot(
      [
        node({ id: '0:text:0', text: 'header note', pageIndex: 0, order: 0 }),
        node({ id: '0:text:1', text: 'alpha one', pageIndex: 0, order: 1 }),
        node({ id: '0:text:2', text: 'alpha two', pageIndex: 0, order: 2 }),
        node({ id: '0:text:3', text: 'alpha three', pageIndex: 0, order: 3 }),
        node({ id: '1:text:0', text: 'stable one', pageIndex: 1, order: 0 }),
        node({ id: '1:text:1', text: 'stable two', pageIndex: 1, order: 1 }),
        node({ id: '1:text:2', text: 'beta one', pageIndex: 1, order: 2 }),
        node({ id: '1:text:3', text: 'beta two', pageIndex: 1, order: 3 }),
        node({ id: '1:text:4', text: 'beta three', pageIndex: 1, order: 4 }),
      ],
      { pageCount: 2 },
    );
    const next = snapshot(
      [
        node({ id: '0:text:0', text: 'header note', pageIndex: 0, order: 0 }),
        node({ id: '1:text:0', text: 'alpha one', pageIndex: 1, order: 0 }),
        node({ id: '1:text:1', text: 'alpha two', pageIndex: 1, order: 1 }),
        node({ id: '1:text:2', text: 'alpha three', pageIndex: 1, order: 2 }),
        node({ id: '1:text:3', text: 'stable one', pageIndex: 1, order: 3 }),
        node({ id: '1:text:4', text: 'stable two', pageIndex: 1, order: 4 }),
        node({ id: '2:text:0', text: 'beta one', pageIndex: 2, order: 0 }),
        node({ id: '2:text:1', text: 'beta two', pageIndex: 2, order: 1 }),
        node({ id: '2:text:2', text: 'beta three', pageIndex: 2, order: 2 }),
      ],
      { pageCount: 3 },
    );

    const result = diffSnapshots(base, next);
    const groups = groupEvents(base, next, result.events);

    const cascades = groups.filter((g) => g.kind === 'page-shift-cascade');
    expect(cascades).toHaveLength(2);
    expect(cascades.map((g) => g.events.length)).toEqual([3, 3]);
    // The failure this guards: one group of six claiming a single cause.
    expect(cascades.some((g) => g.events.length === 6)).toBe(false);
    expectLossless(groups, result.events);
  });

  it('never puts moves with different page deltas in the same group', () => {
    // Content pulled up one page in one region, pushed down one page in another.
    const base = snapshot(
      [
        node({ id: '0:text:0', text: 'up one', pageIndex: 0, order: 0 }),
        node({ id: '0:text:1', text: 'up two', pageIndex: 0, order: 1 }),
        node({ id: '0:text:2', text: 'up three', pageIndex: 0, order: 2 }),
        node({ id: '3:text:0', text: 'down one', pageIndex: 3, order: 0 }),
        node({ id: '3:text:1', text: 'down two', pageIndex: 3, order: 1 }),
        node({ id: '3:text:2', text: 'down three', pageIndex: 3, order: 2 }),
      ],
      { pageCount: 4 },
    );
    const next = snapshot(
      [
        node({ id: '1:text:0', text: 'up one', pageIndex: 1, order: 0 }),
        node({ id: '1:text:1', text: 'up two', pageIndex: 1, order: 1 }),
        node({ id: '1:text:2', text: 'up three', pageIndex: 1, order: 2 }),
        node({ id: '2:text:0', text: 'down one', pageIndex: 2, order: 0 }),
        node({ id: '2:text:1', text: 'down two', pageIndex: 2, order: 1 }),
        node({ id: '2:text:2', text: 'down three', pageIndex: 2, order: 2 }),
      ],
      { pageCount: 3 },
    );

    const result = diffSnapshots(base, next);
    const groups = groupEvents(base, next, result.events);

    for (const g of groups) {
      const deltas = new Set(
        g.events
          .filter((e) => e.type === 'element-moved-to-different-page')
          .map((e) => (e as { toPage: number; fromPage: number }).toPage - (e as { fromPage: number }).fromPage),
      );
      expect(deltas.size).toBeLessThanOrEqual(1);
    }
    expectLossless(groups, result.events);
  });

  it('leaves a two-element shift as two plain rows', () => {
    // Below the cascade threshold: a flat list is already readable here, and
    // collapsing it would cost information for no gain.
    const base = snapshot(
      [
        node({ id: '0:text:0', text: 'kept in place', pageIndex: 0, order: 0 }),
        node({ id: '0:text:1', text: 'moves one', pageIndex: 0, order: 1 }),
        node({ id: '0:text:2', text: 'moves two', pageIndex: 0, order: 2 }),
      ],
      { pageCount: 1 },
    );
    const next = snapshot(
      [
        node({ id: '0:text:0', text: 'kept in place', pageIndex: 0, order: 0 }),
        node({ id: '1:text:0', text: 'moves one', pageIndex: 1, order: 0 }),
        node({ id: '1:text:1', text: 'moves two', pageIndex: 1, order: 1 }),
      ],
      { pageCount: 2 },
    );

    const result = diffSnapshots(base, next);
    const groups = groupEvents(base, next, result.events);

    expect(groups.every((g) => g.kind === 'single')).toBe(true);
    expect(groups).toHaveLength(result.events.length);
    expectLossless(groups, result.events);
  });

  it('ejects an error-severity member rather than demoting it into a warn summary', () => {
    // A team that treats removals as hard failures. The added/removed pair is
    // still the same slot, but folding the error into a warn-level
    // "value changed" line would make severity mean different things in the
    // summary and in the gate.
    const totals = (amount: string) =>
      snapshot([
        node({ id: '0:container:0', role: 'container', text: null, order: 0, bbox: { x: 40, y: 200, width: 300, height: 40 } }),
        node({ id: '0:text:0', text: 'Total Due', parentId: '0:container:0', order: 1, bbox: { x: 40, y: 200, width: 80, height: 14 } }),
        node({ id: '0:text:1', text: amount, parentId: '0:container:0', order: 2, bbox: { x: 240, y: 200, width: amount.length * 7, height: 14 } }),
      ]);
    const base = totals('$100.00');
    const next = totals('$1,250.00');
    const opts = { severityOverrides: { 'element-removed': 'error' as const } };

    const result = diffSnapshots(base, next, opts);
    const groups = groupEvents(base, next, result.events, opts);

    expect(groups.every((g) => g.kind === 'single')).toBe(true);
    const error = groups.find((g) => g.severity === 'error')!;
    expect(error.events).toHaveLength(1);
    expect(error.root.type).toBe('element-removed');
    expectLossless(groups, result.events);
  });

  it('does not treat an overflow on an added element as part of that element\'s group', () => {
    // The added footer belongs with the page-count change; its overflow is a
    // separate, more severe finding about the same node and must stay visible.
    const base = snapshot(
      [
        node({ id: '0:text:0', text: 'Acme Inc — confidential', pageIndex: 0, order: 0 }),
        node({ id: '0:text:1', text: 'Page footer', pageIndex: 0, order: 1 }),
        node({ id: '0:text:2', text: 'body copy', pageIndex: 0, order: 2 }),
      ],
      { pageCount: 1 },
    );
    const next = snapshot(
      [
        node({ id: '0:text:0', text: 'Acme Inc — confidential', pageIndex: 0, order: 0 }),
        node({ id: '0:text:1', text: 'Page footer', pageIndex: 0, order: 1 }),
        node({ id: '0:text:2', text: 'body copy', pageIndex: 0, order: 2 }),
        node({ id: '1:text:0', text: 'Acme Inc — confidential', pageIndex: 1, order: 0 }),
        node({
          id: '1:text:1',
          text: 'Page footer',
          pageIndex: 1,
          order: 1,
          overflow: { axis: 'x', overflowPts: 12.5, container: 'page-content' },
        }),
      ],
      { pageCount: 2 },
    );

    const result = diffSnapshots(base, next);
    const groups = groupEvents(base, next, result.events);

    const overflow = groups.find((g) => g.root.type === 'text-overflowed-container')!;
    expect(overflow.kind).toBe('single');
    expect(overflow.events).toHaveLength(1);
    expect(groups.some((g) => g.events.length > 1 && g.events.some((e) => e.severity === 'error' && g.severity !== 'error'))).toBe(false);
    expectLossless(groups, result.events);
  });

  it('does not fold a genuinely new table into an existing one when the page count is unchanged', () => {
    // Two tables on one page in the new run. Without a page-count change there
    // is no continuation to infer, so the second is its own finding.
    const base = snapshot([
      node({ id: '0:table:0', role: 'table', text: null, order: 0, table: { rows: 2, cols: 2 }, bbox: { x: 40, y: 100, width: 300, height: 40 } }),
    ]);
    const next = snapshot([
      node({ id: '0:table:0', role: 'table', text: null, order: 0, table: { rows: 2, cols: 2 }, bbox: { x: 40, y: 100, width: 300, height: 40 } }),
      node({ id: '0:table:1', role: 'table', text: null, order: 1, table: { rows: 3, cols: 4 }, bbox: { x: 40, y: 300, width: 300, height: 60 } }),
    ]);

    const result = diffSnapshots(base, next);
    const groups = groupEvents(base, next, result.events);

    expect(groups.some((g) => g.kind === 'table-resized')).toBe(false);
    expectLossless(groups, result.events);
  });

  it('does not fold a wholly deleted table into the one that survived', () => {
    // The mirror of the case above, and the one the direction fix could plausibly
    // over-reach on: making deletions groupable must not make *every* deleted
    // table a continuation of its neighbour.
    const table = (id: string, order: number, rows: number, y: number) =>
      node({ id, role: 'table', text: null, order, table: { rows, cols: 3 }, bbox: { x: 40, y, width: 300, height: rows * 20 } });
    const base = snapshot([table('0:table:0', 0, 2, 100), table('0:table:1', 1, 3, 300)]);
    const next = snapshot([table('0:table:0', 0, 2, 100)]);

    const result = diffSnapshots(base, next);
    const groups = groupEvents(base, next, result.events);

    expect(groups.some((g) => g.kind === 'table-resized')).toBe(false);
    expectLossless(groups, result.events);
  });

  it('does not merge two same-delta pull-ups from different parts of the document', () => {
    // The deletion mirror of the first case in this file. Two separate deletions
    // each pull everything after them up one page; reporting "6 elements shifted
    // -1 page" would claim a single cause that does not exist.
    const base = snapshot(
      [
        node({ id: '0:text:0', text: 'header note', pageIndex: 0, order: 0 }),
        node({ id: '1:text:0', text: 'alpha one', pageIndex: 1, order: 0 }),
        node({ id: '1:text:1', text: 'alpha two', pageIndex: 1, order: 1 }),
        node({ id: '1:text:2', text: 'alpha three', pageIndex: 1, order: 2 }),
        node({ id: '1:text:3', text: 'stable one', pageIndex: 1, order: 3 }),
        node({ id: '1:text:4', text: 'stable two', pageIndex: 1, order: 4 }),
        node({ id: '2:text:0', text: 'beta one', pageIndex: 2, order: 0 }),
        node({ id: '2:text:1', text: 'beta two', pageIndex: 2, order: 1 }),
        node({ id: '2:text:2', text: 'beta three', pageIndex: 2, order: 2 }),
      ],
      { pageCount: 3 },
    );
    const next = snapshot(
      [
        node({ id: '0:text:0', text: 'header note', pageIndex: 0, order: 0 }),
        node({ id: '0:text:1', text: 'alpha one', pageIndex: 0, order: 1 }),
        node({ id: '0:text:2', text: 'alpha two', pageIndex: 0, order: 2 }),
        node({ id: '0:text:3', text: 'alpha three', pageIndex: 0, order: 3 }),
        node({ id: '1:text:0', text: 'stable one', pageIndex: 1, order: 0 }),
        node({ id: '1:text:1', text: 'stable two', pageIndex: 1, order: 1 }),
        node({ id: '1:text:2', text: 'beta one', pageIndex: 1, order: 2 }),
        node({ id: '1:text:3', text: 'beta two', pageIndex: 1, order: 3 }),
        node({ id: '1:text:4', text: 'beta three', pageIndex: 1, order: 4 }),
      ],
      { pageCount: 2 },
    );

    const result = diffSnapshots(base, next);
    const groups = groupEvents(base, next, result.events);

    const cascades = groups.filter((g) => g.kind === 'page-shift-cascade');
    expect(cascades).toHaveLength(2);
    expect(cascades.map((g) => g.events.length)).toEqual([3, 3]);
    expect(cascades.some((g) => g.events.length === 6)).toBe(false);
    expectLossless(groups, result.events);
  });
});

/** Grouping is a view, never a filter — assert it on every case. */
function expectLossless(groups: { events: unknown[] }[], events: unknown[]): void {
  const union = groups.flatMap((g) => g.events);
  expect(union).toHaveLength(events.length);
  expect(new Set(union)).toEqual(new Set(events));
}
