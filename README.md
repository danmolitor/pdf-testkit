# pdf-testkit

**Semantic regression testing for generated PDFs.**

`pdf-testkit` understands your document — pages, headings, tables, layout — instead of its
pixels. It catches the regressions that matter (a table that slipped to the next page, a
heading that dropped a level, text that overflowed its box) without the false alarms of a
pixel-diff tool.

```ts
import '@pdf-testkit/vitest'; // or '@pdf-testkit/jest'

test('invoice layout is stable', async () => {
  const pdf = await renderInvoice(); // Uint8Array from any producer
  await expect(pdf).toMatchPDFSnapshot();
});
```

A failing assertion reports **semantic events**, never a pixel percentage:

```
PDF snapshot changed (2 semantic events):
  ✗ heading-hierarchy-changed  heading "Quarterly Results" hierarchy changed H2 → H3
  ⚠ table-moved  table moved from page 1 to page 2

  → Run with -u (or PDF_TESTKIT_UPDATE=1) to accept these changes.
```

> Status: **v0.1**. Free and open-source (MIT). Framework-agnostic — works with FormePDF,
> react-pdf, Puppeteer, Playwright, PDFKit, and Python generators alike.

> [!IMPORTANT]
> **pdf-testkit checks structure and layout, not content correctness.** It tells you a table
> moved, a heading dropped a level, or text overflowed — not that a value is *wrong*. An invoice
> total silently changing from `$10,000` to `$10,000,000` in the same position is a clean pass,
> by design. This is the same boundary Percy/Chromatic draw for visual UI. Assert content values
> with ordinary assertions; use pdf-testkit for the layout regressions those can't see.

---

## Why

Every tool that generates PDFs shares the same blind spot: there's no good way to test that a
generated document didn't silently break. Pixel-diff tools flag harmless rendering noise as
failures and miss real structural regressions; the alternative is opening the PDF and eyeballing
it before every release. `pdf-testkit` diffs **document structure**, so it sees a shifted table
or a lost heading and ignores font-smoothing noise.

## Install

```bash
npm i -D @pdf-testkit/vitest        # Vitest matcher
npm i -D @pdf-testkit/jest          # Jest matcher
npm i -g @pdf-testkit/cli           # CLI (or use npx)
# pdfjs-dist is an optional peer dep — needed only to diff non-FormePDF PDFs:
npm i -D pdfjs-dist
```

## Usage

### As a test matcher

```ts
import '@pdf-testkit/vitest';

it('renders a stable report', async () => {
  // Any of: a PDF (Uint8Array/ArrayBuffer), a FormePDF LayoutInfo,
  // a StructuralSnapshot, or { path: 'out.pdf' }.
  await expect(pdfBytes).toMatchPDFSnapshot();
});
```

Baselines are written next to the test in `__pdf_snapshots__/`. The first run captures the
baseline; later runs diff against it. Accept intentional changes with `-u` (Vitest/Jest update
mode) or `PDF_TESTKIT_UPDATE=1`. On CI, a missing baseline **fails** rather than being created
silently.

Options: `toMatchPDFSnapshot({ minConfidence, positionThresholdPts, ignoreRoles, severityOverrides, snapshotDir, snapshotName })`.

### FormePDF fast path

FormePDF exposes structure directly, so you can skip PDF parsing entirely:

```ts
import { renderPdfWithLayout } from '@formepdf/core';

const { layout } = await renderPdfWithLayout(docJson);
await expect(layout).toMatchPDFSnapshot(); // authoritative, no heuristics
```

### CLI

```bash
pdf-testkit snapshot invoice.pdf --out invoice.json   # extract a structural snapshot
pdf-testkit diff a.pdf b.pdf                           # human-readable event list
pdf-testkit diff base.json new.pdf --json             # machine-readable DiffResult
pdf-testkit diff a.pdf b.pdf --verbose                 # every event, ungrouped
pdf-testkit diff a.pdf b.pdf --fail-on warn --min-confidence 0.7
```

Exit code is the contract: **0** = clean (or below the `--fail-on` gate), **1** = regression.
Inputs may be `.pdf` or a `.json` snapshot/LayoutInfo, interchangeably.

### GitHub Action (comment-only)

```yaml
- run: pdf-testkit snapshot dist/invoice.pdf --out current.json
- uses: your-org/pdf-testkit/packages/action@v0.1
  with:
    baseline: baselines/invoice.json   # committed to your repo
    current: current.json
    fail-on: error
```

It posts (and updates) a single PR comment with the semantic diff and fails the check per
`fail-on`. There's no hosted storage — baselines are just files you commit. Committed `.json`
snapshots are recommended so the runner needs no PDF-parsing step.

## How it works

Each producer is normalized into one flat **StructuralSnapshot** (pages; nodes with role,
position, font, heading level, table shape, overflow; a content hash). The diff engine pairs
nodes across two snapshots — exact key → fuzzy text → in-place position → structural — and emits
typed events instead of a similarity score:

`page-count-changed` · `element-moved-to-different-page` · `table-moved` ·
`heading-hierarchy-changed` · `text-overflowed-container` · `element-added` · `element-removed`

