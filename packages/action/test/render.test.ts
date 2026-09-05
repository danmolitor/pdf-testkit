import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { diffSnapshots, groupEvents, type DiffResult, type StructuralSnapshot } from '@pdf-testkit/core';
import { COMMENT_MARKER, renderMarkdown, shouldFail } from '../src/render.js';

const stats = { baselineNodes: 0, newNodes: 0, pairs: 0, added: 0, removed: 0 };
const clean: DiffResult = { changed: false, events: [], baselineHash: 'sha256:a', newHash: 'sha256:a', stats };

const changed: DiffResult = {
  changed: true,
  baselineHash: 'sha256:a',
  newHash: 'sha256:b',
  stats,
  events: [
    { type: 'page-count-changed', severity: 'error', confidence: 1, from: 2, to: 3, message: 'page count changed 2 → 3' },
    {
      type: 'table-moved',
      severity: 'warn',
      confidence: 0.5,
      nodeId: '1:table:0',
      baseNodeId: '0:table:0',
      fromPage: 0,
      toPage: 1,
      fromBBox: { x: 0, y: 0, width: 1, height: 1 },
      toBBox: { x: 0, y: 0, width: 1, height: 1 },
      message: 'table moved from page 1 to page 2',
    },
  ],
};

describe('action markdown rendering', () => {
  it('renders a clean result with the marker', () => {
    const md = renderMarkdown('invoice.pdf', clean);
    expect(md).toContain(COMMENT_MARKER);
    expect(md).toContain('No semantic changes');
  });

  it('renders a table of events with count and confidence', () => {
    const md = renderMarkdown('invoice.pdf', changed);
    expect(md).toContain(COMMENT_MARKER);
    expect(md).toContain('**2** semantic changes');
    expect(md).toContain('`page-count-changed`');
    expect(md).toContain('`table-moved`');
    expect(md).toContain('| Confidence |');
    expect(md).toContain('0.50');
  });

  it('drops the Confidence column when nothing was inferred', () => {
    // FormePDF is authoritative end to end, so the column would be blank on
    // every row — four empty cells is worse than three honest ones.
    const authoritative: DiffResult = {
      ...changed,
      events: changed.events.map((e) => ({ ...e, confidence: 1 })),
    };
    const md = renderMarkdown('invoice.pdf', authoritative);
    expect(md).not.toContain('Confidence');
    expect(md).toContain('| | Event | Detail |');
    // Rows must match the narrower header, not trail an empty cell.
    for (const line of md.split('\n').filter((l) => l.startsWith('| 🔴 ') || l.startsWith('| 🟡 '))) {
      expect(line.split('|')).toHaveLength(5); // '', severity, type, detail, ''
    }
  });
});

describe('action markdown rendering — grouped', () => {
  const snap = (name: string): StructuralSnapshot =>
    JSON.parse(
      readFileSync(new URL(`../../fixtures/snapshots/${name}.snapshot.json`, import.meta.url), 'utf8'),
    ) as StructuralSnapshot;
  const base = snap('invoice-baseline');
  const next = snap('invoice-grown');
  const result = diffSnapshots(base, next);
  const groups = groupEvents(base, next, result.events);
  const md = renderMarkdown('invoice.pdf', result, groups);

  it('replaces 146 rows with one row per cause', () => {
    expect(md).toContain('**1 error, 5 warnings** · **6** causes, 146 events');
    expect(md).toContain('issues/1');
    // The main table: header, separator, then exactly one row per group.
    const rows = md.split('\n').filter((l) => l.startsWith('| 🔴 ') || l.startsWith('| 🟡 '));
    expect(rows.length).toBeGreaterThan(groups.length);
    expect(md).toContain("following the table's growth");
  });

  it('keeps every event one click away instead of discarding it', () => {
    // A <details> block per multi-event group — GitHub renders these natively.
    const multi = groups.filter((g) => g.events.length > 1);
    expect(md.match(/<details>/g)).toHaveLength(multi.length);
    for (const g of multi) expect(md).toContain(`— ${g.events.length} events</summary>`);
    // Every individual message still appears somewhere in the comment body.
    for (const e of result.events) expect(md).toContain(e.message.replace(/\|/g, '\\|'));
  });

  it('uses the same column set in the summary table and every details block', () => {
    // This diff is pure FormePDF, so the column is dropped everywhere.
    expect(md).not.toContain('Confidence');
    expect(md.match(/\| \| Event \| Detail \|/g)).toHaveLength(multiGroupCount(groups) + 1);
  });

  it('renders the flat list unchanged when no groups are supplied', () => {
    const flat = renderMarkdown('invoice.pdf', result);
    expect(flat).toContain('**146** semantic changes detected:');
    expect(flat).not.toContain('<details>');
  });
});

const multiGroupCount = (groups: { events: unknown[] }[]): number =>
  groups.filter((g) => g.events.length > 1).length;

describe('action fail-on gating', () => {
  it('gates on error by default', () => {
    expect(shouldFail(changed, 'error')).toBe(true);
    expect(shouldFail(clean, 'error')).toBe(false);
  });

  it('any-gate fails on a warn-only diff', () => {
    const warnOnly: DiffResult = { ...changed, events: [changed.events[1]!] };
    expect(shouldFail(warnOnly, 'error')).toBe(false);
    expect(shouldFail(warnOnly, 'warn')).toBe(true);
    expect(shouldFail(warnOnly, 'any')).toBe(true);
  });
});
