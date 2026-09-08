/**
 * Conformance results produced by a DIFFERENT tool in the customer's CI
 * (veraPDF, or anything through the documented JSON shape). This module reads
 * the report the customer points at and records what the validator said,
 * attributed to it by name and version. It never validates, never scores, and
 * never rejects a profile it does not recognise.
 *
 * Policy, stated here so it is not a backlog item: one third-party format
 * family is parsed — veraPDF's MRR report, XML and JSON — because veraPDF is the
 * reference validator for PDF/A and PDF/UA and its schema has been stable for
 * years. Everything else, including validators we use ourselves (Mustang for
 * e-invoicing), goes through `forme-review-conformance/1`, a documented JSON
 * file the customer's CI writes. No second parser.
 */

export type ConformanceVerdict = 'pass' | 'fail' | 'error';

export interface ConformanceFailure {
  clause: string;
  test: number | null;
  count: number;
  description: string;
}

export interface ConformanceResult {
  profile: string;
  verdict: ConformanceVerdict;
  tool: { name: string; version: string };
  ran_at: string | null;
  source: { format: string; file: string | null };
  failure_count: number;
  failures: ConformanceFailure[];
}

export interface ConformanceItem {
  /** The document path as the report names it (absolute or relative; matched later). */
  path: string;
  result: ConformanceResult;
}

export interface ParsedConformanceReport {
  format: 'verapdf-mrr-xml' | 'verapdf-json' | 'forme-review-conformance/1';
  items: ConformanceItem[];
}

export const CONFORMANCE_FAILURES_MAX = 200;
export const CONFORMANCE_DESCRIPTION_MAX = 300;
export const FORME_CONFORMANCE_FORMAT = 'forme-review-conformance/1';

export class ConformanceReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceReportError';
  }
}

/** Detect the format by content and parse. Throws ConformanceReportError on anything unreadable. */
export function parseConformanceReport(text: string, opts: { file?: string | null } = {}): ParsedConformanceReport {
  const file = opts.file ?? null;
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch (err) {
      throw new ConformanceReportError(`not valid JSON: ${(err as Error).message}`);
    }
    const obj = json as Record<string, unknown>;
    if (obj.format === FORME_CONFORMANCE_FORMAT) return parseFormeJson(obj, file);
    if (obj.report && typeof obj.report === 'object') return parseVeraJson(obj.report as Record<string, unknown>, file);
    throw new ConformanceReportError('not a veraPDF report or a Forme Review conformance file (JSON has neither "report" nor format "forme-review-conformance/1")');
  }
  if (trimmed.startsWith('<') && /<report\b/.test(trimmed) && /<job\b/.test(trimmed)) return parseVeraXml(trimmed, file);
  throw new ConformanceReportError('not a veraPDF report or a Forme Review conformance file');
}

// ---------------------------------------------------------------------------
// Profiles: short names for the ones we know, verbatim for the rest.

const PROFILE_NAMES: [RegExp, string][] = [
  [/^PDF\/UA-1\b/i, 'PDF/UA-1'],
  [/^PDF\/UA-2\b/i, 'PDF/UA-2'],
  [/^PDF\/A-1A\b/i, 'PDF/A-1a'],
  [/^PDF\/A-1B\b/i, 'PDF/A-1b'],
  [/^PDF\/A-2A\b/i, 'PDF/A-2a'],
  [/^PDF\/A-2B\b/i, 'PDF/A-2b'],
  [/^PDF\/A-2U\b/i, 'PDF/A-2u'],
  [/^PDF\/A-3A\b/i, 'PDF/A-3a'],
  [/^PDF\/A-3B\b/i, 'PDF/A-3b'],
  [/^PDF\/A-3U\b/i, 'PDF/A-3u'],
  [/^PDF\/A-4E\b/i, 'PDF/A-4e'],
  [/^PDF\/A-4F\b/i, 'PDF/A-4f'],
  [/^PDF\/A-4\b/i, 'PDF/A-4'],
];

/** "PDF/UA-1 validation profile" → "PDF/UA-1"; anything unknown keeps its name minus the suffix. */
export function profileShortName(reported: string): string {
  const bare = reported.replace(/\s+validation profile\s*$/i, '').trim();
  for (const [re, name] of PROFILE_NAMES) if (re.test(bare)) return name;
  return bare;
}

function cap(failures: ConformanceFailure[]): { failures: ConformanceFailure[]; failure_count: number } {
  return {
    failure_count: failures.length,
    failures: failures.slice(0, CONFORMANCE_FAILURES_MAX).map((f) => ({ ...f, description: f.description.length > CONFORMANCE_DESCRIPTION_MAX ? f.description.slice(0, CONFORMANCE_DESCRIPTION_MAX) : f.description })),
  };
}

