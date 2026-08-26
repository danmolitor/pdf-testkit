import { describe, it, expect } from 'vitest';
import { diffSnapshots } from '@pdf-testkit/core';
import type { SemanticEventType } from '@pdf-testkit/core';
import { node, snapshot } from './helpers';

const types = (events: { type: SemanticEventType }[]): SemanticEventType[] => events.map((e) => e.type);

describe('diff engine — real changes ARE caught', () => {
  it('reports a page-count change', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'hello' })], { pageCount: 1 });
    const b = snapshot([node({ id: '0:text:0', text: 'hello' })], { pageCount: 2 });
    const r = diffSnapshots(a, b);
    expect(types(r.events)).toContain('page-count-changed');
  });

  it('reports a heading hierarchy change H2 -> H3', () => {
    const a = snapshot([node({ id: '0:heading:0', role: 'heading', headingLevel: 2, text: 'Revenue' })]);
    const b = snapshot([node({ id: '0:heading:0', role: 'heading', headingLevel: 3, text: 'Revenue' })]);
    const r = diffSnapshots(a, b);
    const ev = r.events.find((e) => e.type === 'heading-hierarchy-changed');
    expect(ev).toBeDefined();
    expect(ev).toMatchObject({ fromLevel: 2, toLevel: 3 });
  });

  it('reports a table moving to a different page', () => {
    const a = snapshot(
      [node({ id: '0:table:0', role: 'table', pageIndex: 0, table: { rows: 2, cols: 3 }, bbox: { x: 40, y: 160, width: 400, height: 40 } })],
      { pageCount: 2 },
    );
    const b = snapshot(
      [node({ id: '1:table:0', role: 'table', pageIndex: 1, table: { rows: 2, cols: 3 }, bbox: { x: 40, y: 160, width: 400, height: 40 } })],
      { pageCount: 2 },
    );
    const r = diffSnapshots(a, b);
    const ev = r.events.find((e) => e.type === 'table-moved');
    expect(ev).toMatchObject({ fromPage: 0, toPage: 1 });
  });

  it('reports a deleted paragraph as removed (not churn)', () => {
    const a = snapshot([
      node({ id: '0:text:0', text: 'keep me', bbox: { x: 40, y: 40, width: 200, height: 14 } }),
      node({ id: '0:text:1', text: 'delete me', bbox: { x: 40, y: 60, width: 200, height: 14 } }),
    ]);
    const b = snapshot([node({ id: '0:text:0', text: 'keep me', bbox: { x: 40, y: 40, width: 200, height: 14 } })]);
    const r = diffSnapshots(a, b);
    const removed = r.events.filter((e) => e.type === 'element-removed');
    expect(removed).toHaveLength(1);
    expect(r.events.some((e) => e.type === 'element-added')).toBe(false);
  });

  it('reports newly-present overflow as an error event', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'line', overflow: null })]);
    const b = snapshot([
      node({ id: '0:text:0', text: 'line', overflow: { axis: 'x', overflowPts: 14.2, container: 'page-content' } }),
    ]);
    const r = diffSnapshots(a, b);
    const ev = r.events.find((e) => e.type === 'text-overflowed-container');
    expect(ev?.severity).toBe('error');
  });
});
