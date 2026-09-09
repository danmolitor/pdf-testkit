import { describe, it, expect } from 'vitest';
import { diffSnapshots } from '@pdf-testkit/core';
import { node, snapshot } from './helpers';

/**
 * Regression (extraction-fidelity experiment, 2026-09-09, finding F1): every
 * LayoutInfo diff carried four to twenty false container events that led the
 * headline. A number-only change on a statement produced "container moved
 * 166pt on page 1; container shrank 25pt shorter and 332pt narrower".
 *
 * Cause: the fixed footer's wrapper (498×41), its inner row (498×16) and its
 * right-hand cell (166×16) share one centre point. All text-less containers
 * keyed as `container||`, so they were one bucket, and the same-slot pass
 * took the LAST candidate within tolerance (`d <= bestD`), pairing the wrapper
 * with the cell and the cell with the wrapper. The "movement" and "resize"
 * reported were the difference between two boxes that never changed.
 */
describe('anonymous containers that share a centre are not cross-paired', () => {
  // The Northmoor footer, to the point: three concentric boxes around (306, 772)
  // plus the two text runs inside them.
  const footer = (suffix: string) => [
    node({ id: '0:container:41', role: 'container', order: 160, bbox: { x: 57, y: 752, width: 498, height: 41 } }),
    node({ id: '0:container:42', role: 'container', order: 161, parentId: '0:container:41', bbox: { x: 57, y: 752, width: 498, height: 41 } }),
    node({ id: '0:container:43', role: 'container', order: 162, parentId: '0:container:42', bbox: { x: 57, y: 764, width: 498, height: 16 } }),
    node({ id: '0:container:44', role: 'container', order: 163, parentId: '0:container:43', bbox: { x: 57, y: 764, width: 332, height: 16 } }),
    node({ id: '0:text:20', order: 164, parentId: '0:container:44', text: `Statement · account BW-0091 · 07 September 2026${suffix}`, bbox: { x: 57, y: 766, width: 200, height: 8 } }),
    node({ id: '0:container:45', role: 'container', order: 165, parentId: '0:container:43', bbox: { x: 223, y: 764, width: 166, height: 16 } }),
    node({ id: '0:text:21', order: 166, parentId: '0:container:45', text: 'Page 1 of 1', bbox: { x: 350, y: 766, width: 39, height: 8 } }),
  ];
  const body = (total: string) => [
    node({ id: '0:heading:0', role: 'heading', headingLevel: 1, order: 0, text: 'Statement of account', bbox: { x: 57, y: 60, width: 300, height: 24 } }),
    node({ id: '0:text:0', order: 1, text: 'Total outstanding', bbox: { x: 250, y: 300, width: 100, height: 10 } }),
    node({ id: '0:text:1', order: 2, text: total, bbox: { x: 480, y: 300, width: 60, height: 10 } }),
  ];

  it('a number-only change produces no container events at all', () => {
    const base = snapshot([...body('35,731.24'), ...footer('')]);
    const next = snapshot([...body('41,731.24'), ...footer('')]);
    const r = diffSnapshots(base, next);
    const containerEvents = r.events.filter((e) => 'role' in e && e.role === 'container');
    expect(containerEvents.map((e) => e.message)).toEqual([]);
  });

  it('a container that genuinely moves still reports, as itself', () => {
    const base = snapshot([...body('35,731.24'), ...footer('')]);
    // The whole footer block sits 30pt higher: every box in it moves together.
    const moved = footer('').map((n) => ({ ...n, bbox: { ...n.bbox, y: n.bbox.y - 30 } }));
    const next = snapshot([...body('35,731.24'), ...moved]);
    const r = diffSnapshots(base, next);
    const moves = r.events.filter((e) => e.type === 'element-moved');
    // Every footer element moved 30pt; nothing was resized, nothing was cross-paired.
    expect(moves.every((e) => 'distancePts' in e && e.distancePts === 30)).toBe(true);
    expect(moves.length).toBe(footer('').length);
    expect(r.events.filter((e) => e.type === 'element-resized')).toEqual([]);
  });
});
