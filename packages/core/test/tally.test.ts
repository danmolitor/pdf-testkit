import { describe, expect, it } from 'vitest';
import { causeTally, diffSnapshots, groupEvents, type EventGroup, type SemanticEvent } from '@pdf-testkit/core';
import { node, snapshot } from './helpers';

const ev = (type: SemanticEvent['type'], severity: SemanticEvent['severity']): SemanticEvent =>
  ({ type, severity, message: '', confidence: 1, nodeId: 'x' }) as SemanticEvent;
const group = (root: SemanticEvent, members: SemanticEvent[] = []): EventGroup => ({ kind: members.length ? 'table-resized' : 'single', root, severity: root.severity, summary: '', events: [root, ...members] });

/**
 * A tally counts CAUSES, not events. A table that grew and pushed twenty cells
 * sideways is one warning, not twenty-one: counting the cascade trains a
 * reviewer to click through, which is the failure this tool exists to prevent.
 */
describe('causeTally', () => {
  it('counts one per group at the root severity, and reports events separately', () => {
    const table = ev('table-moved', 'warn');
    const cells = Array.from({ length: 20 }, () => ev('element-moved', 'warn'));
    const pages = ev('page-count-changed', 'error');
    const furniture = [ev('element-added', 'warn'), ev('element-added', 'warn')];
    const lone = ev('uncharacterized-change', 'info');
    const t = causeTally([group(pages, furniture), group(table, cells), group(lone)]);
    expect(t).toEqual({ errors: 1, warnings: 1, info: 1, causes: 3, events: 25 });
  });

  it('a cascade never contributes warnings of its own: the real invoice diff is a handful of causes, not 146 warnings', () => {
    const a = snapshot([node({ id: '0:table:0', role: 'table', table: { rows: 6, cols: 4 } })], { pageCount: 2 });
    const b = snapshot([node({ id: '0:table:0', role: 'table', table: { rows: 21, cols: 5 }, bbox: { x: 0, y: 0, width: 100, height: 400 } })], { pageCount: 3 });
    const r = diffSnapshots(a, b);
    const t = causeTally(groupEvents(a, b, r.events));
    expect(t.events).toBe(r.events.length);
    expect(t.causes).toBeLessThanOrEqual(r.events.length);
    expect(t.errors + t.warnings + t.info).toBe(t.causes);
  });

  it('is empty for no groups', () => {
    expect(causeTally([])).toEqual({ errors: 0, warnings: 0, info: 0, causes: 0, events: 0 });
  });
});