const decodeXml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1]!, decodeXml(m[2]!)]));
const toIso = (epochMs: string | undefined): string | null => (epochMs && /^\d+$/.test(epochMs) ? new Date(Number(epochMs)).toISOString() : null);

// ---------------------------------------------------------------------------
// veraPDF MRR XML: <report><buildInformation>…<jobs><job><item><name>…</name></item>
//   <validationReport profileName isCompliant …><details><rule clause testNumber status failedChecks><description>…

function parseVeraXml(xml: string, file: string | null): ParsedConformanceReport {
  const version = xml.match(/<releaseDetails\b[^>]*\bid="core"[^>]*\bversion="([^"]+)"/)?.[1] ?? xml.match(/<releaseDetails\b[^>]*\bversion="([^"]+)"/)?.[1] ?? 'unknown';
  const items: ConformanceItem[] = [];
  for (const job of xml.matchAll(/<job\b[^>]*>([\s\S]*?)<\/job>/g)) {
    const body = job[1]!;
    const path = decodeXml(body.match(/<item\b[^>]*>[\s\S]*?<name>([^<]*)<\/name>/)?.[1] ?? '');
    if (!path) continue;
    const ranAt = toIso(body.match(/<duration\b[^>]*\bfinish="(\d+)"/)?.[1]);
    const vr = body.match(/<validationReport\b([^>]*)>/);
    if (!vr) {
      // No validation report at all: the validator could not assess the file.
      const message = decodeXml(body.match(/<exceptionMessage>([^<]*)<\/exceptionMessage>/)?.[1] ?? 'no validation report');
      items.push({ path, result: { profile: 'unknown', verdict: 'error', tool: { name: 'veraPDF', version }, ran_at: ranAt, source: { format: 'verapdf-mrr-xml', file }, failure_count: 0, failures: [] } });
      void message; // veraPDF's exception text is not a conformance failure; the verdict 'error' carries the fact
      continue;
    }
    const a = attrs(vr[1]!);
    const profile = profileShortName(a.profileName ?? 'unknown');
    const verdict: ConformanceVerdict = a.jobEndStatus && a.jobEndStatus !== 'normal' ? 'error' : a.isCompliant === 'true' ? 'pass' : 'fail';
    const failures: ConformanceFailure[] = [];
    for (const rule of body.matchAll(/<rule\b([^>]*)>([\s\S]*?)<\/rule>/g)) {
      const ra = attrs(rule[1]!);
      if (ra.status !== 'failed') continue;
      failures.push({ clause: ra.clause ?? '?', test: ra.testNumber ? Number(ra.testNumber) : null, count: Number(ra.failedChecks ?? 1), description: decodeXml(rule[2]!.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? '').trim() });
    }
    items.push({ path, result: { profile, verdict, tool: { name: 'veraPDF', version }, ran_at: ranAt, source: { format: 'verapdf-mrr-xml', file }, ...cap(verdict === 'error' ? [] : failures) } });
  }
  if (items.length === 0) throw new ConformanceReportError('veraPDF report contains no jobs');
  return { format: 'verapdf-mrr-xml', items };
}

// ---------------------------------------------------------------------------
// veraPDF JSON (--format json): report.jobs[].{itemDetails.name, validationResult{profileName, compliant, jobEndStatus, details.ruleSummaries[]}, taskException?}

