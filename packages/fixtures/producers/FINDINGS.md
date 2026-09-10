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

## F2 — Headings missed on a headings-and-tables-only document (all producers)
The statement (H1 + two H2s, no body prose) extracted **0 headings** on every
producer. The heading model takes the char-count-weighted modal size as the body
baseline and calls larger text a heading; with no paragraphs, the only non-table
text *is* the headings, so there is no smaller baseline to exceed. A real,
cross-producer extractor limitation — not producer-specific. Minimal repro:
`*-statement-baseline.pdf`.

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

## What held up everywhere (the non-findings worth stating)
- Contract heading hierarchy (H1–H3): 6/6 on all four producers.
- Compact: 1 heading, 1 table, and the block move caught as `element-moved`, all four.
- Determinism: every fixture's structural hash repeats across regeneration.
