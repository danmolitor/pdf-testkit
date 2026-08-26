import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { fromPdf, serializeSnapshot } from '@pdf-testkit/core';

const exec = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/pdf-testkit.js', import.meta.url));
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/pdfs/${name}.pdf`, import.meta.url))));

const dir = mkdtempSync(join(tmpdir(), 'pdf-testkit-cli-'));
const invoiceSnap = join(dir, 'invoice.json');
const reportSnap = join(dir, 'report.json');

/** Run the CLI, resolving even on non-zero exit so we can assert the code. */
async function run(args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await exec('node', [BIN, ...args]);
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '' };
  }
}

describe('pdf-testkit CLI', () => {
  beforeAll(async () => {
    writeFileSync(invoiceSnap, serializeSnapshot(await fromPdf(fixture('invoice'))));
    writeFileSync(reportSnap, serializeSnapshot(await fromPdf(fixture('report'))));
  });

  it('exits 0 with no events when diffing a snapshot against itself', async () => {
    const { code, stdout } = await run(['diff', invoiceSnap, invoiceSnap, '--json']);
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.changed).toBe(false);
    expect(result.events).toHaveLength(0);
  });

  it('exits 1 and reports events when documents differ', async () => {
    const { code, stdout } = await run(['diff', invoiceSnap, reportSnap, '--json']);
    expect(code).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.changed).toBe(true);
    expect(result.events.some((e: { type: string }) => e.type === 'page-count-changed')).toBe(true);
  });

  it('honors --fail-on to gate the exit code', async () => {
    // Only warn-level moves between these two would be filtered by a stricter gate.
    const strict = await run(['diff', invoiceSnap, reportSnap, '--fail-on', 'error']);
    expect(strict.code).toBe(1); // page-count-changed is an error
    const anyGate = await run(['diff', invoiceSnap, invoiceSnap, '--fail-on', 'any']);
    expect(anyGate.code).toBe(0);
  });
});
