import { describe, it, expect } from 'vitest';
import type { DiffResult } from '@pdf-testkit/core';
import { COMMENT_MARKER, renderMarkdown, shouldFail } from '../src/render.js';

const clean: DiffResult = { changed: false, events: [], baselineHash: 'sha256:a', newHash: 'sha256:a' };

const changed: DiffResult = {
  changed: true,
  baselineHash: 'sha256:a',
  newHash: 'sha256:b',
  events: [
    { type: 'page-count-changed', severity: 'error', confidence: 1, from: 2, to: 3, message: 'page count changed 2 → 3' },
    {
      type: 'table-moved',
      severity: 'warn',
      confidence: 0.5,
      nodeId: '1:table:0',
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
    expect(md).toContain('0.50'); // confidence column
  });
});

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
