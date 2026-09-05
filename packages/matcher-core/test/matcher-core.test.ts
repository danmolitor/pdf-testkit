import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FormeLayoutInfo, StructuralSnapshot } from '@pdf-testkit/core';
import { assertMatchesPDFSnapshot, resolveSnapshotPath } from '@pdf-testkit/matcher-core';

const SNAP_DIR = join(tmpdir(), 'pdf-testkit-matcher-core-selftest');

const ctx = { testPath: '/repo/tests/report.test.ts', currentTestName: 'renders', updateMode: false };

function layout(withExtra = false): FormeLayoutInfo {
  const elements = [
    { nodeType: 'Heading', x: 40, y: 40, width: 300, height: 28, style: { fontSize: 24 }, textContent: 'Title' },
    { nodeType: 'Text', x: 40, y: 90, width: 400, height: 14, style: { fontSize: 11 }, textContent: 'Body.' },
  ];
  if (withExtra) {
    elements.push({ nodeType: 'Text', x: 40, y: 120, width: 400, height: 14, style: { fontSize: 11 }, textContent: 'Extra.' });
  }
  return {
    pages: [{ width: 595, height: 842, contentX: 40, contentY: 40, contentWidth: 520, contentHeight: 762, elements }],
  };
}

describe('assertMatchesPDFSnapshot', () => {
  beforeEach(() => rmSync(SNAP_DIR, { recursive: true, force: true }));
  afterEach(() => {
    delete process.env.CI;
    delete process.env.PDF_TESTKIT_UPDATE;
  });

  it('creates a baseline on first run and matches on the next', async () => {
    delete process.env.CI; // ensure not treated as CI
    const first = await assertMatchesPDFSnapshot(layout(), ctx, { snapshotDir: SNAP_DIR, snapshotName: 's' });
    expect(first.pass).toBe(true);
    const second = await assertMatchesPDFSnapshot(layout(), ctx, { snapshotDir: SNAP_DIR, snapshotName: 's' });
    expect(second.pass).toBe(true);
  });

  it('fails on a structural change with a semantic-event message', async () => {
    delete process.env.CI;
    await assertMatchesPDFSnapshot(layout(), ctx, { snapshotDir: SNAP_DIR, snapshotName: 's' });
    const changed = await assertMatchesPDFSnapshot(layout(true), ctx, { snapshotDir: SNAP_DIR, snapshotName: 's' });
    expect(changed.pass).toBe(false);
    expect(changed.message()).toContain('PDF snapshot changed');
  });

  it('refuses to silently create a baseline on CI', async () => {
    process.env.CI = 'true';
    const outcome = await assertMatchesPDFSnapshot(layout(), ctx, { snapshotDir: SNAP_DIR, snapshotName: 'ci' });
    expect(outcome.pass).toBe(false);
    expect(outcome.message()).toContain('No committed PDF baseline');
  });

  it('resolves baseline paths next to the test file', () => {
    const path = resolveSnapshotPath(ctx, {});
    expect(path).toContain('__pdf_snapshots__');
    expect(path).toContain('report.test-renders.json');
  });
});

/**
 * A matcher has no flag surface of its own, so the escape hatch is an env var
 * (matching the `PDF_TESTKIT_UPDATE` precedent). The grouped message is what a
 * developer reads in their terminal; the flat one has to remain reachable.
 */
describe('assertMatchesPDFSnapshot — grouped failure message', () => {
  const fixture = (name: string): string =>
    fileURLToPath(new URL(`../../fixtures/snapshots/${name}.snapshot.json`, import.meta.url));
  const grown = JSON.parse(readFileSync(fixture('invoice-grown'), 'utf8')) as StructuralSnapshot;

  beforeEach(() => {
    rmSync(SNAP_DIR, { recursive: true, force: true });
    mkdirSync(SNAP_DIR, { recursive: true });
    copyFileSync(fixture('invoice-baseline'), resolveSnapshotPath(ctx, { snapshotDir: SNAP_DIR, snapshotName: 'invoice' }));
    delete process.env.CI;
  });
  afterEach(() => delete process.env.PDF_TESTKIT_VERBOSE);

  const assert = () =>
    assertMatchesPDFSnapshot(grown, ctx, { snapshotDir: SNAP_DIR, snapshotName: 'invoice' });

  it('collapses the 135 events and says how to see the rest', async () => {
    const outcome = await assert();
    expect(outcome.pass).toBe(false);
    const msg = outcome.message();
    expect(msg).toContain('PDF snapshot changed (135 semantic events)');
    expect(msg).toContain('129 related events collapsed; set PDF_TESTKIT_VERBOSE=1');
    expect(msg).toContain("following the table's growth");
  });

  it('PDF_TESTKIT_VERBOSE=1 restores the full flat list', async () => {
    process.env.PDF_TESTKIT_VERBOSE = '1';
    const msg = (await assert()).message();
    expect(msg).not.toContain('collapsed');
    // One line per event plus the header and the two-line footer block.
    expect(msg.split('\n').filter((l) => l.startsWith('  ⚠ ') || l.startsWith('  ✗ '))).toHaveLength(135);
  });
});
