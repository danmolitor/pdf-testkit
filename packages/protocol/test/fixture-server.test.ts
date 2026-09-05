import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/index.js';
import { startFixtureServer, type FixtureServer } from '../src/testing/index.js';

const COMMIT_A = '1'.repeat(40);
const COMMIT_B = '2'.repeat(40);
const HASH_1 = 'sha256:' + '1'.repeat(64);
const HASH_2 = 'sha256:' + '2'.repeat(64);

let server: FixtureServer;

beforeEach(async () => {
  server = await startFixtureServer({ repository: { owner: 'meridian', name: 'billing-service' } });
});
afterEach(async () => {
  await server.close();
});

function headers(token = server.token): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-pdf-testkit-protocol': String(PROTOCOL_VERSION),
    'user-agent': 'pdf-testkit-cli/test',
  };
}

async function post(path: string, body: unknown, h = headers()) {
  const res = await fetch(server.url + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
}
async function get(path: string, h = headers()) {
  const res = await fetch(server.url + path, { headers: h });
  return { status: res.status, json: (await res.json()) as any };
}

const batchBody = (commit = COMMIT_A, runId = '100', attempt = 1, branch = 'feat/x') => ({
  repository: { provider: 'github', owner: 'meridian', name: 'billing-service' },
  head_commit: commit,
  branch,
  pr: branch === 'main' ? null : { number: 1, base_branch: 'main', head_branch: branch },
  ci: { provider: 'github-actions', run_id: runId, run_attempt: attempt, run_url: null, actor: 'priya' },
  tool: { name: 'pdf-testkit', version: '0.2.0', protocol_version: PROTOCOL_VERSION, snapshot_schema_version: 1 },
});

async function openBatch(...args: Parameters<typeof batchBody>) {
  const r = await post('/ingest/v1/batches', batchBody(...args));
  expect(r.status).toBe(200);
  return r.json.batch_id as string;
}

const snapshot = (hash: string) => ({ version: 1, producer: 'pdfjs', createdAt: 'x', pageCount: 1, pages: [], nodes: [], contentHash: hash });

const runBody = (opts: { hash: string; baselineRunId: string | null; baselineHash?: string; events?: any[]; failOn?: string; images?: unknown; byteSize?: number }) => ({
  document_path: 'fixtures/invoice.pdf',
  kind: opts.baselineRunId ? 'compared' : 'established',
  baseline_run_id: opts.baselineRunId,
  structure: { hash: opts.hash, byte_size: opts.byteSize ?? 10, encoding: 'gzip', snapshot_schema_version: 1, producer: 'pdfjs', page_count: 1, node_count: 5 },
  diff: opts.baselineRunId
    ? {
        events: opts.events ?? [],
        groups: (opts.events ?? []).map((e, i) => ({ index: i, kind: 'single', severity: e.severity, summary: e.message, root_index: i, member_indices: [i] })),
        gate: { fail_on: opts.failOn ?? 'error' },
        timings: { extract_ms: 1, diff_ms: 1, render_ms: null, nodes_compared: 5 },
        baseline_hash: opts.baselineHash ?? HASH_1,
      }
    : null,
  images: opts.images ?? null,
});

const ev = (i: number, severity: string) => ({ index: i, type: 'table-moved', severity, message: 'table moved', confidence: 1 });

describe('fixture server: auth and negotiation', () => {
  it('rejects a missing or wrong token with 401 unauthorized', async () => {
    const r = await post('/ingest/v1/batches', batchBody(), headers('ptk_wrong'));
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('unauthorized');
  });

  it('rejects a repository that is not the token’s with 403 repository_mismatch', async () => {
    const body = batchBody();
    body.repository.name = 'other';
    const r = await post('/ingest/v1/batches', body);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('repository_mismatch');
  });

  it('rejects an unknown protocol version header with 400 protocol_unsupported', async () => {
    const r = await post('/ingest/v1/batches', batchBody(), { ...headers(), 'x-pdf-testkit-protocol': '9' });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('protocol_unsupported');
    expect(r.json.details.supported).toEqual([PROTOCOL_VERSION]);
  });

  it('reports schema violations as 400 payload_invalid with issues', async () => {
    const r = await post('/ingest/v1/batches', { ...batchBody(), head_commit: 'short' });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('payload_invalid');
    expect(Array.isArray(r.json.details.issues)).toBe(true);
  });
});

describe('fixture server: batches', () => {
  it('is idempotent on (repo, commit, run_id, run_attempt) and reports the default branch', async () => {
    const a = await post('/ingest/v1/batches', batchBody());
    const b = await post('/ingest/v1/batches', batchBody());
    expect(a.json.batch_id).toBe(b.json.batch_id);
    expect(a.json.resumed).toBe(false);
    expect(b.json.resumed).toBe(true);
    expect(a.json.repository).toEqual({ default_branch: 'main', is_default_branch: false });
    expect(a.json.org.privacy_mode).toBe('A');
  });

  it('opens a new batch for a new attempt of the same commit', async () => {
    const a = await openBatch(COMMIT_A, '100', 1);
    const b = await openBatch(COMMIT_A, '100', 2);
    expect(a).not.toBe(b);
  });
});

describe('fixture server: baseline lookup', () => {
  it('returns null document and null baseline for a never-seen path', async () => {
    const id = await openBatch();
    const r = await get(`/ingest/v1/batches/${id}/baseline?document_path=fixtures/new.pdf`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ document: null, baseline: null });
  });

  it('returns the seeded baseline with a structure_url that serves the blob', async () => {
    const base = server.setBaseline('fixtures/invoice.pdf', snapshot(HASH_1), { commit: COMMIT_B, rendererId: 'pdfjs-4.10.38', dpi: 150 });
    const id = await openBatch();
    const r = await get(`/ingest/v1/batches/${id}/baseline?document_path=fixtures/invoice.pdf`);
    expect(r.json.document.presence).toBe('tracked');
    expect(r.json.baseline.run_id).toBe(base.run_id);
    expect(r.json.baseline.structure_hash).toBe(HASH_1);
    expect(r.json.baseline.renderer_id).toBe('pdfjs-4.10.38');
    const blob = await fetch(r.json.baseline.structure_url);
    expect(blob.status).toBe(200);
    expect(JSON.parse(await blob.text()).contentHash).toBe(HASH_1);
  });
});

