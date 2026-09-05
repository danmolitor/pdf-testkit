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

/**
 * Grouping is presentation only. The exit code and `--json` are the machine
 * contract and must not notice it; `--verbose` must expand back to the exact
 * flat list, or the "collapsed" footer is a lie.
 */
describe('pdf-testkit CLI — event grouping', () => {
  const snapshotFixture = (name: string): string =>
    fileURLToPath(new URL(`../../fixtures/snapshots/${name}.snapshot.json`, import.meta.url));
  const baseline = snapshotFixture('invoice-baseline');
  const grown = snapshotFixture('invoice-grown');

  it('summarises the 146-event invoice diff by default', async () => {
    const { code, stdout } = await run(['diff', baseline, grown]);
    expect(code).toBe(1);
    expect(stdout).toContain('1 error, 5 warnings · 6 causes, 146 events');
    expect(stdout).toContain('140 related events collapsed; re-run with --verbose');
    // header + 6 group lines + blank + footer.
    expect(stdout.trim().split('\n')).toHaveLength(9);
  });

  it('--verbose prints every event and no grouping', async () => {
    const { stdout } = await run(['diff', baseline, grown, '--verbose']);
    expect(stdout).toContain('146 semantic changes');
    expect(stdout).not.toContain('groups');
    expect(stdout).not.toContain('collapsed');
    expect(stdout.trim().split('\n')).toHaveLength(147); // header + 146 events
  });

  it('--json is untouched by grouping', async () => {
    const { stdout } = await run(['diff', baseline, grown, '--json']);
    const result = JSON.parse(stdout);
    expect(result.events).toHaveLength(146);
  });

  it('gates the exit code on the full event list, not the group count', async () => {
    // 6 groups but one of them is error-severity: the gate must still fire.
    const { code } = await run(['diff', baseline, grown, '--fail-on', 'error']);
    expect(code).toBe(1);
  });
});

describe('pdf-testkit render-pages', () => {
  it('writes one WebP per page and prints a manifest', async () => {
    const out = join(dir, 'pages');
    const pdf = fileURLToPath(new URL('../../fixtures/pdfs/invoice.pdf', import.meta.url));
    const { code, stdout } = await run(['render-pages', pdf, '--out', out, '--dpi', '72', '--json']);
    expect(code).toBe(0);
    const manifest = JSON.parse(stdout);
    expect(manifest.dpi).toBe(72);
    expect(manifest.format).toBe('image/webp');
    expect(manifest.rendererId).toMatch(/^pdfjs-/);
    expect(manifest.pages.length).toBeGreaterThan(0);
    for (const p of manifest.pages) {
      const bytes = readFileSync(join(out, p.file));
      expect(bytes.length).toBe(p.byteSize);
      expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('exits 2 on an unreadable input', async () => {
    const { code } = await run(['render-pages', join(dir, 'nope.pdf'), '--out', join(dir, 'x')]);
    expect(code).toBe(2);
  });
});

describe('pdf-testkit check-determinism', () => {
  const invoicePdf = fileURLToPath(new URL('../../fixtures/pdfs/invoice.pdf', import.meta.url));

  it('exits 0 and says so when two renders extract identically', async () => {
    const out = join(dir, 'det-stable.pdf');
    const { code, stdout } = await run(['check-determinism', out, '--cmd', `cp "${invoicePdf}" "${out}"`]);
    expect(code).toBe(0);
    expect(stdout).toContain('deterministic');
  });

  // A "producer" that stamps today's date into the document, like a fixture
  // that embeds `new Date()`. Back-to-back it passes; with a clock offset the
  // second render lands on a different day and the field is exposed.
  const datedProducer = (out: string): string =>
    `node -e "const d=new Date().toISOString().slice(0,10);` +
    `const doc={pages:[{width:595,height:842,contentX:40,contentY:40,contentWidth:520,contentHeight:762,elements:[` +
    `{nodeType:'Heading',x:40,y:40,width:300,height:28,style:{fontSize:24,fontWeight:700},textContent:'Invoice'},` +
    `{nodeType:'Text',x:40,y:80,width:300,height:14,style:{fontSize:11},textContent:'Issued '+d}]}]};` +
    `require('fs').writeFileSync(process.argv[1],JSON.stringify(doc))" "${out}"`;

  it('passes a date-stamped fixture back-to-back but exposes it with --clock-offset', async () => {
    const out = join(dir, 'det-dated.json');
    const same = await run(['check-determinism', out, '--cmd', datedProducer(out)]);
    expect(same.code).toBe(0);

    const shifted = await run(['check-determinism', out, '--cmd', datedProducer(out), '--clock-offset', '26h', '--json']);
    expect(shifted.code).toBe(1);
    const report = JSON.parse(shifted.stdout);
    expect(report.deterministic).toBe(false);
    expect(report.differences).toHaveLength(1);
    expect(report.differences[0]).toMatchObject({ path: expect.stringContaining('text'), field: 'text' });
    expect(report.differences[0].before).toMatch(/^Issued \d{4}-\d{2}-\d{2}$/);
    expect(report.differences[0].after).toMatch(/^Issued \d{4}-\d{2}-\d{2}$/);
    expect(report.differences[0].before).not.toBe(report.differences[0].after);
  });

  it('names the differing node and both values in the human output', async () => {
    const out = join(dir, 'det-dated2.json');
    const { code, stdout } = await run(['check-determinism', out, '--cmd', datedProducer(out), '--clock-offset', '26h']);
    expect(code).toBe(1);
    expect(stdout).toContain('not deterministic');
    expect(stdout).toContain('Issued ');
    expect(stdout).toContain('→');
  });

  it('exits 2 when the render command fails', async () => {
    const out = join(dir, 'det-fail.pdf');
    const { code } = await run(['check-determinism', out, '--cmd', 'exit 7']);
    expect(code).toBe(2);
  });

  it('rejects a malformed --clock-offset', async () => {
    const out = join(dir, 'det-bad.pdf');
    const { code } = await run(['check-determinism', out, '--cmd', `cp "${invoicePdf}" "${out}"`, '--clock-offset', 'soon']);
    expect(code).toBe(2);
  });
});
