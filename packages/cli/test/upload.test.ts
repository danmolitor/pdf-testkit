import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '@pdf-testkit/protocol/testing';
import { runUpload, type UploadOptions } from '../src/upload.js';
import type { CiContext } from '../src/service/context.js';

const fixtures = (rel: string): string => fileURLToPath(new URL(`../../fixtures/${rel}`, import.meta.url));
const COMMIT = '1'.repeat(40);

let server: FixtureServer;
let cwd: string;

beforeEach(async () => {
  server = await startFixtureServer({ repository: { owner: 'meridian', name: 'billing-service' } });
  cwd = mkdtempSync(join(tmpdir(), 'ptk-upload-'));
  mkdirSync(join(cwd, 'docs'));
  copyFileSync(fixtures('pdfs/invoice.pdf'), join(cwd, 'docs/invoice.pdf'));
  copyFileSync(fixtures('snapshots/invoice-grown.snapshot.json'), join(cwd, 'docs/invoice.json'));
});
afterEach(async () => {
  await server.close();
});

const context = (over: Partial<CiContext> = {}): CiContext => ({
  repository: { owner: 'meridian', name: 'billing-service' },
  headCommit: COMMIT,
  branch: 'feat/x',
  pr: { number: 482, baseBranch: 'main', headBranch: 'feat/x' },
  ci: { provider: 'other', runId: '100', runAttempt: 1, runUrl: null, actor: 'priya' },
  ...over,
});

const opts = (documents: string[], over: Partial<UploadOptions> = {}): UploadOptions => ({
  documents,
  serviceUrl: server.url,
  token: server.token,
  context: context(),
  cwd,
  dpi: 72,
  images: true,
  failOn: null,
  requireService: false,
  retryDelaysMs: [0, 0],
  log: () => undefined,
  ...over,
});

const baselineSnapshot = () => JSON.parse(readFileSync(fixtures('snapshots/invoice-baseline.snapshot.json'), 'utf8'));

describe('upload — first run', () => {
  it('establishes a baseline: structure and page images uploaded, run ready, batch complete', async () => {
    const r = await runUpload(opts(['docs/invoice.pdf']));
    expect(r.exitCode).toBe(0);
    expect(r.documents).toEqual([
      expect.objectContaining({ path: 'docs/invoice.pdf', status: 'created', kind: 'established', outcome: 'passed', reviewState: 'not_required' }),
    ]);
    const run = [...server.runs.values()][0]!;
    expect(run.kind).toBe('established');
    expect(run.status).toBe('ready');
    expect(run.image_keys).toHaveLength(2);
    expect(run.renderer_id).toMatch(/^pdfjs-/);
    expect(run.image_dpi).toBe(72);
    const blob = server.objects.get(run.structure_key)!;
    const snap = JSON.parse(gunzipSync(blob).toString('utf8'));
    expect(snap.contentHash).toBe(run.structure_hash);
    for (const k of run.image_keys) expect(server.objects.get(k.key)!.subarray(0, 4).toString()).toBe('RIFF');
    const batch = server.batches.get(run.batch_id)!;
    expect(batch.status).toBe('complete');
    expect(batch.document_paths).toEqual(['docs/invoice.pdf']);
    expect(server.baselines.get('docs/invoice.pdf')?.run_id).toBe(run.run_id);
  });

  it('normalises document paths to repository-relative posix form', async () => {
    const r = await runUpload(opts(['./docs/invoice.pdf']));
    expect(r.documents[0]!.path).toBe('docs/invoice.pdf');
  });
});

