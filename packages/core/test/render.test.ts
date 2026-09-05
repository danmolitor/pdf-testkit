import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fromPdf, renderPages } from '@pdf-testkit/core';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/pdfs/${name}.pdf`, import.meta.url))));

const isWebp = (b: Uint8Array): boolean =>
  b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP';

describe('renderPages — page images for the review screen', () => {
  it('renders every page as WebP at the requested dpi with the geometry the protocol promises', async () => {
    const bytes = fixture('invoice');
    const snap = await fromPdf(bytes);
    const out = await renderPages(bytes, { dpi: 72 });
    expect(out.format).toBe('image/webp');
    expect(out.dpi).toBe(72);
    expect(out.pages).toHaveLength(snap.pageCount);
    out.pages.forEach((p, i) => {
      expect(p.index).toBe(i);
      // §5 coordinate contract: width_px = round(page.width × dpi / 72).
      expect(p.widthPx).toBe(Math.round(snap.pages[i]!.width * 72 / 72));
      expect(p.heightPx).toBe(Math.round(snap.pages[i]!.height * 72 / 72));
      expect(isWebp(p.bytes)).toBe(true);
      expect(p.bytes.length).toBeGreaterThan(100);
    });
  });

  it('names the renderer so the service can tell when two image sets are not pixel-comparable', async () => {
    const out = await renderPages(fixture('invoice'), { dpi: 72 });
    expect(out.rendererId).toMatch(/^pdfjs-\d+\.\d+\.\d+\+napi-canvas-\d+\.\d+\.\d+$/);
  });

  it('is deterministic: the same bytes render to identical images', async () => {
    const bytes = fixture('report');
    const a = await renderPages(bytes, { dpi: 72 });
    const b = await renderPages(bytes, { dpi: 72 });
    expect(a.pages.map((p) => Buffer.from(p.bytes).toString('base64'))).toEqual(
      b.pages.map((p) => Buffer.from(p.bytes).toString('base64')),
    );
  });

  it('scales with dpi', async () => {
    const bytes = fixture('invoice');
    const lo = await renderPages(bytes, { dpi: 72 });
    const hi = await renderPages(bytes, { dpi: 144 });
    expect(hi.pages[0]!.widthPx).toBe(lo.pages[0]!.widthPx * 2);
  });

  it('rejects a dpi outside the protocol range', async () => {
    await expect(renderPages(fixture('invoice'), { dpi: 20 })).rejects.toThrow(/dpi/);
  });
});

/**
 * Regression guard for the notdef-box failure. The first version of the test
 * above passed on page counts, dimensions and WebP magic bytes while every
 * glyph was drawn as a hollow box, because pdfjs in Node had no font registry
 * to load faces into. Structural checks verify what someone thought to check;
 * this one looks at the ink.
 *
 * Calibrated on real renders (dpi 96, three producers): legible text runs have
 * 12–19 % ink inside their bounding box and ≥ 95 % distinct per-character
 * cells; the notdef render has 1–6 % ink and 30–65 % distinct cells. Thresholds
 * sit well clear of both.
 */
async function glyphVariety(webp: Uint8Array, snap: Awaited<ReturnType<typeof fromPdf>>, dpi: number, pageIndex: number) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(Buffer.from(webp));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const s = dpi / 72;
  const runs = snap.nodes
    .filter((n) => n.pageIndex === pageIndex && n.text && n.text.trim().length >= 12)
    .sort((a, b) => b.text!.length - a.text!.length)
    .slice(0, 5);
  expect(runs.length).toBeGreaterThan(0);
  return runs.map((n) => {
    const x0 = Math.floor(n.bbox.x * s), y0 = Math.floor(n.bbox.y * s);
    const w = Math.ceil(n.bbox.width * s), h = Math.ceil(n.bbox.height * s);
    const data = ctx.getImageData(x0, y0, w, h).data;
    const chars = n.text!.length;
    const cellW = w / chars;
    const cells = new Set<string>();
    let ink = 0;
    for (let i = 0; i < chars; i++) {
      const cx0 = Math.floor(i * cellW), cx1 = Math.floor((i + 1) * cellW);
      let bits = '';
      for (let y = 0; y < h; y++) {
        for (let x = cx0; x < cx1; x++) {
          const k = (y * w + x) * 4;
          const dark = data[k]! + data[k + 1]! + data[k + 2]! < 384;
          if (dark) ink++;
          bits += dark ? '1' : '0';
        }
      }
      cells.add(bits);
    }
    return { text: n.text!, inkFraction: ink / (w * h), distinctCells: cells.size / chars };
  });
}

describe('renderPages — the text is actually drawn', () => {
  for (const name of ['invoice', 'pdfkit-invoice', 'puppeteer-invoice']) {
    it(`${name}: text runs are ink, not a grid of identical glyph boxes`, async () => {
      const bytes = fixture(name);
      const snap = await fromPdf(bytes);
      const out = await renderPages(bytes, { dpi: 96 });
      const runs = await glyphVariety(out.pages[0]!.bytes, snap, 96, 0);
      for (const r of runs) {
        expect(r.inkFraction, `ink in "${r.text}"`).toBeGreaterThan(0.08);
        expect(r.distinctCells, `glyph variety in "${r.text}"`).toBeGreaterThan(0.8);
      }
    });
  }
});
