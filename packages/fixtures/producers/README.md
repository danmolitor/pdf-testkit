# Producer corpus

The same logical documents (`_spec.ts`) rendered by every major JavaScript PDF
producer, committed as fixtures, run through pdf-testkit's extraction and diff on
every commit. This is the evidence behind "works with any producer" — and the
instrument that catches the day a producer's output, or a pdfjs bump, changes
what extraction sees.

*(One README with a section per producer rather than a directory per producer —
the producer scripts are single files, so a directory each would be churn without
benefit. Each section is the same "here's the script, here's what pdf-testkit
finds, here's the boundary" the task asked for.)*

## How it runs
- **Every commit** — `packages/core/test/corpus.regression.test.ts` extracts and
  diffs the **committed** fixtures. No rendering, so it's fast and hermetic. It
  pins each producer×document's extraction; a fidelity regression fails it.
- **Weekly + `run-corpus` label** — `.github/workflows/corpus.yml` renders every
  producer at its *latest* version and fails if `corpus-manifest.json` (structure
  hashes + producer versions) drifts from what's committed. That turns a silent
  upstream change into a reviewable diff.

Regenerate locally: `node packages/fixtures/producers/generate.ts` (needs the
fixtures dev deps + a local/CI Chrome for Puppeteer).

## The documents (`_spec.ts`)
`invoice` (line-item table crossing a page, section rows, totals) · `contract`
(H1–H3 hierarchy + prose) · `statement` (two tables, one page) · `compact`
(single-pager). Each has a `baseline` and a `changed` variant; the change is the
realistic edit that exercises one event type.

## Per-producer fidelity (measured — see [FINDINGS.md](./FINDINGS.md))

### Puppeteer (`puppeteer.ts`) — Chrome `page.pdf` from HTML — the market
Headings reliable on most documents; tables detected. **Boundaries:** the long
`changed` invoice over-fires one heading (F5); section rows split a table into
several nodes (F3). This is the closest match to what `pdf-visual-diff` users
render — and pdf-testkit reads it without the pixel flake.

### react-pdf (`react-pdf.ts`) — `@react-pdf/renderer`
Headings reliable (3/3, 6/6, 1/1 on invoice/contract/compact). Tables detected;
section rows fragment one table into two (F3).

### PDFKit (`pdfkit.ts`) — imperative API, ruled tables
Headings reliable. **Boundary, documented not surprising:** tables are
under-detected — imperatively positioned text has none of the structure the
detector keys on, so an ~11-row invoice extracts as ~3 rows (F4). PDFKit is the
honest worst case for the pdfjs path; if table fidelity matters, use a producer
that emits structure. Byte-pinned (`CreationDate`) so its fixtures are stable.

### Forme (`forme.ts`) — the calibration point
The only producer that emits authoritative structure (`LayoutInfo`, committed as
`forme-*-*.pdf.layout.json`) **and** a PDF for the pdfjs path. Forme-via-pdfjs
shows the same table under-detection (F4) and invoice heading over-fire (F5) as
the others — which is exactly why Forme ships the layout sidecar: the fast path
sidesteps the heuristics. It anchors every other producer's fidelity number.

## Cross-producer findings
- **A changed total fires nothing by default** (F1) — content edits at a stable
  slot are not events unless you ask for them. Opt in with `contentChanges` (diff/
  matcher) or `--content` (CLI) to emit `element-content-changed` at `warn`; it
  stays narrow by matcher inheritance (the statement's two totals fire, the
  invoice's 129–142 added rows stay `element-added`). Measured across all four
  producers before it was built.
- **Headings on a headings-and-tables-only document** (F2) — **fixed**: the
  `statement` (no body prose) now detects its headings via a distinct-size-rank
  fallback instead of extracting zero.

Full detail, with the minimal repro per finding, in [FINDINGS.md](./FINDINGS.md).
