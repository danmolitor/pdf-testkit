import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  diffSnapshots,
  fromPdf,
  groupEvents,
  loadSnapshotFromFile,
  renderPages,
  serializeSnapshot,
  type DiffResult,
  type RenderedPages,
  type SemanticEvent,
  type StructuralSnapshot,
} from '@pdf-testkit/core';
import {
  computeOutcome,
  type BaselineResponse,
  type BatchCompleteResponse,
  type BatchRequest,
  type BatchResponse,
  type FailOn,
  type RunCompleteResponse,
  type RunRequest,
  type RunResponse,
} from '@pdf-testkit/protocol';
import { ServiceClient, ServiceClientError, ServiceUnavailableError } from './service/client.js';
import type { CiContext } from './service/context.js';
import { EXIT } from './exit.js';

const require = createRequire(import.meta.url);
export const CLI_VERSION: string = (require('../package.json') as { version: string }).version;

export interface UploadOptions {
  documents: string[];
  serviceUrl: string;
  token: string;
  context: CiContext;
  cwd?: string;
  dpi: number;
  images: boolean;
  /** The customer's gate. `null` = do not fail locally; the service's check is the gate. */
  failOn: FailOn | null;
  requireService: boolean;
  retryDelaysMs?: number[];
  log?: (line: string) => void;
  /** Test hook: runs just before each run-creation request. */
  onBeforeRun?: () => void;
}

export interface UploadedDocument {
  path: string;
  status: 'created' | 'replaced' | 'unchanged' | 'failed';
  runId?: string;
  kind?: 'established' | 'compared';
  outcome?: 'passed' | 'blocked';
  reviewState?: string;
  events?: number;
  reason?: string;
}

export interface UploadResult {
  exitCode: number;
  batchId: string | null;
  documents: UploadedDocument[];
  /** Set when the service could not be reached (warn-and-pass, PROTOCOL.md §8). */
  unavailable?: string;
  /** Set on a configuration error (exit 2). */
  error?: string;
}

type Loaded = { snapshot: StructuralSnapshot; pdfBytes: Uint8Array | null; extractMs: number };

/** Repository-relative, forward slashes, no leading `./`. */
export function normalizeDocumentPath(p: string, cwd: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  let rel = relative(cwd, abs);
  if (sep !== '/') rel = rel.split(sep).join('/');
  if (rel.startsWith('../') || rel === '..') {
    throw new Error(`document ${p} is outside the working directory; run from the repository root`);
  }
  return rel;
}

async function loadDocument(absPath: string): Promise<Loaded> {
  const t0 = performance.now();
  if (absPath.toLowerCase().endsWith('.pdf')) {
    const bytes = new Uint8Array(await readFile(absPath));
    const snapshot = await fromPdf(bytes, { source: { name: absPath } });
    return { snapshot, pdfBytes: bytes, extractMs: Math.round(performance.now() - t0) };
  }
  const snapshot = await loadSnapshotFromFile(absPath);
  return { snapshot, pdfBytes: null, extractMs: Math.round(performance.now() - t0) };
}

function parseBaselineBlob(bytes: Uint8Array): StructuralSnapshot {
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = Buffer.from(isGzip ? gunzipSync(bytes) : bytes).toString('utf8');
  return JSON.parse(text) as StructuralSnapshot;
}

