/**
 * Executable form of PROTOCOL.md. Every request and response the CLI and the
 * service exchange is described here once; both sides validate with these.
 * When this file and PROTOCOL.md disagree, the document wins and this is a bug.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const PROTOCOL_HEADER = 'x-pdf-testkit-protocol';
export const TOKEN_PREFIX = 'ptk_';

// ---------------------------------------------------------------------------
// Primitives

export const CommitSha = z.string().regex(/^[0-9a-f]{40}$/, 'expected a 40-char lowercase hex commit');
export const StructureHash = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'expected sha256:<64 hex>');
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 hex chars');
/** Repository-relative, forward-slash, no leading `./` or `/`, no backslashes or NUL. */
export const RepoPath = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^(?!\.\.?\/)(?!\/)[^\0\\]+$/, 'expected a repository-relative forward-slash path');
export const Severity = z.enum(['info', 'warn', 'error']);
export const FailOn = z.enum(['error', 'warn', 'any']);
export const Presence = z.enum(['tracked', 'missing', 'untracked']);
export const PrivacyMode = z.enum(['A', 'B']);
export const RunKind = z.enum(['established', 'compared']);
export const Outcome = z.enum(['passed', 'blocked']);
export const ReviewState = z.enum(['not_required', 'awaiting_review', 'accepted', 'rejected', 'superseded']);
export const Producer = z.enum(['formepdf', 'pdfjs']);

const nonNegInt = z.number().int().min(0);
const posInt = z.number().int().min(1);

// ---------------------------------------------------------------------------
// §2 Batches

export const Repository = z.object({
  provider: z.literal('github'),
  owner: z.string().min(1),
  name: z.string().min(1),
});

export const BatchRequest = z.object({
  repository: Repository,
  head_commit: CommitSha,
  branch: z.string().min(1),
  pr: z
    .object({ number: posInt, base_branch: z.string().min(1), head_branch: z.string().min(1) })
    .nullable(),
  ci: z.object({
    provider: z.enum(['github-actions', 'other']),
    run_id: z.string().min(1),
    run_attempt: posInt,
    run_url: z.string().url().nullable(),
    actor: z.string().min(1).nullable(),
  }),
  tool: z.object({
    name: z.literal('pdf-testkit'),
    version: z.string().min(1),
    protocol_version: z.literal(PROTOCOL_VERSION),
    snapshot_schema_version: z.literal(SNAPSHOT_SCHEMA_VERSION),
  }),
});

export const BatchResponse = z.object({
  batch_id: z.string().min(1),
  resumed: z.boolean(),
  repository: z.object({ default_branch: z.string().min(1), is_default_branch: z.boolean() }),
  org: z.object({ privacy_mode: PrivacyMode }),
});

// ---------------------------------------------------------------------------
// §3 Baseline lookup

export const BaselineRef = z.object({
  run_id: z.string().min(1),
  commit: CommitSha,
  structure_hash: StructureHash,
  snapshot_schema_version: z.number().int(),
  structure_url: z.string().url(),
  structure_encoding: z.literal('gzip'),
  renderer_id: z.string().min(1).nullable(),
  image_dpi: z.number().int().nullable(),
});

export const BaselineResponse = z.object({
  document: z.object({ document_id: z.string().min(1), path: RepoPath, presence: Presence }).nullable(),
  baseline: BaselineRef.nullable(),
});

// ---------------------------------------------------------------------------
// §4 Runs

/**
 * The envelope every reported event must have. Everything else the OSS put on
 * the event passes through untouched — events are stored as reported, so a new
 * event type or a new field never breaks ingest.
 */
export const ReportedEvent = z
  .object({
    index: nonNegInt,
    type: z.string().min(1),
    severity: Severity,
    message: z.string(),
    confidence: z.number().min(0).max(1),
  })
  .passthrough();

export const ReportedGroup = z.object({
  index: nonNegInt,
  kind: z.string().min(1),
  severity: Severity,
  summary: z.string(),
  root_index: nonNegInt,
  member_indices: z.array(nonNegInt).min(1),
});

export const Diff = z.object({
  events: z.array(ReportedEvent),
  groups: z.array(ReportedGroup),
  gate: z.object({ fail_on: FailOn }),
  timings: z.object({
    extract_ms: nonNegInt,
    diff_ms: nonNegInt,
    render_ms: nonNegInt.nullable(),
    nodes_compared: nonNegInt,
  }),
  baseline_hash: StructureHash,
});

export const ImagePage = z.object({
  index: nonNegInt,
  width_px: posInt,
  height_px: posInt,
  byte_size: posInt,
  sha256: Sha256Hex,
});

export const Images = z.object({
  renderer_id: z.string().min(1),
  dpi: z.number().int().min(72).max(300),
  format: z.literal('image/webp'),
  pages: z.array(ImagePage),
});

export const Structure = z.object({
  hash: StructureHash,
  byte_size: posInt,
  encoding: z.literal('gzip'),
  snapshot_schema_version: z.literal(SNAPSHOT_SCHEMA_VERSION),
  producer: Producer,
  page_count: nonNegInt,
  node_count: nonNegInt,
});

