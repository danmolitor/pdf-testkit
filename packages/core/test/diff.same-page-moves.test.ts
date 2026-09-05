import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { diffSnapshots, fromFormeLayout } from '@pdf-testkit/core';
import type { SemanticEventType } from '@pdf-testkit/core';
import { node, snapshot } from './helpers';

const types = (events: { type: SemanticEventType }[]): SemanticEventType[] => events.map((e) => e.type);

/**
 * The dogfood-experiment gap (forme, 2026-09-05): same-page movement was only
 * evented for tables, so a running header moving 25pt, a footer moving 8pt,
 * and table cells redistributing 37pt all reported "no semantic changes"
 * against differing content hashes. The changes an engine author spends the
 * most time on move things WITHIN pages, not across them. These tests replay
 * exactly those three shapes, plus the fallback channel: a diff must never
 * say nothing when the content hash says something changed.
 */
describe('same-page movement — non-table elements', () => {
  it('reports a text element moving beyond the threshold on its own page', () => {
    // The letterhead-band shape: 25pt vertical move, same page.
    const a = snapshot([node({ id: '0:text:0', text: 'ACME WIDGET CO.', bbox: { x: 216, y: 13, width: 163, height: 13 } })]);
    const b = snapshot([node({ id: '0:text:0', text: 'ACME WIDGET CO.', bbox: { x: 216, y: 38, width: 163, height: 13 } })]);
    const r = diffSnapshots(a, b);
    const ev = r.events.find((e) => e.type === 'element-moved');
    expect(ev).toBeDefined();
    expect(ev!.message).toMatch(/moved 25pt on page 1/);
  });

  it('reports a cell shifting horizontally (column redistribution)', () => {
    // The zebra shape: table bbox barely moves, cells shift 37pt sideways.
    const a = snapshot([node({ id: '0:cell:0', role: 'cell', text: '$30.00', bbox: { x: 218, y: 100, width: 158, height: 27 } })]);
    const b = snapshot([node({ id: '0:cell:0', role: 'cell', text: '$30.00', bbox: { x: 181, y: 100, width: 121, height: 27 } })]);
    const r = diffSnapshots(a, b);
    expect(types(r.events)).toContain('element-moved');
  });

  it('does NOT fire below the threshold', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'page 2', bbox: { x: 275, y: 40, width: 30, height: 12 } })]);
    const b = snapshot([node({ id: '0:text:0', text: 'page 2', bbox: { x: 275, y: 48, width: 30, height: 12 } })]);
    const r = diffSnapshots(a, b);
    expect(types(r.events)).not.toContain('element-moved');
  });

  it('replays the real letterhead fixture: the band move is named', () => {
    const load = (f: string) =>
      fromFormeLayout(JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')));
    const r = diffSnapshots(load('letterhead-band-before.layout.json'), load('letterhead-band-after.layout.json'));
    expect(r.changed).toBe(true);
    const moved = r.events.filter((e) => e.type === 'element-moved');
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.some((e) => e.message.includes('ACME WIDGET'))).toBe(true);
  });
});

describe('the uncharacterized-change channel', () => {
  it('fires when the hash changed but no nameable event did', () => {
    // The report-footer shape: an 8pt move, below every threshold. A diff
    // that says nothing over a changed hash is a silent failure — the same
    // blind-spot shape the forme corpus campaign named.
    const a = snapshot([node({ id: '0:text:0', text: 'page 2', bbox: { x: 275, y: 40, width: 30, height: 12 } })]);
    const b = snapshot([node({ id: '0:text:0', text: 'page 2', bbox: { x: 275, y: 48, width: 30, height: 12 } })]);
    const r = diffSnapshots(a, b);
    expect(r.changed).toBe(true);
    const ev = r.events.find((e) => e.type === 'uncharacterized-change');
    expect(ev).toBeDefined();
    expect(ev!.message).toMatch(/1 of 1 matched element/);
  });

  it('does not fire when real events exist', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'hello' })], { pageCount: 1 });
    const b = snapshot([node({ id: '0:text:0', text: 'hello' })], { pageCount: 2 });
    const r = diffSnapshots(a, b);
    expect(types(r.events)).not.toContain('uncharacterized-change');
  });

  it('identical snapshots still produce zero events', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'hello' })]);
    const r = diffSnapshots(a, a);
    expect(r.changed).toBe(false);
    expect(r.events).toHaveLength(0);
  });
});