function toReportedDiff(base: StructuralSnapshot, next: StructuralSnapshot, result: DiffResult, failOn: FailOn, timings: { extractMs: number; diffMs: number; renderMs: number | null }): NonNullable<RunRequest['diff']> {
  const index = new Map<SemanticEvent, number>(result.events.map((e, i) => [e, i]));
  const groups = groupEvents(base, next, result.events);
  return {
    events: result.events.map((e, i) => ({ ...e, index: i })),
    groups: groups.map((g, gi) => ({
      index: gi,
      kind: g.kind,
      severity: g.severity,
      summary: g.summary,
      root_index: index.get(g.root)!,
      member_indices: g.events.map((e) => index.get(e)!),
    })),
    gate: { fail_on: failOn },
    timings: {
      extract_ms: timings.extractMs,
      diff_ms: timings.diffMs,
      render_ms: timings.renderMs,
      nodes_compared: result.stats.pairs + result.stats.added + result.stats.removed,
    },
    baseline_hash: base.contentHash,
  };
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/**
 * `pdf-testkit upload`: PROTOCOL.md §1 end to end for one CI job. Returns an
 * exit code rather than exiting so it can be driven in-process by tests.
 */
export async function runUpload(opts: UploadOptions): Promise<UploadResult> {
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.log ?? ((l: string) => process.stderr.write(l + '\n'));
  const gate: FailOn = opts.failOn ?? 'error';
  const client = new ServiceClient({
    baseUrl: opts.serviceUrl.replace(/\/$/, ''),
    token: opts.token,
    userAgent: `pdf-testkit-cli/${CLI_VERSION}`,
    retryDelaysMs: opts.retryDelaysMs,
  });
  const result: UploadResult = { exitCode: EXIT.ok, batchId: null, documents: [] };
  const ctx = opts.context;

  try {
    const batch = await client.post<BatchResponse>('/ingest/v1/batches', {
      repository: { provider: 'github', owner: ctx.repository.owner, name: ctx.repository.name },
      head_commit: ctx.headCommit,
      branch: ctx.branch,
      pr: ctx.pr ? { number: ctx.pr.number, base_branch: ctx.pr.baseBranch, head_branch: ctx.pr.headBranch } : null,
      ci: { provider: ctx.ci.provider, run_id: ctx.ci.runId, run_attempt: ctx.ci.runAttempt, run_url: ctx.ci.runUrl, actor: ctx.ci.actor },
      tool: { name: 'pdf-testkit', version: CLI_VERSION, protocol_version: 1, snapshot_schema_version: 1 },
    } satisfies BatchRequest);
    result.batchId = batch.batch_id;
    const wantImages = opts.images && batch.org.privacy_mode !== 'B';
    if (opts.images && batch.org.privacy_mode === 'B') log('note: this org stores structure only; page images will not be rendered');

    const reported: string[] = [];
    const failed: { document_path: string; reason: string }[] = [];
    let gateHit = false;
    let configError: string | null = null;

    for (const given of opts.documents) {
      let path: string;
      try {
        path = normalizeDocumentPath(given, cwd);
      } catch (err) {
        result.documents.push({ path: given, status: 'failed', reason: (err as Error).message });
        failed.push({ document_path: given.replace(/^\.\//, ''), reason: (err as Error).message });
        configError ??= (err as Error).message;
        continue;
      }
      try {
        const doc = await uploadOne(client, batch.batch_id, path, resolve(cwd, path), { ...opts, gate, wantImages, log });
        result.documents.push(doc);
        reported.push(path);
        if (opts.failOn && doc.outcome === 'blocked') gateHit = true;
      } catch (err) {
        if (err instanceof ServiceUnavailableError || (err instanceof ServiceClientError && err.status !== 409)) throw err;
        const reason = (err as Error).message;
        result.documents.push({ path, status: 'failed', reason });
        failed.push({ document_path: path, reason });
        configError ??= `${path}: ${reason}`;
        log(`✗ ${path}: ${reason}`);
      }
    }

    const done = await client.post<BatchCompleteResponse>(`/ingest/v1/batches/${batch.batch_id}/complete`, { document_paths: reported, failed });
    log(`batch ${batch.batch_id} complete: ${done.runs_ready} run(s) ready` + (failed.length ? `, ${failed.length} failed` : ''));

    if (configError) {
      result.exitCode = EXIT.config;
      result.error = configError;
    } else if (gateHit) {
      result.exitCode = EXIT.gate;
    }
    return result;
  } catch (err) {
    if (err instanceof ServiceUnavailableError) {
      result.unavailable = err.message;
      log(`warning: pdf-testkit service unavailable — ${err.message}`);
      log(opts.requireService ? 'failing because --require-service is set' : 'passing; nothing was recorded for this run');
      result.exitCode = opts.requireService ? EXIT.unavailable : EXIT.ok;
      return result;
    }
    if (err instanceof ServiceClientError) {
      result.error = `${err.code}: ${err.message}`;
      log(`error: ${result.error}`);
      result.exitCode = EXIT.config;
      return result;
    }
    throw err;
  }
}

async function uploadOne(
  client: ServiceClient,
  batchId: string,
  path: string,
  absPath: string,
  o: UploadOptions & { gate: FailOn; wantImages: boolean; log: (l: string) => void },
): Promise<UploadedDocument> {
  const loaded = await loadDocument(absPath);
  const { snapshot } = loaded;

  let rendered: RenderedPages | null = null;
  let renderMs: number | null = null;
  if (o.wantImages && loaded.pdfBytes) {
    const t0 = performance.now();
    rendered = await renderPages(loaded.pdfBytes, { dpi: o.dpi });
    renderMs = Math.round(performance.now() - t0);
  }

  const blob = gzipSync(Buffer.from(serializeSnapshot(snapshot, false)));
  const structure: RunRequest['structure'] = {
    hash: snapshot.contentHash,
    byte_size: blob.length,
    encoding: 'gzip',
    snapshot_schema_version: 1,
    producer: snapshot.producer,
    page_count: snapshot.pageCount,
    node_count: snapshot.nodes.length,
  };
  const images: RunRequest['images'] = rendered
    ? {
        renderer_id: rendered.rendererId,
        dpi: rendered.dpi,
        format: 'image/webp',
        pages: rendered.pages.map((p) => ({ index: p.index, width_px: p.widthPx, height_px: p.heightPx, byte_size: p.bytes.length, sha256: sha256(p.bytes) })),
      }
    : null;

  // Baseline → diff → run, with one retry if the baseline moves in between (§4).
  let response: RunResponse | null = null;
  let kind: 'established' | 'compared' = 'compared';
  let eventCount = 0;
  for (let attempt = 0; attempt < 2 && !response; attempt++) {
    const lookup = await client.get<BaselineResponse>(`/ingest/v1/batches/${batchId}/baseline?document_path=${encodeURIComponent(path)}`);
    let request: RunRequest;
    if (!lookup.baseline) {
      kind = 'established';
      request = { document_path: path, kind, baseline_run_id: null, structure, diff: null, images };
    } else {
      kind = 'compared';
      const base = parseBaselineBlob(await client.getObject(lookup.baseline.structure_url));
      const t0 = performance.now();
      const diff = diffSnapshots(base, snapshot);
      const diffMs = Math.round(performance.now() - t0);
      eventCount = diff.events.length;
      request = {
        document_path: path,
        kind,
        baseline_run_id: lookup.baseline.run_id,
        structure,
        diff: toReportedDiff(base, snapshot, diff, o.gate, { extractMs: loaded.extractMs, diffMs, renderMs }),
        images,
      };
    }
    o.onBeforeRun?.();
    try {
      response = await client.post<RunResponse>(`/ingest/v1/batches/${batchId}/runs`, request);
    } catch (err) {
      const moved = err instanceof ServiceClientError && (err.code === 'baseline_moved' || err.code === 'baseline_exists');
      if (!moved || attempt === 1) throw err;
      o.log(`baseline for ${path} moved while uploading; re-comparing`);
    }
  }
  const run = response!;

  if (run.uploads) {
    await client.putObject(run.uploads.structure.url, run.uploads.structure.headers, blob);
    const uploadedIdx: number[] = [];
    for (const target of run.uploads.images) {
      const page = rendered?.pages.find((p) => p.index === target.index);
      if (!page) continue;
      await client.putObject(target.url, target.headers, page.bytes);
      uploadedIdx.push(target.index);
    }
    await client.post<RunCompleteResponse>(`/ingest/v1/runs/${run.run_id}/complete`, { structure_uploaded: true, image_indices_uploaded: uploadedIdx });
  }

  const summary =
    kind === 'established'
      ? 'baseline established (nothing compared)'
      : `${eventCount} event(s) · ${run.outcome} · ${run.review_state}`;
  o.log(`${run.disposition === 'unchanged' ? '=' : '✓'} ${path}: ${summary}${run.disposition === 'unchanged' ? ' (unchanged; existing run kept)' : ''}`);

  return { path, status: run.disposition, runId: run.run_id, kind: run.kind, outcome: run.outcome, reviewState: run.review_state, events: eventCount };
}

export { computeOutcome };