export const RunRequest = z
  .object({
    document_path: RepoPath,
    kind: RunKind,
    baseline_run_id: z.string().min(1).nullable(),
    structure: Structure,
    diff: Diff.nullable(),
    images: Images.nullable(),
  })
  .superRefine((run, ctx) => {
    if (run.kind === 'established') {
      if (run.baseline_run_id !== null)
        ctx.addIssue({ code: 'custom', path: ['baseline_run_id'], message: 'an established run has no baseline' });
      if (run.diff !== null) ctx.addIssue({ code: 'custom', path: ['diff'], message: 'an established run has no diff' });
      return;
    }
    if (run.baseline_run_id === null)
      ctx.addIssue({ code: 'custom', path: ['baseline_run_id'], message: 'a compared run names its baseline' });
    if (run.diff === null) {
      ctx.addIssue({ code: 'custom', path: ['diff'], message: 'a compared run carries a diff' });
      return;
    }
    const { events, groups } = run.diff;
    events.forEach((e, i) => {
      if (e.index !== i)
        ctx.addIssue({ code: 'custom', path: ['diff', 'events', i, 'index'], message: `event index must equal position ${i}` });
    });
    // Groups are a view over the event list: their members must partition it exactly.
    const seen = new Map<number, number>();
    groups.forEach((g, gi) => {
      if (g.index !== gi)
        ctx.addIssue({ code: 'custom', path: ['diff', 'groups', gi, 'index'], message: `group index must equal position ${gi}` });
      if (!g.member_indices.includes(g.root_index))
        ctx.addIssue({ code: 'custom', path: ['diff', 'groups', gi, 'root_index'], message: 'root must be a member of its group' });
      for (const m of g.member_indices) {
        if (m >= events.length)
          ctx.addIssue({ code: 'custom', path: ['diff', 'groups', gi, 'member_indices'], message: `member ${m} is not an event` });
        seen.set(m, (seen.get(m) ?? 0) + 1);
      }
    });
    if (events.length > 0 || groups.length > 0) {
      const missing = events.map((_, i) => i).filter((i) => !seen.has(i));
      const dup = [...seen].filter(([, n]) => n > 1).map(([i]) => i);
      if (missing.length)
        ctx.addIssue({ code: 'custom', path: ['diff', 'groups'], message: `events not covered by any group: ${missing.join(',')}` });
      if (dup.length)
        ctx.addIssue({ code: 'custom', path: ['diff', 'groups'], message: `events covered more than once: ${dup.join(',')}` });
    }
  });

export const PresignedPut = z.object({
  method: z.literal('PUT'),
  url: z.string().url(),
  headers: z.record(z.string()),
});

export const RunResponse = z.object({
  run_id: z.string().min(1),
  disposition: z.enum(['created', 'replaced', 'unchanged']),
  kind: RunKind,
  outcome: Outcome,
  review_state: ReviewState,
  uploads: z
    .object({
      structure: PresignedPut,
      images: z.array(PresignedPut.extend({ index: nonNegInt })),
    })
    .nullable(),
});

// ---------------------------------------------------------------------------
// §6 / §7 Completion

export const RunCompleteRequest = z.object({
  structure_uploaded: z.literal(true),
  image_indices_uploaded: z.array(nonNegInt),
});
export const RunCompleteResponse = z.object({ run_id: z.string().min(1), status: z.literal('ready') });

export const BatchCompleteRequest = z.object({
  document_paths: z.array(RepoPath),
  failed: z.array(z.object({ document_path: RepoPath, reason: z.string().min(1) })),
});
export const BatchCompleteResponse = z.object({
  batch_id: z.string().min(1),
  status: z.literal('complete'),
  runs_ready: nonNegInt,
});

// ---------------------------------------------------------------------------
// §8 Errors

export const ErrorCode = z.enum([
  'unauthorized',
  'repository_mismatch',
  'payload_invalid',
  'protocol_unsupported',
  'snapshot_schema_unsupported',
  'privacy_mode_forbids_images',
  'batch_not_found',
  'run_not_found',
  'baseline_moved',
  'baseline_exists',
  'upload_incomplete',
  'rate_limited',
  'internal',
]);

export const ErrorResponse = z.object({
  error: z.string(),
  code: ErrorCode,
  details: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Types

export type BatchRequest = z.infer<typeof BatchRequest>;
export type BatchResponse = z.infer<typeof BatchResponse>;
export type BaselineRef = z.infer<typeof BaselineRef>;
export type BaselineResponse = z.infer<typeof BaselineResponse>;
export type ReportedEvent = z.infer<typeof ReportedEvent>;
export type ReportedGroup = z.infer<typeof ReportedGroup>;
export type Diff = z.infer<typeof Diff>;
export type Images = z.infer<typeof Images>;
export type ImagePage = z.infer<typeof ImagePage>;
export type Structure = z.infer<typeof Structure>;
export type RunRequest = z.infer<typeof RunRequest>;
export type RunResponse = z.infer<typeof RunResponse>;
export type PresignedPut = z.infer<typeof PresignedPut>;
export type RunCompleteRequest = z.infer<typeof RunCompleteRequest>;
export type RunCompleteResponse = z.infer<typeof RunCompleteResponse>;
export type BatchCompleteRequest = z.infer<typeof BatchCompleteRequest>;
export type BatchCompleteResponse = z.infer<typeof BatchCompleteResponse>;
export type ErrorCode = z.infer<typeof ErrorCode>;
export type ErrorResponse = z.infer<typeof ErrorResponse>;
export type Severity = z.infer<typeof Severity>;
export type FailOn = z.infer<typeof FailOn>;
export type Outcome = z.infer<typeof Outcome>;
export type ReviewState = z.infer<typeof ReviewState>;
export type PrivacyMode = z.infer<typeof PrivacyMode>;
export type Presence = z.infer<typeof Presence>;
export type RunKind = z.infer<typeof RunKind>;
export type Producer = z.infer<typeof Producer>;