describe('fixture server: runs', () => {
  it('creates an established run when there is no baseline and records promotion zero', async () => {
    const id = await openBatch();
    const r = await post(`/ingest/v1/batches/${id}/runs`, runBody({ hash: HASH_1, baselineRunId: null }));
    expect(r.status).toBe(201);
    expect(r.json.disposition).toBe('created');
    expect(r.json.kind).toBe('established');
    expect(r.json.outcome).toBe('passed');
    expect(r.json.review_state).toBe('not_required');
    expect(r.json.uploads.structure.method).toBe('PUT');
    expect(r.json.uploads.images).toEqual([]);
    const run = server.runs.get(r.json.run_id)!;
    expect(run.baseline_commit).toBeNull();
    expect(server.promotions.filter((p) => p.document_path === 'fixtures/invoice.pdf')).toHaveLength(1);
  });

  it('rejects an established run when a baseline exists (409 baseline_exists)', async () => {
    server.setBaseline('fixtures/invoice.pdf', snapshot(HASH_1));
    const id = await openBatch();
    const r = await post(`/ingest/v1/batches/${id}/runs`, runBody({ hash: HASH_2, baselineRunId: null }));
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('baseline_exists');
  });

  it('rejects a compared run against a stale baseline (409 baseline_moved) and names the current one', async () => {
    server.setBaseline('fixtures/invoice.pdf', snapshot(HASH_1));
    const current = server.setBaseline('fixtures/invoice.pdf', snapshot(HASH_2), { commit: COMMIT_B });
    const id = await openBatch();
    const r = await post(`/ingest/v1/batches/${id}/runs`, runBody({ hash: HASH_2, baselineRunId: 'run_stale', baselineHash: HASH_1 }));
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('baseline_moved');
    expect(r.json.details.baseline.run_id).toBe(current.run_id);
  });

  it('computes outcome from the gate and review_state from the presence of events', async () => {
    const base = server.setBaseline('fixtures/invoice.pdf', snapshot(HASH_1));
    const id = await openBatch();
    const warnOnly = await post(`/ingest/v1/batches/${id}/runs`, runBody({ hash: HASH_2, baselineRunId: base.run_id, events: [ev(0, 'warn')] }));
    expect(warnOnly.status).toBe(201);
    expect(warnOnly.json.outcome).toBe('passed');
    expect(warnOnly.json.review_state).toBe('awaiting_review');

    const id2 = await openBatch(COMMIT_B);
    const gated = await post(`/ingest/v1/batches/${id2}/runs`, runBody({ hash: HASH_2, baselineRunId: base.run_id, events: [ev(0, 'warn')], failOn: 'warn' }));
    expect(gated.json.outcome).toBe('blocked');
  });

  it('returns unchanged for a new batch on the same commit with an identical hash, preserving the run', async () => {
    const base = server.setBaseline('fixtures/invoice.pdf', snapshot(HASH_1));
    const id1 = await openBatch(COMMIT_A, '100', 1);
    const first = await post(`/ingest/v1/batches/${id1}/runs`, runBody({ hash: HASH_2, baselineRunId: base.run_id, events: [ev(0, 'error')] }));
    const id2 = await openBatch(COMMIT_A, '101', 1); // re-push: new run id, attempt back to 1
    const again = await post(`/ingest/v1/batches/${id2}/runs`, runBody({ hash: HASH_2, baselineRunId: base.run_id, events: [ev(0, 'error')] }));
    expect(again.status).toBe(200);
    expect(again.json.disposition).toBe('unchanged');
    expect(again.json.run_id).toBe(first.json.run_id);
    expect(again.json.uploads).toBeNull();
  });

  it('creates a new run and supersedes the old one when the hash differs on the same commit', async () => {
    const base = server.setBaseline('fixtures/invoice.pdf', snapshot(HASH_1));
    const id1 = await openBatch(COMMIT_A, '100', 1);
    const first = await post(`/ingest/v1/batches/${id1}/runs`, runBody({ hash: HASH_2, baselineRunId: base.run_id, events: [ev(0, 'error')] }));
    const id2 = await openBatch(COMMIT_A, '100', 2);
    const other = 'sha256:' + '3'.repeat(64);
    const second = await post(`/ingest/v1/batches/${id2}/runs`, runBody({ hash: other, baselineRunId: base.run_id, events: [ev(0, 'error')] }));
    expect(second.status).toBe(201);
    expect(second.json.disposition).toBe('created');
    expect(second.json.run_id).not.toBe(first.json.run_id);
    const old = server.runs.get(first.json.run_id)!;
    expect(old.review_state).toBe('superseded');
    expect(old.superseded_by).toBe(second.json.run_id);
    expect(server.determinismAssertions).toEqual([
      expect.objectContaining({ document_path: 'fixtures/invoice.pdf', head_commit: COMMIT_A }),
    ]);
  });

  it('replaces in place when the same batch re-sends the same path', async () => {
    const id = await openBatch();
    const a = await post(`/ingest/v1/batches/${id}/runs`, runBody({ hash: HASH_1, baselineRunId: null }));
    const b = await post(`/ingest/v1/batches/${id}/runs`, runBody({ hash: HASH_1, baselineRunId: null }));
    expect(b.json.disposition).toBe('replaced');
    expect(b.json.run_id).toBe(a.json.run_id);
  });

  it('refuses images in privacy mode B', async () => {
    server.setPrivacyMode('B');
    const id = await openBatch();
    const images = { renderer_id: 'pdfjs-4.10.38', dpi: 150, format: 'image/webp', pages: [{ index: 0, width_px: 10, height_px: 10, byte_size: 3, sha256: 'a'.repeat(64) }] };
    const r = await post(`/ingest/v1/batches/${id}/runs`, runBody({ hash: HASH_1, baselineRunId: null, images }));
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('privacy_mode_forbids_images');
  });
});

