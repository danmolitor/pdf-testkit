/**
 * Reference implementation of the service side of PROTOCOL.md, in memory, for
 * tests. It validates every request with the same schemas the real service
 * uses, implements the idempotency / supersession table from §4, serves
 * "presigned" URLs from its own storage path, and exposes its state so tests
 * can assert on it and controls so tests can seed baselines and inject failures.
 *
 * It is a fixture, not a service: no auth beyond one token, no persistence, no
 * signatures on URLs. Anything it gets wrong is a bug against PROTOCOL.md.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ZodError, ZodType } from 'zod';
import {
  BatchCompleteRequest,
  BatchRequest,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  RunCompleteRequest,
  RunRequest,
  TOKEN_PREFIX,
  type BaselineRef,
  type BaselineResponse,
  type BatchCompleteResponse,
  type BatchResponse,
  type ErrorCode,
  type FailOn,
  type Outcome,
  type PresignedPut,
  type PrivacyMode,
  type ReviewState,
  type RunCompleteResponse,
  type RunKind,
  type RunResponse,
} from '../schema.js';
import { computeOutcome } from '../outcome.js';

export interface FixtureServerOptions {
  repository: { owner: string; name: string };
  /** Bearer token the fixture accepts. Default `ptk_test`. */
  token?: string;
  defaultBranch?: string;
  privacyMode?: PrivacyMode;
}

export interface StoredBatch {
  batch_id: string;
  key: string;
  head_commit: string;
  branch: string;
  is_default_branch: boolean;
  pr_number: number | null;
  ci_run_id: string;
  run_attempt: number;
  tool_version: string;
  status: 'open' | 'complete';
  document_paths: string[];
  failed: { document_path: string; reason: string }[];
}

export interface StoredRun {
  run_id: string;
  batch_id: string;
  document_path: string;
  head_commit: string;
  ci_run_id: string;
  run_attempt: number;
  kind: RunKind;
  baseline_run_id: string | null;
  baseline_commit: string | null;
  structure_hash: string;
  structure_key: string;
  structure_byte_size: number;
  image_keys: { index: number; key: string; byte_size: number }[];
  renderer_id: string | null;
  image_dpi: number | null;
  events: unknown[];
  groups: unknown[];
  gate: FailOn | null;
  outcome: Outcome;
  review_state: ReviewState;
  superseded_by: string | null;
  status: 'pending' | 'ready';
  pdf_testkit_version: string;
}

export interface StoredBaseline {
  run_id: string;
  commit: string;
  structure_hash: string;
  structure_key: string;
  renderer_id: string | null;
  image_dpi: number | null;
}

export interface Promotion {
  document_path: string;
  run_id: string;
  commit: string;
  kind: 'established' | 'promoted';
}

export interface FixtureServer {
  url: string;
  token: string;
  close(): Promise<void>;

  // --- controls ---
  /** Seed (or move) the default-branch baseline for a path. Returns the synthetic baseline run. */
  setBaseline(
    documentPath: string,
    snapshot: unknown,
    opts?: { commit?: string; rendererId?: string | null; dpi?: number | null },
  ): StoredBaseline;
  /** Make an uploaded run the baseline, as a merge to the default branch would. */
  promote(runId: string): StoredBaseline;
  /** Fail the next `times` requests (default 1) with `status`. */
  failNext(status: number, times?: number): void;
  setPrivacyMode(mode: PrivacyMode): void;

  // --- state, for assertions ---
  batches: Map<string, StoredBatch>;
  runs: Map<string, StoredRun>;
  baselines: Map<string, StoredBaseline>;
  documents: Map<string, { document_id: string; path: string; presence: 'tracked' | 'missing' | 'untracked' }>;
  objects: Map<string, Buffer>;
  promotions: Promotion[];
  determinismAssertions: { document_path: string; head_commit: string; hashes: [string, string] }[];
  requests: { method: string; path: string }[];
}

class HttpError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

let counter = 0;
const id = (prefix: string): string => `${prefix}_${(++counter).toString(36).padStart(6, '0')}`;