describe('upload — compared run', () => {
  it('fetches the baseline, diffs locally, and uploads events and groups as reported', async () => {
    server.setBaseline('docs/invoice.json', baselineSnapshot(), { commit: '2'.repeat(40) });
    const r = await runUpload(opts(['docs/invoice.json']));
    expect(r.exitCode).toBe(0);
    expect(r.documents[0]).toMatchObject({ status: 'created', kind: 'compared', outcome: 'blocked', reviewState: 'awaiting_review' });
    const run = [...server.runs.values()].find((x) => x.kind === 'compared')!;
    expect(run.events).toHaveLength(135);
    expect(run.groups).toHaveLength(6);
    expect(run.gate).toBe('error');
    expect(run.image_keys).toEqual([]); // a .json input has no pages to render
    expect(run.status).toBe('ready');
    expect((run.events[0] as { index: number }).index).toBe(0);
  });

  it('exits 1 only when --fail-on is given and the gate is hit', async () => {
    server.setBaseline('docs/invoice.json', baselineSnapshot());
    expect((await runUpload(opts(['docs/invoice.json'], { failOn: 'error' }))).exitCode).toBe(1);
  });

  it('is a no-op on a re-push with an identical structure', async () => {
    server.setBaseline('docs/invoice.json', baselineSnapshot());
    const first = await runUpload(opts(['docs/invoice.json']));
    const objectsBefore = server.objects.size;
    const second = await runUpload(opts(['docs/invoice.json'], { context: context({ ci: { provider: 'other', runId: '101', runAttempt: 1, runUrl: null, actor: 'priya' } }) }));
    expect(second.documents[0]).toMatchObject({ status: 'unchanged', runId: first.documents[0]!.runId });
    expect(server.objects.size).toBe(objectsBefore);
  });

  it('re-fetches and re-diffs once when the baseline moves between lookup and upload', async () => {
    server.setBaseline('docs/invoice.json', baselineSnapshot());
    let moved = false;
    const r = await runUpload(
      opts(['docs/invoice.json'], {
        // Simulate main advancing after the CLI looked the baseline up.
        onBeforeRun: () => {
          if (!moved) {
            moved = true;
            server.setBaseline('docs/invoice.json', { ...baselineSnapshot(), pageCount: 9, contentHash: 'sha256:' + 'c'.repeat(64) }, { commit: '3'.repeat(40) });
          }
        },
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.documents[0]!.status).toBe('created');
    const run = [...server.runs.values()].find((x) => x.kind === 'compared')!;
    expect(run.baseline_commit).toBe('3'.repeat(40));
    expect(server.requests.filter((q) => q.path.endsWith('/baseline'))).toHaveLength(2);
  });
});

describe('upload — images and privacy', () => {
  it('sends no images in privacy mode B even for a PDF', async () => {
    server.setPrivacyMode('B');
    const r = await runUpload(opts(['docs/invoice.pdf']));
    expect(r.exitCode).toBe(0);
    expect([...server.runs.values()][0]!.image_keys).toEqual([]);
  });

  it('sends no images with --no-images', async () => {
    const r = await runUpload(opts(['docs/invoice.pdf'], { images: false }));
    expect(r.exitCode).toBe(0);
    expect([...server.runs.values()][0]!.image_keys).toEqual([]);
  });
});

describe('upload — failure semantics (PROTOCOL.md §8–9)', () => {
  it('warns and exits 0 when the service is unavailable, after three attempts', async () => {
    server.failNext(503, 99);
    const lines: string[] = [];
    const r = await runUpload(opts(['docs/invoice.pdf'], { log: (l) => lines.push(l) }));
    expect(r.exitCode).toBe(0);
    expect(r.unavailable).toMatch(/503/);
    expect(server.requests).toHaveLength(3);
    expect(lines.join('\n')).toMatch(/warning/i);
  });

  it('exits 3 when unavailable and --require-service is set', async () => {
    server.failNext(503, 99);
    const r = await runUpload(opts(['docs/invoice.pdf'], { requireService: true }));
    expect(r.exitCode).toBe(3);
  });

  it('retries after a 429 and then succeeds', async () => {
    server.failNext(429, 1);
    const r = await runUpload(opts(['docs/invoice.pdf']));
    expect(r.exitCode).toBe(0);
    expect(server.requests.filter((q) => q.path === '/ingest/v1/batches')).toHaveLength(2);
  });

  it('exits 2 on a 4xx, which is configuration and never "unavailable"', async () => {
    const r = await runUpload(opts(['docs/invoice.pdf'], { token: 'ptk_revoked', requireService: false }));
    expect(r.exitCode).toBe(2);
    expect(r.error).toMatch(/unauthorized/);
  });

  it('reports an unreadable document in the batch completion and exits 2 after finishing the others', async () => {
    const r = await runUpload(opts(['docs/missing.pdf', 'docs/invoice.pdf']));
    expect(r.exitCode).toBe(2);
    expect(r.documents.map((d) => d.status)).toEqual(['failed', 'created']);
    const batch = [...server.batches.values()][0]!;
    expect(batch.status).toBe('complete');
    expect(batch.document_paths).toEqual(['docs/invoice.pdf']);
    expect(batch.failed).toEqual([{ document_path: 'docs/missing.pdf', reason: expect.stringMatching(/ENOENT|no such file/i) }]);
  });
});

describe('upload — command line', () => {
  it('runs end to end through the binary with explicit context flags', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const bin = fileURLToPath(new URL('../bin/pdf-testkit.js', import.meta.url));
    writeFileSync(join(cwd, 'unused'), '');
    const { stdout } = await promisify(execFile)(
      'node',
      [bin, 'upload', 'docs/invoice.pdf', '--service-url', server.url, '--token', server.token, '--repo', 'meridian/billing-service', '--commit', COMMIT, '--branch', 'main', '--run-id', 'cli-1', '--dpi', '72', '--json'],
      { cwd },
    );
    const out = JSON.parse(stdout);
    expect(out.documents[0]).toMatchObject({ path: 'docs/invoice.pdf', status: 'created', kind: 'established' });
    expect(server.batches.size).toBe(1);
  });
});
