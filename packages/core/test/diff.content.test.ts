import { describe, it, expect } from 'vitest';
import { diffSnapshots } from '@pdf-testkit/core';
import { node, snapshot } from './helpers';

/**
 * `element-content-changed` — the opt-in text-edit event (F1). Structural
 * diffing stays silent on a value change at a stable slot by design; this event
 * is how a caller who *wants* to catch the wrong-total case turns it on. The
 * load-bearing property is that it stays narrow: it fires only on matched pairs,
 * so added/removed content is never reclassified as a content edit.
 */
describe('diff engine — element-content-changed (opt-in content diff)', () => {
  const box = { x: 40, y: 120, width: 120, height: 14 };
  const cell = (text: string) => node({ id: '0:cell:0', role: 'cell', text, bbox: box });

  it('is silent by default: a value edit at a stable slot fires nothing', () => {
    const r = diffSnapshots(snapshot([cell('$1,250.00')]), snapshot([cell('$1,450.00')]));
    expect(r.events).toHaveLength(0);
  });

  it('fires under the opt-in, at warn, with before/after previews', () => {
    const r = diffSnapshots(snapshot([cell('$1,250.00')]), snapshot([cell('$1,450.00')]), {
      contentChanges: true,
    });
    const content = r.events.filter((e) => e.type === 'element-content-changed');
    expect(content).toHaveLength(1);
    const e = content[0]!;
    expect(e.severity).toBe('warn');
    if (e.type !== 'element-content-changed') throw new Error('narrowing');
    expect(e.fromTextPreview).toBe('$1,250.00');
    expect(e.toTextPreview).toBe('$1,450.00');
    expect(e.nodeId).toBe('0:cell:0');
    expect(e.baseNodeId).toBe('0:cell:0');
  });

  it('does not reclassify added content: an added node stays element-added', () => {
    // Baseline: one paragraph. Changed: that paragraph edited in place, PLUS a
    // brand-new paragraph below it. The edit is a content change; the new
    // paragraph is an addition — the opt-in must not turn the latter into the
    // former (the narrowness that keeps a growing invoice's new rows out).
    const kept = { bbox: { x: 40, y: 40, width: 300, height: 14 } };
    const base = snapshot([node({ id: '0:text:0', text: 'balance due 1250', ...kept })]);
    const next = snapshot([
      node({ id: '0:text:0', text: 'balance due 1450', ...kept }),
      node({ id: '0:text:1', text: 'thank you for your business', bbox: { x: 40, y: 60, width: 300, height: 14 } }),
    ]);
    const r = diffSnapshots(base, next, { contentChanges: true });
    expect(r.events.filter((e) => e.type === 'element-content-changed')).toHaveLength(1);
    expect(r.events.filter((e) => e.type === 'element-added')).toHaveLength(1);
    // The added node is never also reported as a content change.
    const added = r.events.find((e) => e.type === 'element-added')!;
    const contentIds = r.events.filter((e) => e.type === 'element-content-changed').map((e) => (e as { nodeId: string }).nodeId);
    expect(contentIds).not.toContain((added as { nodeId: string }).nodeId);
  });

  it('honours severityOverrides for callers who want a content edit to fail hard', () => {
    const r = diffSnapshots(snapshot([cell('100')]), snapshot([cell('200')]), {
      contentChanges: true,
      severityOverrides: { 'element-content-changed': 'error' },
    });
    const e = r.events.find((e) => e.type === 'element-content-changed');
    expect(e?.severity).toBe('error');
  });

  it('does not fire on a whitespace/case-only edit (normText unchanged)', () => {
    const r = diffSnapshots(snapshot([cell('Total  DUE')]), snapshot([cell('total due')]), {
      contentChanges: true,
    });
    expect(r.changed).toBe(false);
  });
});
