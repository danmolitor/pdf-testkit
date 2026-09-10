# Producer corpus — first reading (findings, not fixes)

Measured by running every committed fixture through the pdfjs path and diffing
each `baseline` → `changed` pair. These are recorded as findings per the task —
none are fixed here, because tuning the extractor while building the instrument
would compromise the first measurement. Each is a candidate for a follow-up with
a minimal repro (the fixture *is* the repro).

Baseline extraction, expected vs measured (headings / tables):

| doc | expected | react-pdf | PDFKit | Puppeteer | Forme (via pdfjs) |
|---|---|---|---|---|---|
| invoice | 3 h, 1 table | 3 h, **2 tbl** | 3 h, 1 tbl (**3 rows**) | 3 h, **2 tbl** | **4 h**, 1 tbl (**3 rows**) |
| contract | 6 h, 0 tables | 6 h, 0 ✓ | 6 h, 0 ✓ | 6 h, 0 ✓ | 6 h, 0 ✓ |
| statement | 3 h, 2 tables | **0 h**, 2 tbl | **0 h**, 2 tbl | **0 h**, 2 tbl | **0 h**, 2 tbl |
| compact | 1 h, 1 table | 1 h, 1 ✓ | 1 h, 1 ✓ | 1 h, 1 ✓ | 1 h, 1 ✓ |

Change caught (`baseline` → `changed`), the event a human would name:

| doc | change | caught? |
|---|---|---|
| invoice | add rows, cross a page | ✅ `page-count-changed` (in a large cascade) |
| contract | demote a heading H2→H3 | ✅ `heading-hierarchy-changed` (all producers) |
| statement | alter a total value | ❌ **zero events — by design** |
| compact | move a block | ✅ `element-moved` |

## F1 — A changed total fires nothing (scope boundary, all producers)
Altering `$1,250.00` → `$1,450.00` in the statement's Payments total produced
**0 events on every producer.** This is the documented "structure, not content"
boundary made concrete: the cell keeps its slot, so it matches and nothing
fires. Correct by design — but it's the finding most likely to surprise someone
testing invoices/statements, so it belongs in the READMEs and outreach as an
explicit boundary: *pdf-testkit will not catch a wrong number.*

## F2 — Headings missed on a headings-and-tables-only document — **RESOLVED**
The statement (H1 + two H2s, no body prose) extracted **0 headings** on every
producer. The heading model took the char-count-weighted modal size as the body
baseline and called larger text a heading; with no paragraphs the only non-table
text *is* the headings, and the long title won the char weighting, so the modal
"body" was the *largest* size and nothing exceeded it. A whole document class
(statements, dashboards, data-heavy reports) was invisible to heading detection.

Fixed structurally (not by heuristic tuning): when several distinct non-table
sizes exist and the modal body size is the maximum — i.e. there is no smaller
prose to anchor a baseline — the distinct sizes are ranked directly, largest =
H1. Guarded so a prose-only document (one size) is never turned into a page of
H1s. The corpus caught the fix doing its job: `statement` flipped 0 → 3 headings
`[H1 H2 H2]` on react-pdf/PDFKit/Puppeteer in one reviewed diff. Forme lands at 4
because its title splits into two H1 runs (see below).

## F3 — Section/colspan rows fragment one table into many (react-pdf, Puppeteer)
The invoice's full-width "Group N" section rows break the column pattern, so the
detector splits one logical table into 2 (baseline) and up to 6 (the longer
`changed` invoice) table nodes. PDFKit/Forme-via-pdfjs don't fragment only
because they under-detect the table wholesale (F4). Repro: `react-pdf-invoice-*`.

## F4 — PDFKit and Forme-via-pdfjs severely under-detect the invoice table
Both extracted a 3-row / 6-cell table from an ~11-row invoice; the rest fell
through to loose text. Imperatively positioned text without the whitespace-column
structure the detector keys on. This is the expected worst case and the reason
Forme ships a layout sidecar — the authoritative `LayoutInfo` (committed as
`forme-*-*.pdf.layout.json`) is the calibration contrast. **Documented boundary
for PDFKit**, not a surprise.

## F5 — Puppeteer over-fires a heading on the multi-page invoice
`puppeteer-invoice-changed` extracted 4 headings (should be 3) and its diff
carries `heading-hierarchy-changed: 2` — phantom heading events riding along a
pagination change. Likely a totals-row or wrapped-cell run at a size that trips a
band on the longer document. Repro: `puppeteer-invoice-baseline → changed`.

## F6 — Forme's contract rendering shifts page count on the demotion
`forme-contract-baseline` is 2 pages, `changed` is 1 — demoting one H2 to H3
reclaimed enough vertical space to drop a page, so the diff adds
`page-count-changed` + `element-moved-to-different-page` on top of the real
`heading-hierarchy-changed`. A rendering-fidelity artifact of the producer, not
an extractor bug, but it means the "clean single event" story only holds on the
non-Forme producers for this document.

## F7 — Forme's title splits into two H1 runs on the pdfjs path (sidecar immune)
`forme-invoice` and `forme-statement` both extract 4 headings via pdfjs, not 3:
the title (`ACME Corporation — Invoice #1042`, `Account Statement — August 2026`)
comes back as two same-size runs that don't merge, so it reads as two H1s. This
is a pdfjs run-splitting artifact on Forme's output, **not** an extractor-logic
bug — and the authoritative `fromFormeLayout` sidecar path is immune: it reports
3 headings with the title as one node. A clean demonstration of why Forme ships
the sidecar. (This also corrects earlier notes that attributed Forme's invoice=4
to F5 — it's F7, the title split, the same cause as Forme's statement=4.) A
candidate fix is merging adjacent same-size runs across the split, but that's
extractor tuning, deferred.

## Status
- **F2 — RESOLVED** (heading baseline fallback; statement now 3–4 headings).
- **F1 — on the board as the next feature** (content/value diffing; a scope
  decision, not extractor tuning — see the "structure, not content" boundary).
- F3–F6 remain recorded findings; the fixtures are their repros.

## What held up everywhere (the non-findings worth stating)
- Contract heading hierarchy (H1–H3): 6/6 on all four producers.
- Compact: 1 heading, 1 table, and the block move caught as `element-moved`, all four.
- Determinism: every fixture's structural hash repeats across regeneration.
