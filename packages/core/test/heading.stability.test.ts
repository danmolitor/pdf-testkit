import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { diffSnapshots, fromPdf } from '@pdf-testkit/core';
import { buildHeadingModel } from '../src/extract/pdfjs/headings.js';
import type { PdfTextRun } from '../src/extract/pdfjs/textRuns.js';
import { node, snapshot } from './helpers';

/**
 * Regression (extraction-fidelity experiment, 2026-09-09, finding P2): adding
 * 24 rows to a statement's open-items table produced "heading "NORTHMOOR"
 * hierarchy changed H4 → H3" at ERROR severity on the pdfjs path (one event
 * on Forme's PDF, fifteen on takumi-pdf's). Heading levels were ranks among
 * the heading-sized fonts present after table cells were removed; the longer
 * table changed what the table detector consumed, a size tier vanished from
 * the prose set, and every smaller tier moved up a rank. A table getting
 * longer blocked the run.
 *
 * The fixtures are the experiment's statement (Northmoor) from both producers,
 * before and after the rows were added.
 */
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/heading-stability/${name}.pdf`, import.meta.url)));

describe.each(['forme', 'takumi'] as const)('pdfjs heading inference is stable under content changes — %s output', (producer) => {
  it('adding rows to a table produces no heading events', async () => {
    const base = await fromPdf(fixture(`${producer}-statement`));
    const grown = await fromPdf(fixture(`${producer}-statement-24-rows`));
    const r = diffSnapshots(base, grown);
    expect(r.events.filter((e) => e.type === 'heading-hierarchy-changed').map((e) => e.message)).toEqual([]);
    // The table did grow; that is the event.
    expect(r.events.some((e) => e.type === 'table-resized')).toBe(true);
  });
});

describe('heading levels are bands anchored to the top heading', () => {
  const run = (text: string, fontSize: number, bold = false): PdfTextRun => ({ x: 40, y: 40, width: text.length * fontSize * 0.5, height: fontSize, text, fontSize, fontName: bold ? 'g_f2-Bold' : 'g_f1', bold, italic: false, charCount: text.length });
  const body = Array.from({ length: 12 }, (_, i) => run(`Body line ${i} of the invoice text, long enough to be the body.`, 12));
  it("a document's only heading is H1, whatever its size ratio", () => {
    // 20pt on a 12pt body: 1.67×, the third band by ratio; still the top heading.
    const m = buildHeadingModel([...body, run('Rechnung Nr. 471102', 20)]);
    expect(m.levelOf(run('Rechnung Nr. 471102', 20))).toBe(1);
  });
  it('lower headings keep their band distance from the top one', () => {
    const m = buildHeadingModel([...body, run('Title', 30), run('Section', 20), run('Sub', 16)]);
    expect([30, 20, 16].map((sz) => m.levelOf(run('x', sz)))).toEqual([1, 3, 4]);
  });
  it('a middle tier vanishing moves nothing else', () => {
    const withMiddle = buildHeadingModel([...body, run('Title', 30), run('Section', 20), run('Sub', 16)]);
    const without = buildHeadingModel([...body, run('Title', 30), run('Sub', 16)]);
    expect(without.levelOf(run('Title', 30))).toBe(withMiddle.levelOf(run('Title', 30)));
    expect(without.levelOf(run('Sub', 16))).toBe(withMiddle.levelOf(run('Sub', 16)));
  });
});

describe('an inferred heading level never blocks on its own', () => {
  const box = { x: 40, y: 40, width: 200, height: 20 };
  const demoted = (confidence: number) =>
    diffSnapshots(
      snapshot([node({ id: '0:heading:0', role: 'heading', headingLevel: 2, text: 'Confidentiality', bbox: box, confidence })]),
      snapshot([node({ id: '0:heading:0', role: 'heading', headingLevel: 3, text: 'Confidentiality', bbox: box, confidence })]),
    ).events.find((e) => e.type === 'heading-hierarchy-changed')!;
  it('at confidence 1 (the FormePDF path) the change is an error, as configured', () => {
    expect(demoted(1).severity).toBe('error');
  });
  it('below confidence 1 (the pdfjs path) the same change is a warning', () => {
    expect(demoted(0.8).severity).toBe('warn');
  });
});
