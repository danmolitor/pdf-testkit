import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { fromPdf, diffSnapshots, groupEvents, type DiffResult } from '@pdf-testkit/core';

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
  forme: { invoice: { headings: 4 /*F7 title split*/, tables: 1 /*F4*/ }, contract: { headings: 6, tables: 0 }, statement: { headings: 4 /*title splits into two H1 runs*/, tables: 2 }, compact: { headings: 1, tables: 1 } },
};

// The event a human would name for each document's `changed` edit.
const CHANGE_INVARIANT: Record<DocId, (r: DiffResult) => void> = {
  invoice: (r) => expect(r.events.some((e) => e.type === 'page-count-changed')).toBe(true),
  contract: (r) => expect(r.events.some((e) => e.type === 'heading-hierarchy-changed')).toBe(true),
  // F1 — a changed total is a content edit at a stable slot: zero events with
  // the DEFAULT (structure-only) options. This is the "structure, not content"
  // boundary, pinned so a future change that starts firing on it is caught and
  // decided deliberately. The opt-in `contentChanges` diff below is what turns
  // this into `element-content-changed` events.
  statement: (r) => expect(r.events).toHaveLength(0),
  compact: (r) => expect(r.events.some((e) => e.type === 'element-moved')).toBe(true),
};

// F1 — the opt-in `element-content-changed` event. Counts are MEASURED over the
// committed fixtures (see the noise proof: statement's two totals fire on every
// producer; the growing invoice's recomputed subtotal/tax/total fire while its
// 129–142 added rows stay `element-added`, NOT reclassified — the event inherits
// the 0.4.0 matcher's added-vs-in-place separation, which is what keeps it
// narrow). contract (a heading demotion, same text) and compact (a block move)
// carry no content edit, so they fire zero — the boundary the event must respect.
const CONTENT_CHANGED: Record<Producer, Record<DocId, number>> = {
  'react-pdf': { invoice: 6, contract: 0, statement: 2, compact: 0 },
  pdfkit: { invoice: 3, contract: 0, statement: 2, compact: 0 },
  puppeteer: { invoice: 6, contract: 0, statement: 2, compact: 0 },
  forme: { invoice: 3, contract: 0, statement: 2, compact: 0 },
};

const contentChangedCount = (r: DiffResult): number =>
  r.events.filter((e) => e.type === 'element-content-changed').length;
const addedCount = (r: DiffResult): number => r.events.filter((e) => e.type === 'element-added').length;

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

  it.each(DOCS)('%s: content edits surface only under the `contentChanges` opt-in', async (doc) => {
    const base = await fromPdf(fx(`${producer}-${doc}-baseline`));
    const changed = await fromPdf(fx(`${producer}-${doc}-changed`));

    // Opt-in, default-off: the structure-only diff never names a content edit.
    expect(contentChangedCount(diffSnapshots(base, changed))).toBe(0);

    // Enabled: exactly the measured content edits, at `warn` (never `error`).
    const withContent = diffSnapshots(base, changed, { contentChanges: true });
    expect(contentChangedCount(withContent)).toBe(CONTENT_CHANGED[producer][doc]);
    for (const e of withContent.events.filter((e) => e.type === 'element-content-changed')) {
      expect(e.severity).toBe('warn');
    }

    // Inheritance / narrowness: enabling the opt-in reclassifies nothing — the
    // invoice's added rows stay `element-added`, they don't become content edits.
    expect(addedCount(withContent)).toBe(addedCount(diffSnapshots(base, changed)));

    // Never folded by grouping (decision #3). On the invoice the content edits
    // sit inside a large page-shift cascade; grouping must still surface each one
    // as its own single-member group so the one fact that matters — a number
    // changed — is never buried in a "23 elements shifted" summary line.
    const groups = groupEvents(base, changed, withContent.events, { contentChanges: true });
    for (const e of withContent.events.filter((e) => e.type === 'element-content-changed')) {
      const holding = groups.filter((g) => g.events.includes(e));
      expect(holding).toHaveLength(1);
      expect(holding[0]!.events).toHaveLength(1);
      expect(holding[0]!.root).toBe(e);
    }
  });

  it.each(DOCS)('%s: extraction is deterministic', async (doc) => {
    const a = await fromPdf(fx(`${producer}-${doc}-baseline`));
    const b = await fromPdf(fx(`${producer}-${doc}-baseline`));
    expect(a.contentHash).toBe(b.contentHash);
  });
});
