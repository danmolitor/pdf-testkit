import { describe, it, expect } from 'vitest';
import { diffSnapshots } from '@pdf-testkit/core';
import { node, snapshot } from './helpers';

/**
 * Regression: the stage-1 by-text matcher paired identical-text siblings by
 * bucket order (`shift()`), so when one sibling LEAVES the text bucket — e.g.
 * a heading retrofit converts one Text to a Heading, changing its stage-1
 * key — every remaining sibling paired off-by-one. Siblings on different
 * pages then produced spurious `element-moved-to-different-page` events even
 * though no surviving element's position changed at all.
 *
 * Surfaced during the 2026-09 gallery heading retrofit as phantom
 * moved-to-page events on `report` and `catalog` (position sets unchanged).
 */
describe('stage-1 matching of identical-text siblings', () => {
  const boxP1 = { x: 40, y: 40, width: 200, height: 14 };
  const boxP2 = { x: 40, y: 40, width: 200, height: 14 };

  it('a sibling converting to a heading does not shift pairing across pages', () => {
    // Baseline: the same section label appears on page 1 and page 2.
    const base = snapshot(
      [
        node({ id: '0:text:0', text: 'Overview', pageIndex: 0, order: 0, bbox: boxP1 }),
        node({ id: '1:text:0', text: 'Overview', pageIndex: 1, order: 5, bbox: boxP2 }),
      ],
      { pageCount: 2 },
    );

    // Next run: the page-1 label became a real heading (same text, same
    // position). The page-2 label is untouched.
    const next = snapshot(
      [
        node({
          id: '0:heading:0',
          role: 'heading',
          headingLevel: 2,
          text: 'Overview',
          pageIndex: 0,
          order: 0,
          bbox: boxP1,
        }),
        node({ id: '1:text:0', text: 'Overview', pageIndex: 1, order: 5, bbox: boxP2 }),
      ],
      { pageCount: 2 },
    );

    const r = diffSnapshots(base, next);

    // The page-2 sibling did not move: no movement events of any kind.
    expect(
      r.events.filter((e) => e.type === 'element-moved-to-different-page'),
    ).toEqual([]);

    // The honest description of the change: a heading appeared on page 1
    // and a text disappeared on page 1. Nothing referencing page 2 beyond
    // the untouched pairing.
    const churn = r.events.filter(
      (e) => e.type === 'element-added' || e.type === 'element-removed',
    );
    expect(churn).toHaveLength(2);
    for (const e of churn) {
      expect((e as { pageIndex?: number }).pageIndex ?? 0).toBe(0);
    }
  });

  it('three identical siblings losing the first still pair the survivors in place', () => {
    // Page 1, 2, 3 each carry the same label; the page-1 instance is deleted.
    const mk = (page: number, id: string, role: 'text' | 'heading' = 'text') =>
      node({
        id,
        role,
        headingLevel: role === 'heading' ? 2 : null,
        text: 'Quarterly Summary',
        pageIndex: page,
        order: 0,
        bbox: { x: 40, y: 40, width: 200, height: 14 },
      });
    const base = snapshot([mk(0, '0:text:0'), mk(1, '1:text:0'), mk(2, '2:text:0')], {
      pageCount: 3,
    });
    const next = snapshot([mk(1, '1:text:0'), mk(2, '2:text:0')], { pageCount: 3 });

    const r = diffSnapshots(base, next);

    expect(
      r.events.filter((e) => e.type === 'element-moved-to-different-page'),
    ).toEqual([]);
    const removed = r.events.filter((e) => e.type === 'element-removed');
    expect(removed).toHaveLength(1);
    expect((removed[0] as { pageIndex?: number }).pageIndex ?? -1).toBe(0);
  });
});
