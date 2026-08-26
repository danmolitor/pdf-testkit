import { basename, dirname, join } from 'node:path';
import type { MatcherContext, PdfSnapshotOptions } from './types.js';

/** `<testDir>/__pdf_snapshots__/<testFile>-<name>.json`. */
export function resolveSnapshotPath(ctx: MatcherContext, opts: PdfSnapshotOptions): string {
  const dir = opts.snapshotDir ?? join(dirname(ctx.testPath), '__pdf_snapshots__');
  const file = basename(ctx.testPath).replace(/\.[cm]?[jt]sx?$/i, '');
  const name = slug(opts.snapshotName ?? ctx.snapshotName ?? ctx.currentTestName ?? 'snapshot');
  return join(dir, `${file}-${name}.json`);
}

/**
 * Update mode is honored from the framework flag (-u/--update) OR the
 * `PDF_TESTKIT_UPDATE` env var. The env var is a version-proof fallback for when
 * a framework changes how it exposes its update flag internally.
 */
export function isUpdateMode(ctx: MatcherContext): boolean {
  const env = process.env.PDF_TESTKIT_UPDATE;
  return ctx.updateMode || env === '1' || env === 'true';
}

export function isCI(): boolean {
  return Boolean(process.env.CI) && process.env.CI !== 'false';
}

function slug(s: string): string {
  return (
    s
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'snapshot'
  );
}
