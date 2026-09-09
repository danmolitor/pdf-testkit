import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { fromPdf } from '@pdf-testkit/core';
import { collapseTracked, mergeRuns, type PdfTextRun } from '../src/extract/pdfjs/textRuns.js';

/**
 * Regression (extraction-fidelity experiment, 2026-09-09, finding P6): a
 * producer that positions glyphs individually for letter-spacing (Chromium's
 * print-to-PDF, takumi-pdf, Forme's tracked labels) hands pdfjs one item per
 * glyph, and the run stage joined them with spaces: "N O R T H M O O R". A
 * change to how a producer implements tracking then read as the word removed
 * and a spaced word added, five phantom events on the engine's memo (#82).
 * Glyphs that sit at a uniform small gap are one word; a gap well above that
 * rhythm is the space between words.
 */
const run = (x: number, text: string, fontSize = 10, width = text.length * fontSize * 0.6): PdfTextRun => ({ x, y: 100, width, height: fontSize, text, fontSize, fontName: 'g_f1', bold: false, italic: false, charCount: text.length });

describe('a tracked label pdfjs hands over as one spaced item', () => {
  it('collapses to the word', () => {
    expect(collapseTracked('N O R T H M O O R')).toBe('NORTHMOOR');
    expect(collapseTracked('I N C .')).toBe('INC.');
    // A kerned pair inside the label is still tracking.
    expect(collapseTracked('R E C E I VA B L E')).toBe('RECEIVABLE');
    expect(collapseTracked('S TAT E M E N T')).toBe('STATEMENT');
  });
  it('leaves plain text alone, including short words and initials', () => {
    expect(collapseTracked('Payment due within 30 days.')).toBe('Payment due within 30 days.');
    expect(collapseTracked('a b')).toBe('a b');
    expect(collapseTracked('J. R. R. Tolkien')).toBe('J. R. R. Tolkien');
    expect(collapseTracked('I am a cat')).toBe('I am a cat');
  });
});

describe('letter-spaced glyphs merge into words', () => {
  it('uniformly tracked single glyphs are one word; a wider gap is a word break', () => {
    // "OPEN ITEMS" at 10pt, glyph advance 6pt, tracking 2.5pt (0.25em, above the
    // 0.2em plain-text space threshold), word space 3pt + tracking = 0.55em,
    // still within the 0.6em adjacency that keeps columns apart.
    const glyphs: PdfTextRun[] = [];
    let x = 0;
    for (const word of ['OPEN', 'ITEMS']) {
      for (const ch of word) { glyphs.push(run(x, ch, 10, 6)); x += 6 + 2.5; }
      x += 3; // the space glyph's advance (whitespace items are dropped upstream)
    }
    expect(mergeRuns(glyphs).map((r) => r.text)).toEqual(['OPEN ITEMS']);
    // A kerned pair inside a tracked word ("VA" in RECEIVABLE) is still the same word.
    const pair = [run(0, 'R', 10, 6), run(8.5, 'E', 10, 6), run(17, 'C', 10, 6), run(25.5, 'VA', 10, 12), run(40, 'B', 10, 6)];
    expect(mergeRuns(pair).map((r) => r.text)).toEqual(['RECVAB']);
  });

  it('plain text keeps its word spacing', () => {
    const items = [run(0, 'Payment', 10, 40), run(43, 'due', 10, 18), run(64, 'within', 10, 34)];
    expect(mergeRuns(items).map((r) => r.text)).toEqual(['Payment due within']);
  });

  it('a genuine one-letter word is not glued to its neighbour', () => {
    // "a cat": normal word gap of 0.3em after a single-glyph item.
    const items = [run(0, 'a', 10, 5), run(8, 'cat', 10, 18)];
    expect(mergeRuns(items).map((r) => r.text)).toEqual(['a cat']);
  });
});

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}.pdf`, import.meta.url)));
describe.each([
  ['takumi-pdf', 'heading-stability/takumi-statement'],
  ['Forme', 'heading-stability/forme-statement'],
])('on real output — %s', (_producer, path) => {
  it('tracked labels come through as words, never as spaced letters', async () => {
    const snap = await fromPdf(fixture(path));
    const texts = snap.nodes.map((n) => n.text ?? '');
    expect(texts.filter((t) => /(?:^|\s)\S \S \S(?:\s|$)/.test(t))).toEqual([]);
    expect(texts.some((t) => /NORTHMOOR/.test(t))).toBe(true);
    expect(texts.some((t) => /AGEING/.test(t))).toBe(true);
  });
});