export async function startFixtureServer(opts: FixtureServerOptions): Promise<FixtureServer> {
  const token = opts.token ?? `${TOKEN_PREFIX}test`;
  const defaultBranch = opts.defaultBranch ?? 'main';
  let privacyMode: PrivacyMode = opts.privacyMode ?? 'A';
  const failures: { status: number; remaining: number } = { status: 0, remaining: 0 };

  const state = {
    batches: new Map<string, StoredBatch>(),
    runs: new Map<string, StoredRun>(),
    baselines: new Map<string, StoredBaseline>(),
    documents: new Map<string, { document_id: string; path: string; presence: 'tracked' | 'missing' | 'untracked' }>(),
    objects: new Map<string, Buffer>(),
    promotions: [] as Promotion[],
    determinismAssertions: [] as FixtureServer['determinismAssertions'],
    requests: [] as { method: string; path: string }[],
  };

  let baseUrl = '';
  const storageUrl = (key: string): string => `${baseUrl}/_storage/${key}`;
  const presigned = (key: string, headers: Record<string, string>): PresignedPut => ({
    method: 'PUT',
    url: storageUrl(key),
    headers,
  });

  function ensureDocument(path: string) {
    let doc = state.documents.get(path);
    if (!doc) {
      doc = { document_id: id('doc'), path, presence: 'tracked' };
      state.documents.set(path, doc);
    }
    return doc;
  }

  function baselineRef(b: StoredBaseline): BaselineRef {
    return {
      run_id: b.run_id,
      commit: b.commit,
      structure_hash: b.structure_hash,
      snapshot_schema_version: 1,
      structure_url: storageUrl(b.structure_key),
      structure_encoding: 'gzip',
      renderer_id: b.renderer_id,
      image_dpi: b.image_dpi,
    };
  }

  // -------------------------------------------------------------------------
  // Handlers

  function openBatch(body: unknown): { status: number; json: BatchResponse } {
    const req = parse(BatchRequest, body);
    if (req.repository.owner !== opts.repository.owner || req.repository.name !== opts.repository.name) {
      throw new HttpError(403, 'repository_mismatch', 'token is not for this repository');
    }
    const key = `${req.head_commit}#${req.ci.run_id}.${req.ci.run_attempt}`;
    const existing = [...state.batches.values()].find((b) => b.key === key);
    const isDefault = req.branch === defaultBranch;
    if (existing) {
      return {
        status: 200,
        json: {
          batch_id: existing.batch_id,
          resumed: true,
          repository: { default_branch: defaultBranch, is_default_branch: isDefault },
          org: { privacy_mode: privacyMode },
        },
      };
    }
    const batch: StoredBatch = {
      batch_id: id('bat'),
      key,
      head_commit: req.head_commit,
      branch: req.branch,
      is_default_branch: isDefault,
      pr_number: req.pr?.number ?? null,
      ci_run_id: req.ci.run_id,
      run_attempt: req.ci.run_attempt,
      tool_version: req.tool.version,
      status: 'open',
      document_paths: [],
      failed: [],
    };
    state.batches.set(batch.batch_id, batch);
    return {
      status: 200,
      json: {
        batch_id: batch.batch_id,
        resumed: false,
        repository: { default_branch: defaultBranch, is_default_branch: isDefault },
        org: { privacy_mode: privacyMode },
      },
    };
  }

  function getBatch(batchId: string): StoredBatch {
    const b = state.batches.get(batchId);
    if (!b) throw new HttpError(404, 'batch_not_found', `no batch ${batchId}`);
    return b;
  }

  function lookupBaseline(batchId: string, documentPath: string | null): BaselineResponse {
    getBatch(batchId);
    if (!documentPath) throw new HttpError(400, 'payload_invalid', 'document_path is required');
    const doc = state.documents.get(documentPath) ?? null;
    const base = state.baselines.get(documentPath) ?? null;
    return { document: doc, baseline: base ? baselineRef(base) : null };
  }

  function createRun(batchId: string, body: unknown): { status: number; json: RunResponse } {
    const batch = getBatch(batchId);
    const req = parse(RunRequest, body);
    if (req.images && privacyMode === 'B') {
      throw new HttpError(400, 'privacy_mode_forbids_images', 'this org stores structure only');
    }
    const current = state.baselines.get(req.document_path) ?? null;
    if (req.kind === 'established' && current) {
      throw new HttpError(409, 'baseline_exists', 'a baseline exists; send a compared run', {
        baseline: baselineRef(current),
      });
    }
    if (req.kind === 'compared') {
      if (!current || current.run_id !== req.baseline_run_id || current.structure_hash !== req.diff!.baseline_hash) {
        throw new HttpError(409, 'baseline_moved', 'the baseline is not the one this run was compared against', {
          baseline: current ? baselineRef(current) : null,
        });
      }
    }

    ensureDocument(req.document_path);
    const sameCommit = [...state.runs.values()].filter(
      (r) => r.document_path === req.document_path && r.head_commit === batch.head_commit && r.review_state !== 'superseded',
    );
    const sameBatch = sameCommit.find((r) => r.batch_id === batch.batch_id);
    const other = sameCommit.find((r) => r.batch_id !== batch.batch_id);

    // §4 table, row 3: a new batch on the same commit with an identical hash is a no-op.
    if (!sameBatch && other && other.structure_hash === req.structure.hash) {
      return {
        status: 200,
        json: {
          run_id: other.run_id,
          disposition: 'unchanged',
          kind: other.kind,
          outcome: other.outcome,
          review_state: other.review_state,
          uploads: null,
        },
      };
    }

    const events = req.diff?.events ?? [];
    const { outcome, review_state } = req.diff
      ? computeOutcome(events, req.diff.gate.fail_on)
      : { outcome: 'passed' as const, review_state: 'not_required' as const };

    const runId = sameBatch ? sameBatch.run_id : id('run');
    const prefix = `org/test/${runId}`;
    const run: StoredRun = {
      run_id: runId,
      batch_id: batch.batch_id,
      document_path: req.document_path,
      head_commit: batch.head_commit,
      ci_run_id: batch.ci_run_id,
      run_attempt: batch.run_attempt,
      kind: req.kind,
      baseline_run_id: req.baseline_run_id,
      baseline_commit: current && req.kind === 'compared' ? current.commit : null,
      structure_hash: req.structure.hash,
      structure_key: `${prefix}/structure.json.gz`,
      structure_byte_size: req.structure.byte_size,
      image_keys: (req.images?.pages ?? []).map((p) => ({ index: p.index, key: `${prefix}/page-${p.index}.webp`, byte_size: p.byte_size })),
      renderer_id: req.images?.renderer_id ?? null,
      image_dpi: req.images?.dpi ?? null,
      events,
      groups: req.diff?.groups ?? [],
      gate: req.diff?.gate.fail_on ?? null,
      outcome,
      review_state,
      superseded_by: null,
      status: 'pending',
      pdf_testkit_version: batch.tool_version,
    };
    state.runs.set(runId, run);

    // §4 table, row 4: same commit, different hash → supersede, and that is a
    // determinism assertion (lifecycle spec §1, row one).
    if (!sameBatch && other) {
      other.review_state = 'superseded';
      other.superseded_by = runId;
      state.determinismAssertions.push({
        document_path: req.document_path,
        head_commit: batch.head_commit,
        hashes: [other.structure_hash, req.structure.hash],
      });
    }
    if (req.kind === 'established') {
      // Promotion entry zero. The run becomes the baseline once its structure is uploaded (see completeRun).
      if (!state.promotions.some((p) => p.document_path === req.document_path && p.run_id === runId)) {
        state.promotions.push({ document_path: req.document_path, run_id: runId, commit: batch.head_commit, kind: 'established' });
      }
    }
    return {
      status: 201,
      json: {
        run_id: runId,
        disposition: sameBatch ? 'replaced' : 'created',
        kind: req.kind,
        outcome,
        review_state,
        uploads: {
          structure: presigned(run.structure_key, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }),
          images: run.image_keys.map((k) => ({ index: k.index, ...presigned(k.key, { 'Content-Type': 'image/webp' }) })),
        },
      },
    };
  }

  function completeRun(runId: string, body: unknown): RunCompleteResponse {
    const run = state.runs.get(runId);
    if (!run) throw new HttpError(404, 'run_not_found', `no run ${runId}`);
    const req = parse(RunCompleteRequest, body);
    const missing: { key: string; reason: string }[] = [];
    const check = (key: string, size: number) => {
      const obj = state.objects.get(key);
      if (!obj) missing.push({ key, reason: 'not_found' });
      else if (obj.length !== size) missing.push({ key, reason: `size ${obj.length} ≠ declared ${size}` });
    };
    check(run.structure_key, run.structure_byte_size);
    for (const k of run.image_keys) {
      if (req.image_indices_uploaded.includes(k.index)) check(k.key, k.byte_size);
      else missing.push({ key: k.key, reason: 'not_uploaded' });
    }
    if (missing.length) throw new HttpError(409, 'upload_incomplete', 'declared objects are missing', { missing });
    run.status = 'ready';
    if (run.kind === 'established' && !state.baselines.has(run.document_path)) {
      state.baselines.set(run.document_path, {
        run_id: run.run_id,
        commit: run.head_commit,
        structure_hash: run.structure_hash,
        structure_key: run.structure_key,
        renderer_id: run.renderer_id,
        image_dpi: run.image_dpi,
      });
    }
    return { run_id: run.run_id, status: 'ready' };
  }

  function completeBatch(batchId: string, body: unknown): BatchCompleteResponse {
    const batch = getBatch(batchId);
    const req = parse(BatchCompleteRequest, body);
    batch.status = 'complete';
    batch.document_paths = req.document_paths;
    batch.failed = req.failed;
    const ready = [...state.runs.values()].filter((r) => r.batch_id === batchId && r.status === 'ready').length;
    return { batch_id: batchId, status: 'complete', runs_ready: ready };
  }

  // -------------------------------------------------------------------------
  // Transport

  function parse<T>(schema: ZodType<T>, body: unknown): T {
    const r = schema.safeParse(body);
    if (r.success) return r.data;
    throw new HttpError(400, 'payload_invalid', 'request does not match the protocol schema', {
      issues: (r.error as ZodError).issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  function send(res: ServerResponse, status: number, json: unknown, headers: Record<string, string> = {}): void {
    const body = JSON.stringify(json);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', baseUrl);
    const method = req.method ?? 'GET';
    const path = url.pathname;

    // Storage is unauthenticated by design: presigned URLs carry their own authority.
    if (path.startsWith('/_storage/')) {
      const key = decodeURIComponent(path.slice('/_storage/'.length));
      if (method === 'PUT') {
        state.objects.set(key, await readBody(req));
        res.writeHead(200).end();
        return;
      }
      const obj = state.objects.get(key);
      if (!obj) {
        res.writeHead(404).end();
        return;
      }
      if (method === 'HEAD') {
        res.writeHead(200, { 'content-length': String(obj.length) }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(obj.length) }).end(obj);
      return;
    }

    state.requests.push({ method, path });

    if (failures.remaining > 0) {
      failures.remaining--;
      const s = failures.status;
      const code: ErrorCode = s === 429 ? 'rate_limited' : 'internal';
      send(res, s, { error: `injected ${s}`, code }, s === 429 ? { 'retry-after': '1' } : {});
      return;
    }

    try {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${token}`) throw new HttpError(401, 'unauthorized', 'missing or invalid token');
      const proto = req.headers[PROTOCOL_HEADER];
      if (proto !== String(PROTOCOL_VERSION)) {
        throw new HttpError(400, 'protocol_unsupported', `protocol ${String(proto)} is not supported`, {
          supported: [PROTOCOL_VERSION],
        });
      }

      const body = method === 'POST' ? JSON.parse((await readBody(req)).toString('utf8') || 'null') : null;
      let m: RegExpMatchArray | null;

      if (method === 'POST' && path === '/ingest/v1/batches') {
        const r = openBatch(body);
        return send(res, r.status, r.json);
      }
      if (method === 'GET' && (m = path.match(/^\/ingest\/v1\/batches\/([^/]+)\/baseline$/))) {
        return send(res, 200, lookupBaseline(m[1]!, url.searchParams.get('document_path')));
      }
      if (method === 'POST' && (m = path.match(/^\/ingest\/v1\/batches\/([^/]+)\/runs$/))) {
        const r = createRun(m[1]!, body);
        return send(res, r.status, r.json);
      }
      if (method === 'POST' && (m = path.match(/^\/ingest\/v1\/runs\/([^/]+)\/complete$/))) {
        return send(res, 200, completeRun(m[1]!, body));
      }
      if (method === 'POST' && (m = path.match(/^\/ingest\/v1\/batches\/([^/]+)\/complete$/))) {
        return send(res, 200, completeBatch(m[1]!, body));
      }
      send(res, 404, { error: 'no such route', code: 'internal' });
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
      } else if (err instanceof SyntaxError) {
        send(res, 400, { error: 'body is not JSON', code: 'payload_invalid' });
      } else {
        send(res, 500, { error: (err as Error).message, code: 'internal' });
      }
    }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: baseUrl,
    token,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),

    setBaseline(documentPath, snapshot, o = {}) {
      const snap = snapshot as { contentHash?: string };
      if (typeof snap?.contentHash !== 'string') throw new Error('setBaseline: snapshot needs a contentHash');
      ensureDocument(documentPath);
      const runId = id('run');
      const key = `org/test/${runId}/structure.json.gz`;
      // Stored uncompressed for test ergonomics; the real service serves the gzipped blob as uploaded.
      state.objects.set(key, Buffer.from(JSON.stringify(snapshot)));
      const b: StoredBaseline = {
        run_id: runId,
        commit: o.commit ?? '0'.repeat(40),
        structure_hash: snap.contentHash,
        structure_key: key,
        renderer_id: o.rendererId ?? null,
        image_dpi: o.dpi ?? null,
      };
      state.baselines.set(documentPath, b);
      return b;
    },

    promote(runId) {
      const run = state.runs.get(runId);
      if (!run) throw new Error(`promote: no run ${runId}`);
      const b: StoredBaseline = {
        run_id: run.run_id,
        commit: run.head_commit,
        structure_hash: run.structure_hash,
        structure_key: run.structure_key,
        renderer_id: run.renderer_id,
        image_dpi: run.image_dpi,
      };
      state.baselines.set(run.document_path, b);
      if (run.review_state === 'awaiting_review') run.review_state = 'accepted';
      state.promotions.push({ document_path: run.document_path, run_id: run.run_id, commit: run.head_commit, kind: 'promoted' });
      return b;
    },

    failNext(status, times = 1) {
      failures.status = status;
      failures.remaining = times;
    },
    setPrivacyMode(mode) {
      privacyMode = mode;
    },

    ...state,
  };
}
