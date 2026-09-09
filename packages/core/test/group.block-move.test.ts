import { describe, it, expect } from 'vitest';
import { diffSnapshots, groupEvents } from '@pdf-testkit/core';
import { node, snapshot } from './helpers';

/**
 * Regression (extraction-fidelity experiment, 2026-09-09, finding F4): when
 * two contract sections swapped places, the LayoutInfo path reported one
 * "container moved 92pt" line per wrapper and one per clause, 48 singles, and
 * the headline named a wrapper. The pdfjs path, having no wrappers, named the
 * heading. A container that moved with everything inside it is one block, and
 * the block is named by its heading.
 */
describe('a container that moved with its contents is one block, named by its heading', () => {
  const section = (dy: number) => [
    node({ id: '1:container:0', role: 'container', pageIndex: 1, order: 10, bbox: { x: 57, y: 364 + dy, width: 498, height: 80 } }),
    node({ id: '1:heading:0', role: 'heading', headingLevel: 2, pageIndex: 1, order: 11, parentId: '1:container:0', text: '6 Confidentiality', bbox: { x: 57, y: 364 + dy, width: 498, height: 8 } }),
    node({ id: '1:container:1', role: 'container', pageIndex: 1, order: 12, parentId: '1:container:0', bbox: { x: 57, y: 384 + dy, width: 498, height: 24 } }),
    node({ id: '1:text:0', pageIndex: 1, order: 13, parentId: '1:container:1', text: '6.1', bbox: { x: 57, y: 384 + dy, width: 27, height: 11 } }),
    node({ id: '1:text:1', pageIndex: 1, order: 14, parentId: '1:container:1', text: 'The Employee shall not, during employment, disclose confidential information.', bbox: { x: 90, y: 384 + dy, width: 465, height: 24 } }),
  ];
  const untouched = [node({ id: '1:text:9', pageIndex: 1, order: 40, text: 'Signed for the Employer', bbox: { x: 57, y: 700, width: 200, height: 11 } })];

  it('groups every element that moved by the block delta under the heading', () => {
    const base = snapshot([...section(0), ...untouched], { pageCount: 2 });
    const next = snapshot([...section(92), ...untouched], { pageCount: 2 });
    const r = diffSnapshots(base, next);
    expect(r.events.filter((e) => e.type === 'element-moved')).toHaveLength(5);
    const groups = groupEvents(base, next, r.events);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('block-moved');
    expect(groups[0]!.summary).toBe('section "6 Confidentiality" moved 92pt on page 2 (4 elements with it)');
    expect(groups[0]!.root.type).toBe('element-moved');
    expect(groups[0]!.events).toHaveLength(5);
  });

  it('a wrapper that moved alone stays a single', () => {
    const base = snapshot([node({ id: '0:container:0', role: 'container', bbox: { x: 40, y: 40, width: 200, height: 20 } })]);
    const next = snapshot([node({ id: '0:container:0', role: 'container', bbox: { x: 40, y: 100, width: 200, height: 20 } })]);
    const r = diffSnapshots(base, next);
    const groups = groupEvents(base, next, r.events);
    expect(groups.map((g) => g.kind)).toEqual(['single']);
  });
});
