import { describe, it, expect } from 'vitest';
import { diffSnapshots, fromFormeLayout } from '@pdf-testkit/core';
import { node, snapshot, sampleLayout } from './helpers';

/**
 * The negative direction is the entire pitch of the tool: harmless changes must
 * NOT be flagged. Each case must produce zero (or info-only) events. These carry
 * equal weight to the positive-direction tests and must never be trimmed.
 */
describe('diff engine — harmless changes are NOT flagged', () => {
  it('reordering two untouched paragraphs on a page produces no churn', () => {
    const p1 = { text: 'first paragraph', bbox: { x: 40, y: 40, width: 200, height: 14 } };
    const p2 = { text: 'second paragraph', bbox: { x: 40, y: 60, width: 200, height: 14 } };
    const a = snapshot([node({ id: '0:text:0', ...p1 }), node({ id: '0:text:1', ...p2 })]);
    // Same content, order swapped in the node array.
    const b = snapshot([node({ id: '0:text:0', ...p2 }), node({ id: '0:text:1', ...p1 })]);
    const r = diffSnapshots(a, b);
    expect(r.events.filter((e) => e.severity !== 'info')).toEqual([]);
  });

  it('treats whitespace/case-only edits as unchanged', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'Hello   World' })]);
    const b = snapshot([node({ id: '0:text:0', text: 'hello world' })]);
    const r = diffSnapshots(a, b);
    expect(r.changed).toBe(false);
  });

  it('treats a trailing-punctuation edit at the same slot as unchanged', () => {
    const box = { x: 40, y: 40, width: 200, height: 14 };
    const a = snapshot([node({ id: '0:text:0', text: 'Total', bbox: box })]);
    const b = snapshot([node({ id: '0:text:0', text: 'Total:', bbox: box })]);
    const r = diffSnapshots(a, b);
    // Same role, same page, same box -> matched as the same element -> no churn.
    expect(r.events.some((e) => e.type === 'element-added' || e.type === 'element-removed')).toBe(false);
  });

  it('ignores sub-threshold position jitter on the same page', () => {
    const a = snapshot([
      node({ id: '0:table:0', role: 'table', table: { rows: 2, cols: 3 }, bbox: { x: 40, y: 160, width: 400, height: 40 } }),
    ]);
    const b = snapshot([
      node({ id: '0:table:0', role: 'table', table: { rows: 2, cols: 3 }, bbox: { x: 42, y: 161, width: 400, height: 40 } }),
    ]);
    const r = diffSnapshots(a, b);
    expect(r.events.some((e) => e.type === 'table-moved')).toBe(false);
  });

  it('reports no change when re-diffing the identical document', () => {
    const snap = fromFormeLayout(sampleLayout());
    const r = diffSnapshots(snap, snap);
    expect(r.changed).toBe(false);
    expect(r.events).toEqual([]);
    expect(r.baselineHash).toBe(r.newHash);
  });

  it('suppresses low-confidence heuristic flicker via minConfidence', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'stable' })]);
    const b = snapshot([
      node({ id: '0:text:0', text: 'stable' }),
      // A heuristic table pdfjs "found" this run only — confidence 0.5.
      node({ id: '0:table:0', role: 'table', confidence: 0.5, table: { rows: 3, cols: 2 }, bbox: { x: 40, y: 200, width: 300, height: 60 } }),
    ]);
    const noisy = diffSnapshots(a, b);
    expect(noisy.events.some((e) => e.type === 'element-added')).toBe(true);
    const filtered = diffSnapshots(a, b, { minConfidence: 0.6 });
    expect(filtered.changed).toBe(false);
  });
});
