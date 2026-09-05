# pdf-testkit ingest protocol — version 1

The contract between the pdf-testkit CLI (running in the customer's CI) and the
pdf-testkit cloud service. Everything crosses in one direction, CI → service, and
the PDF never crosses at all. The service stores, displays, decides and remembers;
it never renders or parses a document.

This document is the source of truth. The zod schemas in `src/schema.ts` are its
executable form, and `src/testing/fixture-server.ts` is a reference implementation
of the service side used by the CLI's tests. When the three disagree, this document
wins and the other two are bugs.

The presence of this schema in a public package documents how the CLI talks to the
service. It is not an offer of third-party producer support (baseline storage
spec §8).

---

## 0. Conventions

- Base URL: `PDF_TESTKIT_SERVICE_URL` (e.g. `https://api.pdf-testkit.dev`). All
  endpoints are under `/ingest/v1`.
- Auth: `Authorization: Bearer ptk_<token>` — the **per-repository CI token**.
  It can only write runs for its own repository. It cannot resolve reviews.
- Every request carries `X-PDF-Testkit-Protocol: 1` and a
  `User-Agent: pdf-testkit-cli/<version>`.
- Bodies are JSON (`application/json; charset=utf-8`). Artifacts (structure blob,
  page images) never transit the API tier: they go straight to object storage
  through presigned PUT URLs the service hands back.
- Timestamps are ISO-8601 UTC. Commits are 40-char lowercase hex. Paths are
  repository-relative, forward-slash, no leading `./`.
- Error responses are `{ "error": string, "code": ErrorCode, "details"?: object }`.

## 1. Flow

One CI job uploads every document it produced, in one CLI process:

```
pdf-testkit upload fixtures/invoice.pdf fixtures/report.pdf …
```

```
  CLI                                              service                 storage
   │ POST /batches  (repo, commit, branch, PR, CI run)  │                        │
   │◄─ batch_id, default branch, privacy mode ──────────│                        │
   │                                                    │                        │
   │ for each document:                                 │                        │
   │   GET /batches/{id}/baseline?document_path=…       │                        │
   │◄─ baseline {run_id, hash, structure_url} | null ───│                        │
   │   GET structure_url ───────────────────────────────┼───────────────────────►│
   │   (extract, render pages, diff locally)            │                        │
   │   POST /batches/{id}/runs  (events, hash, images)  │                        │
   │◄─ run_id, disposition, presigned PUT urls ─────────│                        │
   │   PUT structure.json.gz, PUT page-N.webp ──────────┼───────────────────────►│
   │   POST /runs/{run_id}/complete                     │ (verifies objects)     │
   │                                                    │                        │
   │ POST /batches/{id}/complete  (paths reported)      │                        │
```

Two requests per document plus the PUTs, not one: the CLI must **fetch the
baseline** to diff against, because diffing lives in the OSS (storage spec §6),
and the service does not know a document's events until the CLI has computed
them. The service's part is choosing *which* baseline (§2).

## 2. Batches — `POST /ingest/v1/batches`

A batch is one CI job's worth of uploads for one commit. It exists so that
absence can be evaluated only "relative to a batch that arrived" (lifecycle spec
§3b): a document counts as absent only when a *completed* default-branch batch
omitted it.

Request:

```jsonc
{
  "repository": { "provider": "github", "owner": "meridian", "name": "billing-service" },
  "head_commit": "8f2c1de…40 hex",
  "branch": "feat/tax-lines-per-item",           // head ref, no refs/heads/
  "pr": { "number": 482, "base_branch": "main", "head_branch": "feat/tax-lines-per-item" } | null,
  "ci": {
    "provider": "github-actions" | "other",
    "run_id": "11223344",                          // string; GitHub run id
    "run_attempt": 1,                              // integer ≥ 1
    "run_url": "https://github.com/…/actions/runs/11223344" | null,
    "actor": "priya-raman" | null                  // GitHub login that triggered CI
  },
  "tool": { "name": "pdf-testkit", "version": "0.2.0", "protocol_version": 1, "snapshot_schema_version": 1 }
}
```

`repository` is cross-checked against the token's repository; mismatch is
`403 repository_mismatch`. On GitHub `pull_request` events `GITHUB_SHA` is the
**merge** commit; the CLI must send `pull_request.head.sha` from the event
payload as `head_commit`.

Response `200`:

```jsonc
{
  "batch_id": "bat_…",
  "resumed": false,                               // true when the key already existed
  "repository": { "default_branch": "main", "is_default_branch": false },
  "org": { "privacy_mode": "A" | "B" }
}
```

**Idempotency.** Key `(repository, head_commit, ci.run_id, ci.run_attempt)`.
Calling again with the same key returns the same batch with `resumed: true` and
the batch stays writable — a retried step inside the same job attempt upserts in
place. A new `run_attempt` or a new `run_id` for the same commit is a **new
batch**, and the runs it creates supersede the earlier batch's runs for that
commit (§4).

`org.privacy_mode = "B"` tells the CLI **not to render pages** and to send
`images: null` on every run. Sending images anyway is `400 privacy_mode_forbids_images`.

## 3. Baseline lookup — `GET /ingest/v1/batches/{batch_id}/baseline?document_path=…`

Returns the current baseline the service wants this run compared against. In
protocol v1 that is always the repository **default branch's** current baseline
for this document (storage spec §2): PR branches never hold baselines.

Response `200`:

```jsonc
{
  "document": { "document_id": "doc_…", "path": "fixtures/invoice.pdf", "presence": "tracked" | "missing" | "untracked" } | null,
  "baseline": {
    "run_id": "run_…",
    "commit": "4b1e9c2…",
    "structure_hash": "sha256:…",
    "snapshot_schema_version": 1,
    "structure_url": "https://…presigned GET, ≤ 15 min…",
    "structure_encoding": "gzip",
    "renderer_id": "pdfjs-4.10.38" | null,
    "image_dpi": 150 | null
  } | null
}
```

- `document: null` — the path has never been seen; it will be tracked
  automatically when its first run is created (lifecycle spec §3a).
- `baseline: null` — no baseline exists (first run, or the document was untracked
  and purged). The CLI creates a run with `kind: "established"` and no diff.
- `snapshot_schema_version` differing from the CLI's is `409
  snapshot_schema_unsupported` on run creation; the CLI reports it as a
  configuration error (exit 2), never as a pass.

## 4. Runs — `POST /ingest/v1/batches/{batch_id}/runs`

One request per document per batch. The CLI has already extracted structure,
optionally rendered pages, fetched the baseline, and diffed locally.

Request:

```jsonc
{
  "document_path": "fixtures/invoice.pdf",
  "kind": "compared" | "established",
  "baseline_run_id": "run_…" | null,                 // exactly what §3 returned; null iff established
  "structure": {
    "hash": "sha256:…",                              // StructuralSnapshot.contentHash
    "byte_size": 48213,                              // of the gzipped blob to be PUT
    "encoding": "gzip",
    "snapshot_schema_version": 1,
    "producer": "formepdf" | "pdfjs",
    "page_count": 4,
    "node_count": 1284
  },
  "diff": {                                          // null iff kind = established
    "events": [ { "index": 0, "type": "page-count-changed", "severity": "error",
                  "message": "…", "confidence": 1, …every other field as the OSS reported it… } ],
    "groups": [ { "index": 0, "kind": "new-page-furniture", "severity": "error",
                  "summary": "…", "root_index": 0, "member_indices": [0, 7, 8] } ],
    "gate": { "fail_on": "error" | "warn" | "any" },
    "timings": { "extract_ms": 312, "diff_ms": 41, "render_ms": 890 | null, "nodes_compared": 1284 },
    "baseline_hash": "sha256:…"                      // must equal the baseline's structure_hash
  } | null,
  "images": {                                        // null in privacy mode B or with --no-images
    "renderer_id": "pdfjs-4.10.38",
    "dpi": 150,
    "format": "image/webp",
    "pages": [ { "index": 0, "width_px": 1275, "height_px": 1650, "byte_size": 118442, "sha256": "…hex…" } ]
  } | null
}
```

Rules the service enforces:

- **Events are stored as reported.** The schema validates only the common
  envelope (`index`, `type`, `severity`, `message`, `confidence`) and passes every
  other field through untouched. New OSS event types never break ingest. Events
  are stamped with `tool.version` from the batch.
- **Groups are a view, uploaded as reported** (Phase 0 flag 4, option a). Members
  are event indices; the union of all groups must equal the event index set
  exactly, or the request is `400 payload_invalid`.
- `events[i].index === i`. Event `nodeId` refers to the **new** snapshot except
  for `element-removed`, whose id is in the baseline; paired events additionally
  carry `baseNodeId` so the review screen can outline both pages.
- `diff.gate.fail_on` is the customer's CLI configuration and is how the service
  computes `outcome`: **blocked** iff any event's severity is at or above the
  gate (`error` → errors only; `warn` → errors and warnings; `any` → anything).
  `review_state` is `awaiting_review` whenever *any* event exists, regardless of
  the gate (a warnings-only run is passed + awaiting_review: the check is green,
  the review is still owed). No events → `not_required`.
- `baseline_run_id` must be the document's **current** baseline at the moment the
  run is created. If the baseline moved between §3 and §4, the response is
  `409 baseline_moved` with the new baseline in `details`; the CLI re-diffs and
  retries once, then reports a configuration error.
- **Established runs**: `kind: "established"`, `baseline_run_id: null`,
  `diff: null`. The service records `outcome: passed`, `review_state:
  not_required`, `baseline_commit: null`, and writes promotion entry zero
  (lifecycle spec §2). An `established` run for a document that *has* a
  baseline is `409 baseline_exists`.

Response `201` (created or replaced) / `200` (unchanged):

```jsonc
{
  "run_id": "run_…",
  "disposition": "created" | "replaced" | "unchanged",
  "kind": "compared",
  "outcome": "blocked" | "passed",
  "review_state": "awaiting_review" | "not_required",
  "uploads": {
    "structure": { "method": "PUT", "url": "https://…presigned…", "headers": { "Content-Type": "application/json", "Content-Encoding": "gzip" } },
    "images": [ { "index": 0, "method": "PUT", "url": "https://…", "headers": { "Content-Type": "image/webp" } } ]
  } | null
}
```

**Idempotency and supersession** (storage spec §5, refined):

| Situation | Disposition | Effect |
| --- | --- | --- |
| Same batch (same `run_id` + `run_attempt`), same path, first time | `created` | new run |
| Same batch, same path, again (retried step) | `replaced` | upsert in place; review marks kept only if `structure.hash` unchanged |
| New batch for the same commit (re-run job, or re-push), `structure.hash` **identical** to the existing run for that commit | `unchanged` | existing run and its review state preserved; `uploads: null`; nothing to PUT |
| New batch for the same commit, hash **differs** | `created` | new run; the previous run for that commit is marked `superseded` |

The refinement over storage spec §5's key `(repo, document_path, head_commit,
run_attempt)`: `ci.run_id` is part of the key, because a re-push of the same
commit starts a new GitHub run whose `run_attempt` is 1 again and would
otherwise collide with the original.

**Lifecycle spec §1, row one** falls out of this table: two runs, same commit,
different hash is definitive nondeterminism. The service records a determinism
assertion when it takes the `created` branch for an already-seen commit.

## 5. Artifact upload — `PUT <uploads.*.url>`

The CLI PUTs each artifact to the URL given, with exactly the headers given, and
no others that affect the signature. Bodies:

- **Structure**: `serializeSnapshot(snapshot, /*pretty*/ false)` gzipped.
  `structure.hash` is the snapshot's own `contentHash`; `structure.byte_size` is
  the gzipped length.
- **Page image `i`**: WebP bytes of page index `i` (0-based, matching
  `snapshot.pages[i].index`) rendered at `images.dpi`.

Presigned URLs expire after 15 minutes. A URL is valid for one object; the
service enforces `Content-Length` = declared `byte_size`.

**Coordinate contract.** Snapshot geometry is in PDF points with a top-left
origin (`StructuralNode.bbox`). Page image `i` has
`width_px = round(pages[i].width × dpi / 72)` and likewise for height. A raster
rectangle for a node is `bbox × dpi / 72`. The service draws highlight overlays
from this and never needs the PDF. `renderer_id` is recorded per run; when a
run's renderer differs from its baseline's, the service hides the Overlay view
(storage spec §9.7).

## 6. Run completion — `POST /ingest/v1/runs/{run_id}/complete`

```jsonc
{ "structure_uploaded": true, "image_indices_uploaded": [0, 1, 2, 3] }
```

The service verifies each declared object exists with the declared size (HEAD
against storage). Response `200 { "run_id", "status": "ready" }`, or `409
upload_incomplete` with the missing keys in `details`. Until `ready`, a run is
invisible to the review UI and to check-run computation. `unchanged` runs need
no completion call.

## 7. Batch completion — `POST /ingest/v1/batches/{batch_id}/complete`

```jsonc
{
  "document_paths": ["fixtures/invoice.pdf", "fixtures/report.pdf"],   // every path this job reported
  "failed": [ { "document_path": "fixtures/broken.pdf", "reason": "extract_failed" } ]
}
```

Response `200 { "batch_id", "status": "complete", "runs_ready": 2 }`.

Only a **complete** default-branch batch counts toward absence
(`document_paths` omitted a tracked document ⇒ one strike; three consecutive ⇒
`missing`). A job that crashes before completion leaves the batch `open`
forever; open batches are never evaluated for absence, so a broken CI run cannot
make every document vanish at once (lifecycle spec §3b). Paths listed in
`failed` are treated as *present but unprocessed* — the document arrived, the
CLI could not handle it — and do not count as absent. Completion is idempotent;
re-sending replaces the lists.

## 8. Errors

| HTTP | `code` | Meaning | CLI behaviour |
| --- | --- | --- | --- |
| 401 | `unauthorized` | missing/invalid/revoked token | exit 2 (configuration error) |
| 403 | `repository_mismatch` | token's repo ≠ `repository` | exit 2 |
| 400 | `payload_invalid` | schema violation; `details.issues[]` | exit 2 |
| 400 | `protocol_unsupported` | `details.supported: [1]` | exit 2 (upgrade CLI) |
| 409 | `snapshot_schema_unsupported` | baseline schema ≠ CLI schema | exit 2 |
| 400 | `privacy_mode_forbids_images` | images sent in mode B | exit 2 |
| 404 | `batch_not_found` / `run_not_found` | | exit 2 |
| 409 | `baseline_moved` | re-fetch and re-diff once | retry once, then exit 2 |
| 409 | `baseline_exists` | `established` sent but a baseline exists | retry as `compared` once |
| 409 | `upload_incomplete` | object missing/size mismatch | re-PUT once, then exit 2 |
| 429 | `rate_limited` | honour `Retry-After` | retry, then treat as unavailable |
| 5xx | `internal` | | treat as unavailable |

**Unavailable** = connection failure, timeout, 5xx, or 429 exhausted, after 3
attempts with backoff 1 s / 2 s / 4 s. Default behaviour: print a warning,
**exit 0**. With `--require-service`: exit 3. This is storage spec §5's "warn and
pass"; it makes the service's own outages invisible to the build, which is the
documented hole and why the check should be a required status in branch
protection.

4xx responses are **not** "unavailable". They are the customer's configuration
(revoked token, wrong repo, stale CLI) and are actionable locally, so they always
exit 2. A revoked token silently passing forever would be worse than a red build.

## 9. CLI exit codes (`pdf-testkit upload`)

| Code | Meaning |
| --- | --- |
| 0 | Reported to the service; or the service was unavailable and `--require-service` was not set |
| 1 | Local severity gate hit (`--fail-on` given). Off by default: the service's check is the gate |
| 2 | Configuration or client error (any 4xx, unreadable inputs, missing token) |
| 3 | Service unavailable and `--require-service` set |

`upload` exits 0 on a blocked outcome by default. The GitHub check posted by the
service is the gate, and a failed job step would double-report it. Customers who
want the job itself to fail pass `--fail-on`.

## 10. What is deliberately not in v1

- Per-PR baselines, cross-document baselines, any baseline other than the default
  branch's current one.
- Server-side diffing, hashing, or re-grouping. The service trusts
  `structure.hash` from a token that can only write to its own repository.
- Third-party producers. The schema is public because the CLI is; support is not.
- Conformance results (PDF/UA, PDF/A). A slot is reserved: a future
  `conformance: { tool, tool_version, profile, verdict }` on the run request,
  attributed to the producing tool and never folded into pdf-testkit's reporting
  (lifecycle spec §4).
- Any way for the CLI to approve, reject, untrack, rename, or dismiss anything.
  The CI token writes runs and nothing else.
