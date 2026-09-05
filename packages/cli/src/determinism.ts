import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadSnapshotFromFile, type StructuralNode, type StructuralSnapshot } from '@pdf-testkit/core';

const execAsync = promisify(exec);

export interface NodeDifference {
  /** `p<page> › <role>#<ordinal>` — where in the document the value lives. */
  path: string;
  field: 'text' | 'bbox' | 'font' | 'headingLevel' | 'overflow' | 'table' | 'presence';
  before: unknown;
  after: unknown;
}

export interface DeterminismReport {
  deterministic: boolean;
  hashes: [string, string];
  clockOffsetMs: number;
  differences: NodeDifference[];
}

/** `26h`, `90m`, `3d`, `1500s`, or a plain number of milliseconds. */
export function parseClockOffset(value: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(value.trim());
  if (!m) throw new Error(`--clock-offset: expected a duration like 26h, 90m, 3d (got "${value}")`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  const mult: Record<string, number> = { ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 };
  return Math.round(n * mult[unit]!);
}

export const PRELOAD_PATH = fileURLToPath(new URL('../preload/fake-clock.cjs', import.meta.url));

async function renderOnce(cmd: string, outPath: string, clockOffsetMs: number): Promise<StructuralSnapshot> {
  const env = { ...process.env };
  if (clockOffsetMs) {
    env.PDF_TESTKIT_CLOCK_OFFSET_MS = String(clockOffsetMs);
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(PRELOAD_PATH)}`.trim();
  }
  try {
    await execAsync(cmd, { env, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    throw new Error(`render command failed (exit ${e.code ?? '?'}): ${cmd}\n${(e.stderr ?? '').trim()}`);
  }
  return loadSnapshotFromFile(outPath);
}

/**
 * Lifecycle spec §1: render twice in one invocation, extract both, and report
 * differing nodes with both values — not a boolean. The second render can be
 * clock-shifted so a fixture that embeds today's date fails today, not tomorrow.
 */
export async function checkDeterminism(opts: {
  cmd: string;
  outPath: string;
  clockOffsetMs?: number;
}): Promise<DeterminismReport> {
  const offset = opts.clockOffsetMs ?? 0;
  const first = await renderOnce(opts.cmd, opts.outPath, 0);
  const second = await renderOnce(opts.cmd, opts.outPath, offset);
  const differences = first.contentHash === second.contentHash ? [] : compareSnapshots(first, second);
  return {
    deterministic: first.contentHash === second.contentHash,
    hashes: [first.contentHash, second.contentHash],
    clockOffsetMs: offset,
    differences,
  };
}

const nodePath = (n: StructuralNode): string => {
  const [, role, ordinal] = n.id.split(':');
  return `p${n.pageIndex + 1} › ${role}#${ordinal}`;
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Node-by-node comparison keyed on the stable in-snapshot id. */
export function compareSnapshots(a: StructuralSnapshot, b: StructuralSnapshot): NodeDifference[] {
  const out: NodeDifference[] = [];
  if (a.pageCount !== b.pageCount) {
    out.push({ path: 'document', field: 'presence', before: `${a.pageCount} pages`, after: `${b.pageCount} pages` });
  }
  const byId = new Map(b.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  for (const na of a.nodes) {
    const nb = byId.get(na.id);
    if (!nb) {
      out.push({ path: nodePath(na), field: 'presence', before: na.text ?? na.role, after: null });
      continue;
    }
    seen.add(na.id);
    const fields = ['text', 'bbox', 'font', 'headingLevel', 'overflow', 'table'] as const;
    for (const f of fields) {
      if (!same(na[f], nb[f])) out.push({ path: nodePath(na), field: f, before: na[f] ?? null, after: nb[f] ?? null });
    }
  }
  for (const nb of b.nodes) {
    if (!seen.has(nb.id) && !a.nodes.some((n) => n.id === nb.id)) {
      out.push({ path: nodePath(nb), field: 'presence', before: null, after: nb.text ?? nb.role });
    }
  }
  return out;
}

export function formatDeterminism(report: DeterminismReport, cmd: string): string {
  const offset = report.clockOffsetMs ? ` (second render clock-shifted by ${report.clockOffsetMs} ms)` : '';
  if (report.deterministic) {
    return `✓ deterministic: two renders of \`${cmd}\` extracted to the same structure${offset}\n  ${report.hashes[0]}`;
  }
  const lines = [
    `✗ not deterministic: ${report.differences.length} node value${report.differences.length === 1 ? '' : 's'} differed between two renders of \`${cmd}\`${offset}`,
    `  ${report.hashes[0]} → ${report.hashes[1]}`,
    '',
  ];
  for (const d of report.differences) {
    lines.push(`  ${d.path}  ${d.field}: ${fmt(d.before)} → ${fmt(d.after)}`);
  }
  lines.push('');
  lines.push('  If a differing field is meant to change, freeze it in the fixture data — the service cannot ignore it for you.');
  return lines.join('\n');
}

const fmt = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '—' : JSON.stringify(v));