describe('fixture server: uploads and completion', () => {
  it('accepts PUTs to the presigned urls, then marks the run ready on completion', async () => {
    const id = await openBatch();
    const blob = gzipSync(Buffer.from(JSON.stringify(snapshot(HASH_1))));
    const images = { renderer_id: 'pdfjs-4.10.38', dpi: 150, format: 'image/webp', pages: [{ index: 0, width_px: 10, height_px: 10, byte_size: 3, sha256: 'a'.repeat(64) }] };
    const r = await post(`/ingest/v1/batches/${id}/runs`, runBody({ hash: HASH_1, baselineRunId: null, images, byteSize: blob.length }));
    expect(r.status).toBe(201);
    const up = r.json.uploads;
    expect(up.images).toHaveLength(1);
    const s = await fetch(up.structure.url, { method: 'PUT', headers: up.structure.headers, body: blob });
    expect(s.status).toBe(200);
    const i = await fetch(up.images[0].url, { method: 'PUT', headers: up.images[0].headers, body: Buffer.from([1, 2, 3]) });
    expect(i.status).toBe(200);
    const done = await post(`/ingest/v1/runs/${r.json.run_id}/complete`, { structure_uploaded: true, image_indices_uploaded: [0] });
    expect(done.status).toBe(200);
    expect(done.json.status).toBe('ready');
    expect(server.runs.get(r.json.run_id)!.status).toBe('ready');
  });

  it('rejects completion when an object is missing or its size differs (409 upload_incomplete)', async () => {
    const id = await openBatch();
    const r = await post(`/ingest/v1/batches/${id}/runs`, runBody({ hash: HASH_1, baselineRunId: null, byteSize: 99 }));
    await fetch(r.json.uploads.structure.url, { method: 'PUT', headers: r.json.uploads.structure.headers, body: Buffer.from('short') });
    const done = await post(`/ingest/v1/runs/${r.json.run_id}/complete`, { structure_uploaded: true, image_indices_uploaded: [] });
    expect(done.status).toBe(409);
    expect(done.json.code).toBe('upload_incomplete');
    expect(done.json.details.missing).toHaveLength(1);
  });

  it('completes a batch idempotently and counts ready runs', async () => {
    const id = await openBatch();
    const r = await post(`/ingest/v1/batches/${id}/runs`, runBody({ hash: HASH_1, baselineRunId: null, byteSize: 5 }));
    await fetch(r.json.uploads.structure.url, { method: 'PUT', headers: r.json.uploads.structure.headers, body: Buffer.from('12345') });
    await post(`/ingest/v1/runs/${r.json.run_id}/complete`, { structure_uploaded: true, image_indices_uploaded: [] });
    const c1 = await post(`/ingest/v1/batches/${id}/complete`, { document_paths: ['fixtures/invoice.pdf'], failed: [] });
    expect(c1.status).toBe(200);
    expect(c1.json).toEqual({ batch_id: id, status: 'complete', runs_ready: 1 });
    const c2 = await post(`/ingest/v1/batches/${id}/complete`, { document_paths: ['fixtures/invoice.pdf'], failed: [{ document_path: 'fixtures/b.pdf', reason: 'extract_failed' }] });
    expect(c2.status).toBe(200);
    expect(server.batches.get(id)!.failed).toHaveLength(1);
  });
});

describe('fixture server: failure injection', () => {
  it('fails the next N requests with the given status', async () => {
    server.failNext(503, 2);
    const a = await post('/ingest/v1/batches', batchBody());
    const b = await post('/ingest/v1/batches', batchBody());
    const c = await post('/ingest/v1/batches', batchBody());
    expect([a.status, b.status, c.status]).toEqual([503, 503, 200]);
    expect(a.json.code).toBe('internal');
  });

  it('answers 429 with a Retry-After header', async () => {
    server.failNext(429, 1);
    const res = await fetch(server.url + '/ingest/v1/batches', { method: 'POST', headers: headers(), body: JSON.stringify(batchBody()) });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(((await res.json()) as any).code).toBe('rate_limited');
  });

  it('records every request for assertions', async () => {
    await openBatch();
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /ingest/v1/batches']);
  });
});