Because matching resolves *moved* vs *removed+added*, reordering untouched content, whitespace/
case edits, and sub-threshold jitter produce **no** events — that's the whole point. The same
mechanism means an in-place text edit (same role, same box) is treated as the *same* node, so a
pure content change with unchanged structure passes clean — see the scope note at the top.

### Grouping

One structural change fans out into many events. Growing an invoice's line-item table from 5 to
19 rows emits **123** of them: the table's own subtree, the elements it pushed onto the next
page, the new page's repeated footer, and — buried at rows 16 and 121–123 — the three totals
that actually changed value. Every event is accurate and the list is still useless, because a
reviewer scrolling past 123 rows approves without reading.

Human-facing output therefore groups events by cause:

```
✗ 123 semantic changes in 6 groups (baseline.json → current.json):
  ✗ page-count-changed  page count changed 2 → 3 (+4 repeated header/footer elements on the new page)  [5 events]
  ⚠ table-moved  table grew +15 rows, +81 cells (6×4 → 21×5), now spans pages 1–2  [98 events]
  ⚠ element-moved-to-different-page  14 elements shifted +1 page (1→2, 2→3) following the table's growth  [14 events]
  ⚠ element-added  text "$14350.00" → "$41158.00"  [2 events]
  ⚠ element-added  text "$1148.00" → "$3292.64"  [2 events]
  ⚠ element-added  text "$15498.00" → "$44450.64"  [2 events]

  → 117 related events collapsed; re-run with --verbose for the full list.
```

Three rules keep this trustworthy:

- **It is a view, never a filter.** The union of every group is exactly the input event list.
  `--verbose` (CLI), `PDF_TESTKIT_VERBOSE=1` (matchers), and a `<details>` block (Action comment)
  all expand back to the full per-element list. `DiffResult`, `--json`, and the `fail-on` gate
  never see grouping at all — machine consumers keep full resolution.
- **A real content change is paired, not collapsed.** A removed and re-added value at the same
  slot renders as `"$100.00" → "$1,250.00"` on its own row. Folding it into a downstream-cascade
  summary would hide the one fact on this diff that matters.
- **A group never absorbs an event more severe than its root.** An error riding along inside a
  warn-level group is ejected to its own row, so severity means the same thing in the summary as
  it does in the gate.

## Reliability by producer

Structure is authoritative when the producer declares it (FormePDF `LayoutInfo`) and inferred
heuristically otherwise (raw PDF via pdfjs). Heuristic nodes carry a `confidence` < 1 you can
filter with `minConfidence`. The pdfjs column below is **empirically verified** against real
**react-pdf, PDFKit, and Puppeteer/Chrome** output — a representative invoice (headings +
paragraph + a multi-column table crossing a page break) generated by each library's documented
pattern — not estimated. See `general-path.regression.test.ts`.

| Capability | FormePDF `LayoutInfo` | Raw PDF (pdfjs) · react-pdf / PDFKit / Puppeteer |
| --- | :-: | :-: |
| Page count / page-assignment | ✅ authoritative | ✅ reliable |
| Element added / removed / moved | ✅ authoritative | ✅ reliable |
| Heading hierarchy | ✅ authoritative | ✅ verified 3/3, no misfire (conf 0.8) |
| Table detection / position | ✅ authoritative | ✅ detected on all three (conf 0.5) |
| Text overflow | ✅ authoritative | ⚠️ best-effort (inferred margin box) |

**False-alarm resistance is verified on the heuristic path too**: reordering unrelated
paragraphs produced **zero** events on all three producers — "semantic, not noisy" holds even
where structure is inferred, not declared.

Known limits on the pdfjs path: table row/column *counts* are approximate (the region is
detected; the exact shape is heuristic); a table whose columns are conveyed only by drawn rules
with no text-position separation is not detected; overflow is approximate because a raw PDF has
no container concept. Confidence is 1.0 on the FormePDF path and &lt;1 here — filter with
`minConfidence` if you want only authoritative signal.

## vs. pixel-diff tools

| | pdf-testkit | pixel-diff (pdf-visual-diff, jest-pdf-snapshot) |
| --- | --- | --- |
| Compares | Document **structure** | Rendered **pixels** |
| Reports | Named semantic events | A % / pixel count |
| Font-smoothing noise | Ignored | Frequent false positives |
| "Table moved to page 2" | Detected explicitly | Buried in a pixel delta |

## Scope (v0.1)

**In:** page/page-assignment, table-position, heading-hierarchy, and overflow diffing; Jest +
Vitest matchers; CLI; comment-only GitHub Action.
**Out (later):** pixel diffing; hosted baselines / PR review UI; PDF/A·UA conformance diffing;
font-embedding diffing; non-PDF formats.

## Packages

| Package | Purpose |
| --- | --- |
| `@pdf-testkit/core` | Structural model, extractors, diff engine |
| `@pdf-testkit/matcher-core` | Framework-agnostic `toMatchPDFSnapshot` logic |
| `@pdf-testkit/vitest` · `@pdf-testkit/jest` | Thin test-runner adapters |
| `@pdf-testkit/cli` | `pdf-testkit` command |
| `@pdf-testkit/action` | Comment-only GitHub Action |

## Development

```bash
npm ci
npm run build   # tsc project references
npm test        # vitest across all packages
npm -w @pdf-testkit/action run bundle   # rebuild the action's dist/index.js
```

MIT.
