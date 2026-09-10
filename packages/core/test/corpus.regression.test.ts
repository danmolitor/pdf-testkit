import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { fromPdf, diffSnapshots, type DiffResult } from '@pdf-testkit/core';

/**
 * The producer corpus, per-commit: every logical document (packages/fixtures/
 * producers/_spec.ts) rendered by every producer (react-pdf, PDFKit, Puppeteer,
 * Forme), run through the pdfjs path over COMMITTED fixtures — no rendering here,
 * so it's fast and hermetic. Rendering + regen-vs-committed is the scheduled job.
 *
 * The extraction numbers below are PINNED to the current reading. Committed
 * fixtures are byte-fixed, so a pin only moves when pdf-testkit's extractor
 * changes — which is the whole point: an accidental fidelity regression on any
 * producer fails here, and a deliberate improvement is a visible, reviewed diff.
 * Values that are known-wrong today are marked FINDING (see producers/FINDINGS.md);
 * pinning them means the fix, when it comes, shows up as a green→green change to
 * the expected number rather than a silent one.
 */
const PRODUCERS = ['react-pdf', 'pdfkit', 'puppeteer', 'forme'] as const;
const DOCS = ['invoice', 'contract', 'statement', 'compact'] as const;
type Producer = (typeof PRODUCERS)[number];
type DocId = (typeof DOCS)[number];

const fx = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/pdfs/${name}.pdf`, import.meta.url))));

// Baseline extraction — { headings, tables }. Expected: invoice 3h/1t,
// contract 6h/0t, statement 3h/2t, compact 1h/1t.
const EXTRACTION: Record<Producer, Record<DocId, { headings: number; tables: number }>> = {
  // statement flipped 0 → 3 headings when F2 (no-prose baseline) was fixed.
  'react-pdf': { invoice: { headings: 3, tables: 2 /*F3 fragmented*/ }, contract: { headings: 6, tables: 0 }, statement: { headings: 3, tables: 2 }, compact: { headings: 1, tables: 1 } },
  pdfkit: { invoice: { headings: 3, tables: 1 /*F4 under-detected*/ }, contract: { headings: 6, tables: 0 }, statement: { headings: 3, tables: 2 }, compact: { headings: 1, tables: 1 } },
  puppeteer: { invoice: { headings: 3, tables: 2 /*F3*/ }, contract: { headings: 6, tables: 0 }, statement: { headings: 3, tables: 2 }, compact: { headings: 1, tables: 1 } },
  forme: { invoice: { headings: 4 /*F5*/, tables: 1 /*F4*/ }, contract: { headings: 6, tables: 0 }, statement: { headings: 4 /*title splits into two H1 runs*/, tables: 2 }, compact: { headings: 1, tables: 1 } },
};

// The event a human would name for each document's `changed` edit.
const CHANGE_INVARIANT: Record<DocId, (r: DiffResult) => void> = {
  invoice: (r) => expect(r.events.some((e) => e.type === 'page-count-changed')).toBe(true),
  contract: (r) => expect(r.events.some((e) => e.type === 'heading-hierarchy-changed')).toBe(true),
  // F1 — a changed total is a content edit at a stable slot: zero events, by
  // design. This is the "structure, not content" boundary, pinned so a future
  // change that starts firing on it is caught and decided deliberately.
  statement: (r) => expect(r.events).toHaveLength(0),
  compact: (r) => expect(r.events.some((e) => e.type === 'element-moved')).toBe(true),
};

describe.each(PRODUCERS)('corpus — %s', (producer) => {
  it.each(DOCS)('%s: baseline extraction matches the pinned reading', async (doc) => {
    const snap = await fromPdf(fx(`${producer}-${doc}-baseline`));
    expect({
      headings: snap.nodes.filter((n) => n.role === 'heading').length,
      tables: snap.nodes.filter((n) => n.role === 'table').length,
    }).toEqual(EXTRACTION[producer][doc]);
  });

  it.each(DOCS)('%s: the change is caught (or, per scope, deliberately is not)', async (doc) => {
    const base = await fromPdf(fx(`${producer}-${doc}-baseline`));
    const changed = await fromPdf(fx(`${producer}-${doc}-changed`));
    CHANGE_INVARIANT[doc](diffSnapshots(base, changed));
  });

  it.each(DOCS)('%s: extraction is deterministic', async (doc) => {
    const a = await fromPdf(fx(`${producer}-${doc}-baseline`));
    const b = await fromPdf(fx(`${producer}-${doc}-baseline`));
    expect(a.contentHash).toBe(b.contentHash);
  });
});
