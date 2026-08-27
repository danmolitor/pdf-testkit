import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import {
  diffSnapshots,
  fromFormeLayout,
  fromPdf,
  groupEvents,
  readSnapshotFile,
  writeSnapshotFile,
  type FormeLayoutInfo,
  type StructuralSnapshot,
} from '@pdf-testkit/core';
import { isCI, isUpdateMode, resolveSnapshotPath } from './config.js';
import { formatFailure } from './format.js';
import type { MatcherContext, MatcherInput, MatcherOutcome, PdfSnapshotOptions } from './types.js';

/**
 * The single implementation of `toMatchPDFSnapshot`, shared verbatim by the Jest
 * and Vitest adapters — only the way `ctx` is gathered differs between them.
 */
export async function assertMatchesPDFSnapshot(
  received: MatcherInput,
  ctx: MatcherContext,
  opts: PdfSnapshotOptions = {},
): Promise<MatcherOutcome> {
  const snapshot = await toSnapshot(received);
  const path = resolveSnapshotPath(ctx, opts);
  const update = isUpdateMode(ctx);
  const exists = await fileExists(path);

  if (!exists) {
    // No baseline. Creating one silently on CI would defeat the check, so fail
    // there; locally, first run captures the baseline (standard snapshot flow).
    if (isCI() && !update) {
      return {
        pass: false,
        message: () =>
          `No committed PDF baseline at ${path}. ` +
          `Run the test locally to create it, then commit the baseline.`,
      };
    }
    await writeSnapshotFile(path, snapshot);
    return { pass: true, message: () => `Wrote new PDF baseline at ${path}` };
  }

  if (update) {
    await writeSnapshotFile(path, snapshot);
    return { pass: true, message: () => `Updated PDF baseline at ${path}` };
  }

  const baseline = await readSnapshotFile(path);
  const result = diffSnapshots(baseline, snapshot, opts);
  const blocking = result.events.filter((e) => e.severity !== 'info');
  const pass = blocking.length === 0;
  return {
    pass,
    message: () =>
      pass
        ? 'PDF snapshot matched'
        : formatFailure(result.events, path, isVerbose() ? null : groupEvents(baseline, snapshot, result.events, opts)),
  };
}

function isVerbose(): boolean {
  const v = process.env.PDF_TESTKIT_VERBOSE;
  return v === '1' || v === 'true';
}

async function toSnapshot(received: MatcherInput): Promise<StructuralSnapshot> {
  if (isSnapshot(received)) return received;
  if (isLayoutInfo(received)) return fromFormeLayout(received);
  if (received instanceof Uint8Array) return fromPdf(received);
  if (received instanceof ArrayBuffer) return fromPdf(new Uint8Array(received));
  if (isPathInput(received)) {
    if (received.path.endsWith('.json')) return readSnapshotFile(received.path);
    const bytes = await readFile(received.path);
    return fromPdf(new Uint8Array(bytes));
  }
  throw new Error(
    'toMatchPDFSnapshot: unsupported input. Pass a PDF (Uint8Array/ArrayBuffer), ' +
      'a FormePDF LayoutInfo, a StructuralSnapshot, or { path }.',
  );
}

function isSnapshot(value: MatcherInput): value is StructuralSnapshot {
  return (
    isObject(value) && 'contentHash' in value && 'nodes' in value && 'version' in value
  );
}

function isLayoutInfo(value: MatcherInput): value is FormeLayoutInfo {
  if (!isObject(value) || !('pages' in value)) return false;
  const pages = (value as { pages: unknown }).pages;
  if (!Array.isArray(pages)) return false;
  return pages.length === 0 || (isObject(pages[0]) && 'elements' in pages[0]);
}

function isPathInput(value: MatcherInput): value is { path: string } {
  return isObject(value) && typeof (value as { path?: unknown }).path === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