function parseVeraJson(report: Record<string, unknown>, file: string | null): ParsedConformanceReport {
  const build = report.buildInformation as { releaseDetails?: { id?: string; version?: string }[] } | undefined;
  const version = build?.releaseDetails?.find((r) => r.id === 'core')?.version ?? build?.releaseDetails?.[0]?.version ?? 'unknown';
  const jobs = (report.jobs as Record<string, unknown>[] | undefined) ?? [];
  const items: ConformanceItem[] = [];
  for (const job of jobs) {
    const path = String((job.itemDetails as { name?: string } | undefined)?.name ?? '');
    if (!path) continue;
    const dur = job.duration as { finish?: number } | undefined;
    const ranAt = typeof dur?.finish === 'number' ? new Date(dur.finish).toISOString() : null;
    const vrRaw = job.validationResult;
    const vr = (Array.isArray(vrRaw) ? vrRaw[0] : vrRaw) as Record<string, unknown> | undefined;
    if (!vr) {
      items.push({ path, result: { profile: 'unknown', verdict: 'error', tool: { name: 'veraPDF', version }, ran_at: ranAt, source: { format: 'verapdf-json', file }, failure_count: 0, failures: [] } });
      continue;
    }
    const profile = profileShortName(String(vr.profileName ?? 'unknown'));
    const verdict: ConformanceVerdict = vr.jobEndStatus && vr.jobEndStatus !== 'normal' ? 'error' : vr.compliant === true ? 'pass' : 'fail';
    const summaries = ((vr.details as { ruleSummaries?: Record<string, unknown>[] } | undefined)?.ruleSummaries ?? []).filter((r) => String(r.status ?? r.ruleStatus ?? '').toLowerCase() === 'failed');
    const failures = summaries.map((r) => ({ clause: String(r.clause ?? '?'), test: typeof r.testNumber === 'number' ? r.testNumber : r.testNumber ? Number(r.testNumber) : null, count: Number(r.failedChecks ?? 1), description: String(r.description ?? '').trim() }));
    items.push({ path, result: { profile, verdict, tool: { name: 'veraPDF', version }, ran_at: ranAt, source: { format: 'verapdf-json', file }, ...cap(verdict === 'error' ? [] : failures) } });
  }
  if (items.length === 0) throw new ConformanceReportError('veraPDF report contains no jobs');
  return { format: 'verapdf-json', items };
}

// ---------------------------------------------------------------------------
// The documented shape: { format: 'forme-review-conformance/1', documents: { [path]: ConformanceResult[] } }

function parseFormeJson(obj: Record<string, unknown>, file: string | null): ParsedConformanceReport {
  const docs = obj.documents;
  if (!docs || typeof docs !== 'object') throw new ConformanceReportError('forme-review-conformance/1 needs a "documents" object keyed by document path');
  const items: ConformanceItem[] = [];
  for (const [path, list] of Object.entries(docs as Record<string, unknown>)) {
    if (!Array.isArray(list)) throw new ConformanceReportError(`documents["${path}"] must be an array of results`);
    for (const raw of list as Record<string, unknown>[]) {
      const verdict = raw.verdict;
      if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'error') throw new ConformanceReportError(`documents["${path}"]: verdict must be pass | fail | error`);
      const tool = raw.tool as { name?: unknown; version?: unknown } | undefined;
      if (!tool || typeof tool.name !== 'string' || typeof tool.version !== 'string') throw new ConformanceReportError(`documents["${path}"]: tool { name, version } is required`);
      if (typeof raw.profile !== 'string' || !raw.profile) throw new ConformanceReportError(`documents["${path}"]: profile is required`);
      const failures = (Array.isArray(raw.failures) ? raw.failures : []).map((f: Record<string, unknown>) => ({ clause: String(f.clause ?? '?'), test: typeof f.test === 'number' ? f.test : null, count: typeof f.count === 'number' ? f.count : 1, description: String(f.description ?? '') }));
      const src = raw.source as { format?: unknown } | undefined;
      const capped = cap(failures);
      items.push({ path, result: { profile: raw.profile, verdict, tool: { name: tool.name, version: tool.version }, ran_at: typeof raw.ran_at === 'string' ? raw.ran_at : null, source: { format: typeof src?.format === 'string' ? src.format : 'forme-review-conformance/1', file }, failure_count: typeof raw.failure_count === 'number' ? Math.max(raw.failure_count, capped.failure_count) : capped.failure_count, failures: capped.failures } });
    }
  }
  return { format: FORME_CONFORMANCE_FORMAT, items };
}

// ---------------------------------------------------------------------------
// Matching report items to the documents being uploaded: exact path, then basename.

const posix = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
const basename = (p: string): string => posix(p).slice(posix(p).lastIndexOf('/') + 1);

export function matchConformanceToDocuments(items: ConformanceItem[], documentPaths: string[]): { byDocument: Record<string, ConformanceResult[]>; unmatched: string[] } {
  const byDocument: Record<string, ConformanceResult[]> = {};
  const unmatched: string[] = [];
  const docs = documentPaths.map((d) => ({ path: d, norm: posix(d), base: basename(d) }));
  for (const item of items) {
    const norm = posix(item.path);
    const exact = docs.find((d) => d.norm === norm || norm.endsWith('/' + d.norm));
    const byBase = exact ?? docs.filter((d) => d.base === basename(item.path));
    const target = exact ?? (Array.isArray(byBase) && byBase.length === 1 ? byBase[0] : undefined);
    if (!target) {
      unmatched.push(item.path);
      continue;
    }
    (byDocument[target.path] ??= []).push(item.result);
  }
  return { byDocument, unmatched };
}
