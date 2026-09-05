import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '@pdf-testkit/core';
import { node, snapshot } from './helpers';

/**
 * A consumer holding only the event list — the cloud service drawing highlight
 * overlays on page images — must be able to locate the change on BOTH the
 * baseline page and the new page without re-running the matcher. So every
 * paired event carries the baseline node id and both bounding boxes, and every
 * unpaired event carries the box of the node it concerns.
 */
describe('diff engine — events carry the geometry a consumer needs', () => {
  it('table-moved names its baseline node and both boxes', () => {
    const a = snapshot([node({ id: '0:table:0', role: 'table', pageIndex: 0, table: { rows: 2, cols: 3 }, bbox: { x: 40, y: 160, width: 400, height: 40 } })], { pageCount: 2 });
    const b = snapshot([node({ id: '1:table:0', role: 'table', pageIndex: 1, table: { rows: 2, cols: 3 }, bbox: { x: 40, y: 212, width: 400, height: 40 } })], { pageCount: 2 });
    const ev = diffSnapshots(a, b).events.find((e) => e.type === 'table-moved');
    expect(ev).toMatchObject({
      nodeId: '1:table:0',
      baseNodeId: '0:table:0',
      fromBBox: { x: 40, y: 160, width: 400, height: 40 },
      toBBox: { x: 40, y: 212, width: 400, height: 40 },
    });
  });

  it('element-moved-to-different-page names its baseline node and both boxes', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'terms', pageIndex: 0, bbox: { x: 40, y: 700, width: 300, height: 14 } })], { pageCount: 2 });
    const b = snapshot([node({ id: '1:text:0', text: 'terms', pageIndex: 1, bbox: { x: 40, y: 60, width: 300, height: 14 } })], { pageCount: 2 });
    const ev = diffSnapshots(a, b).events.find((e) => e.type === 'element-moved-to-different-page');
    expect(ev).toMatchObject({
      nodeId: '1:text:0',
      baseNodeId: '0:text:0',
      fromBBox: { x: 40, y: 700, width: 300, height: 14 },
      toBBox: { x: 40, y: 60, width: 300, height: 14 },
    });
  });

  it('heading-hierarchy-changed names its baseline node and both boxes', () => {
    const a = snapshot([node({ id: '0:heading:0', role: 'heading', headingLevel: 2, text: 'Bill To', bbox: { x: 40, y: 120, width: 120, height: 16 } })]);
    const b = snapshot([node({ id: '0:heading:0', role: 'heading', headingLevel: 3, text: 'Bill To', bbox: { x: 40, y: 120, width: 90, height: 12 } })]);
    const ev = diffSnapshots(a, b).events.find((e) => e.type === 'heading-hierarchy-changed');
    expect(ev).toMatchObject({
      baseNodeId: '0:heading:0',
      fromBBox: { x: 40, y: 120, width: 120, height: 16 },
      toBBox: { x: 40, y: 120, width: 90, height: 12 },
    });
  });

  it('element-moved (same page) names its baseline node', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'running header', bbox: { x: 40, y: 20, width: 200, height: 14 } })]);
    const b = snapshot([node({ id: '0:text:0', text: 'running header', bbox: { x: 40, y: 60, width: 200, height: 14 } })]);
    const ev = diffSnapshots(a, b).events.find((e) => e.type === 'element-moved');
    expect(ev).toMatchObject({ nodeId: '0:text:0', baseNodeId: '0:text:0' });
  });

  it('element-resized (same origin, new size) names its baseline node and both boxes', () => {
    const a = snapshot([node({ id: '0:container:0', role: 'container', bbox: { x: 54, y: 54, width: 500, height: 300 } })]);
    const b = snapshot([node({ id: '0:container:0', role: 'container', bbox: { x: 54, y: 54, width: 500, height: 412 } })]);
    const ev = diffSnapshots(a, b).events.find((e) => e.type === 'element-resized');
    expect(ev).toMatchObject({
      nodeId: '0:container:0',
      baseNodeId: '0:container:0',
      fromBBox: { x: 54, y: 54, width: 500, height: 300 },
      toBBox: { x: 54, y: 54, width: 500, height: 412 },
    });
  });

  it('text-overflowed-container carries its box, and the baseline pair when there is one', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'line', bbox: { x: 40, y: 500, width: 400, height: 84 } })]);
    const b = snapshot([node({ id: '0:text:0', text: 'line', bbox: { x: 40, y: 500, width: 400, height: 118.2 }, overflow: { axis: 'y', overflowPts: 14.2, container: 'page-content' } })]);
    const paired = diffSnapshots(a, b).events.find((e) => e.type === 'text-overflowed-container');
    expect(paired).toMatchObject({
      bbox: { x: 40, y: 500, width: 400, height: 118.2 },
      baseNodeId: '0:text:0',
      fromBBox: { x: 40, y: 500, width: 400, height: 84 },
    });

    const c = snapshot([]);
    const d = snapshot([node({ id: '0:text:0', text: 'new', bbox: { x: 1, y: 2, width: 3, height: 4 }, overflow: { axis: 'x', overflowPts: 1, container: 'parent' } })]);
    const unpaired = diffSnapshots(c, d).events.find((e) => e.type === 'text-overflowed-container');
    expect(unpaired).toMatchObject({ bbox: { x: 1, y: 2, width: 3, height: 4 }, baseNodeId: null, fromBBox: null });
  });

  it('element-added and element-removed carry the box of the node they concern', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'keep', bbox: { x: 40, y: 40, width: 200, height: 14 } }), node({ id: '0:text:1', text: 'gone', bbox: { x: 40, y: 60, width: 200, height: 14 } })]);
    const b = snapshot([node({ id: '0:text:0', text: 'keep', bbox: { x: 40, y: 40, width: 200, height: 14 } }), node({ id: '0:text:1', text: 'fresh', bbox: { x: 40, y: 90, width: 200, height: 14 } })]);
    const events = diffSnapshots(a, b).events;
    expect(events.find((e) => e.type === 'element-removed')).toMatchObject({ bbox: { x: 40, y: 60, width: 200, height: 14 } });
    expect(events.find((e) => e.type === 'element-added')).toMatchObject({ bbox: { x: 40, y: 90, width: 200, height: 14 } });
  });

  it('reports how much work the comparison did', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'keep' }), node({ id: '0:text:1', text: 'gone', bbox: { x: 0, y: 40, width: 100, height: 14 } })]);
    const b = snapshot([node({ id: '0:text:0', text: 'keep' })]);
    const r = diffSnapshots(a, b);
    expect(r.stats).toEqual({ baselineNodes: 2, newNodes: 1, pairs: 1, added: 0, removed: 1 });
    const same = diffSnapshots(a, a);
    expect(same.stats).toEqual({ baselineNodes: 2, newNodes: 2, pairs: 2, added: 0, removed: 0 });
  });
});
