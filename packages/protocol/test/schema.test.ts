import { describe, expect, it } from 'vitest';
import {
  BatchRequest,
  RunRequest,
  PROTOCOL_VERSION,
  computeOutcome,
} from '../src/index.js';

const COMMIT = '8f2c1de'.padEnd(40, '0');
const HASH = 'sha256:' + 'a'.repeat(64);
const BASE_HASH = 'sha256:' + 'b'.repeat(64);

const batch = () => ({
  repository: { provider: 'github', owner: 'meridian', name: 'billing-service' },
  head_commit: COMMIT,
  branch: 'feat/tax-lines',
  pr: { number: 482, base_branch: 'main', head_branch: 'feat/tax-lines' },
  ci: { provider: 'github-actions', run_id: '11223344', run_attempt: 1, run_url: null, actor: 'priya' },
  tool: { name: 'pdf-testkit', version: '0.2.0', protocol_version: PROTOCOL_VERSION, snapshot_schema_version: 1 },
});

const event = (index: number, severity: 'info' | 'warn' | 'error', extra: Record<string, unknown> = {}) => ({
  index,
  type: 'page-count-changed',
  severity,
  message: 'page count changed 3 → 4',
  confidence: 1,
  ...extra,
});

const compared = () => ({
  document_path: 'fixtures/invoice.pdf',
  kind: 'compared',
  baseline_run_id: 'run_base',
  structure: {
    hash: HASH,
    byte_size: 1234,
    encoding: 'gzip',
    snapshot_schema_version: 1,
    producer: 'pdfjs',
    page_count: 4,
    node_count: 1284,
  },
  diff: {
    events: [event(0, 'error', { from: 3, to: 4 }), event(1, 'warn', { nodeId: '1:table:0', baseNodeId: '1:table:0' })],
    groups: [
      { index: 0, kind: 'single', severity: 'error', summary: 'page count changed', root_index: 0, member_indices: [0] },
      { index: 1, kind: 'single', severity: 'warn', summary: 'table moved', root_index: 1, member_indices: [1] },
    ],
    gate: { fail_on: 'error' },
    timings: { extract_ms: 300, diff_ms: 40, render_ms: null, nodes_compared: 1284 },
    baseline_hash: BASE_HASH,
  },
  images: null,
});

describe('BatchRequest schema', () => {
  it('accepts a well-formed batch request', () => {
    expect(BatchRequest.safeParse(batch()).success).toBe(true);
  });

  it('rejects a non-40-hex head commit', () => {
    const r = BatchRequest.safeParse({ ...batch(), head_commit: '8f2c1de' });
    expect(r.success).toBe(false);
  });

  it('rejects a protocol version other than the one this package speaks', () => {
    const b = batch();
    b.tool.protocol_version = 2 as 1;
    expect(BatchRequest.safeParse(b).success).toBe(false);
  });

  it('rejects run_attempt below 1', () => {
    const b = batch();
    b.ci.run_attempt = 0;
    expect(BatchRequest.safeParse(b).success).toBe(false);
  });
});

describe('RunRequest schema', () => {
  it('accepts a compared run and passes unknown event fields through as reported', () => {
    const r = RunRequest.safeParse(compared());
    expect(r.success).toBe(true);
    if (!r.success) return;
    const ev = r.data.diff!.events[0] as Record<string, unknown>;
    expect(ev.from).toBe(3);
    expect(ev.to).toBe(4);
  });

  it('rejects an established run that carries a diff or a baseline', () => {
    const r = RunRequest.safeParse({ ...compared(), kind: 'established' });
    expect(r.success).toBe(false);
  });

  it('accepts an established run with no diff and no baseline', () => {
    const r = RunRequest.safeParse({ ...compared(), kind: 'established', baseline_run_id: null, diff: null });
    expect(r.success).toBe(true);
  });

  it('rejects a compared run without a baseline_run_id', () => {
    const r = RunRequest.safeParse({ ...compared(), baseline_run_id: null });
    expect(r.success).toBe(false);
  });

  it('rejects events whose index does not match their position', () => {
    const c = compared();
    c.diff.events[1]!.index = 5;
    expect(RunRequest.safeParse(c).success).toBe(false);
  });

  it('rejects groups that do not partition the event list exactly', () => {
    const c = compared();
    c.diff.groups = [c.diff.groups[0]!]; // event 1 uncovered
    expect(RunRequest.safeParse(c).success).toBe(false);
    const d = compared();
    d.diff.groups[1]!.member_indices = [0, 1]; // event 0 covered twice
    expect(RunRequest.safeParse(d).success).toBe(false);
  });

  it('rejects a group whose root is not among its members', () => {
    const c = compared();
    c.diff.groups[1]!.root_index = 0;
    expect(RunRequest.safeParse(c).success).toBe(false);
  });

  it('rejects a repository path with a leading ./ or /', () => {
    expect(RunRequest.safeParse({ ...compared(), document_path: './fixtures/a.pdf' }).success).toBe(false);
    expect(RunRequest.safeParse({ ...compared(), document_path: '/fixtures/a.pdf' }).success).toBe(false);
  });

  it('validates image page entries', () => {
    const c = compared();
    const images = {
      renderer_id: 'pdfjs-4.10.38',
      dpi: 150,
      format: 'image/webp',
      pages: [{ index: 0, width_px: 1275, height_px: 1650, byte_size: 100, sha256: 'f'.repeat(64) }],
    };
    expect(RunRequest.safeParse({ ...c, images }).success).toBe(true);
    images.pages[0]!.sha256 = 'nope';
    expect(RunRequest.safeParse({ ...c, images }).success).toBe(false);
  });
});

describe('computeOutcome', () => {
  it('blocks only at or above the gate, and awaits review whenever any event exists', () => {
    const warnOnly = [event(0, 'warn'), event(1, 'info')];
    expect(computeOutcome(warnOnly, 'error')).toEqual({ outcome: 'passed', review_state: 'awaiting_review' });
    expect(computeOutcome(warnOnly, 'warn')).toEqual({ outcome: 'blocked', review_state: 'awaiting_review' });
    expect(computeOutcome([event(0, 'info')], 'any')).toEqual({ outcome: 'blocked', review_state: 'awaiting_review' });
    expect(computeOutcome([], 'any')).toEqual({ outcome: 'passed', review_state: 'not_required' });
  });
});
