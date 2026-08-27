import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FormeLayoutInfo } from '@pdf-testkit/core';
import '@pdf-testkit/vitest';

const SNAP_DIR = join(tmpdir(), 'pdf-testkit-vitest-selftest');
const NAME = 'shared-baseline';

function layout(variant: 'base' | 'structural-change'): FormeLayoutInfo {
  const elements = [
    {
      nodeType: 'Heading',
      x: 40,
      y: 40,
      width: 300,
      height: 28,
      style: { fontSize: 24, fontWeight: 700 },
      textContent: 'Quarterly Results',
    },
    {
      nodeType: 'Text',
      x: 40,
      y: 90,
      width: 400,
      height: 14,
      style: { fontSize: 11 },
      textContent: 'Body copy that stays the same.',
    },
  ];
  // A genuinely structural change: a new element appears (not just edited text,
  // which the positional-match fallback intentionally treats as the same slot).
  if (variant === 'structural-change') {
    elements.push({
      nodeType: 'Heading',
      x: 40,
      y: 130,
      width: 200,
      height: 20,
      style: { fontSize: 18, fontWeight: 700 },
      textContent: 'Newly Added Section',
    });
  }
  return {
    pages: [
      {
        width: 595,
        height: 842,
        contentX: 40,
        contentY: 40,
        contentWidth: 520,
        contentHeight: 762,
        elements,
      },
    ],
  };
}

describe('toMatchPDFSnapshot (vitest adapter, self-referential)', () => {
  // This suite exercises the LOCAL create -> match -> change -> accept flow,
  // which requires the matcher to write baselines. On CI the matcher
  // deliberately refuses to create a missing baseline (that guard is covered by
  // matcher-core.test.ts), so isolate this suite from the CI env var.
  let savedCI: string | undefined;
  beforeAll(() => {
    savedCI = process.env.CI;
    delete process.env.CI;
    rmSync(SNAP_DIR, { recursive: true, force: true });
  });
  afterAll(() => {
    if (savedCI === undefined) delete process.env.CI;
    else process.env.CI = savedCI;
  });

  it('creates a baseline on first run and matches on the second', async () => {
    await expect(layout('base')).toMatchPDFSnapshot({
      snapshotDir: SNAP_DIR,
      snapshotName: NAME,
    });
    // Second run compares against the just-written baseline and passes.
    await expect(layout('base')).toMatchPDFSnapshot({
      snapshotDir: SNAP_DIR,
      snapshotName: NAME,
    });
  });

  it('fails when the document structurally changes', async () => {
    // A newly-added element is a structural change and must fail the snapshot.
    const pending = expect(layout('structural-change')).toMatchPDFSnapshot({
      snapshotDir: SNAP_DIR,
      snapshotName: NAME,
    });
    await expect(pending).rejects.toThrow(/PDF snapshot changed/);
  });

  it('accepts the change under PDF_TESTKIT_UPDATE=1', async () => {
    process.env.PDF_TESTKIT_UPDATE = '1';
    try {
      await expect(layout('structural-change')).toMatchPDFSnapshot({
        snapshotDir: SNAP_DIR,
        snapshotName: NAME,
      });
    } finally {
      delete process.env.PDF_TESTKIT_UPDATE;
    }
    // Baseline was rewritten; the new content now matches.
    await expect(layout('structural-change')).toMatchPDFSnapshot({
      snapshotDir: SNAP_DIR,
      snapshotName: NAME,
    });
  });
});
