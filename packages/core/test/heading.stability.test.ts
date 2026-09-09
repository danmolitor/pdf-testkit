import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { diffSnapshots, fromPdf } from '@pdf-testkit/core';
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
