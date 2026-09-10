// Puppeteer — Chrome rendering HTML to PDF (page.pdf), the market path. Real
// <h1>/<h2>/<h3> and a bordered <table> with a repeating <thead> and colspan
// section rows. Chrome is discovered from the environment so this runs on a CI
// runner (google-chrome) or locally (macOS Chrome), no bundled Chromium.
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { buildDoc, type Block, type DocId, type TableRow, type Variant } from './_spec.ts';

export const meta = {
  id: 'puppeteer' as const,
  packageName: 'puppeteer-core',
  renderCommand: 'chrome page.pdf({ format: "A4" })',
};

function chromePath(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p));
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tableRowHtml(row: TableRow, cols: number): string {
  if (row.kind === 'section') return `<tr class="section"><td colspan="${cols}">${esc(row.cells[0] ?? '')}</td></tr>`;
  const cls = row.kind === 'total' ? ' class="total"' : '';
  return `<tr${cls}>${row.cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`;
}

function blockHtml(b: Block): string {
  if (b.kind === 'heading') return `<h${b.level}>${esc(b.text)}</h${b.level}>`;
  if (b.kind === 'para') return `<p>${esc(b.text)}</p>`;
  return (
    `<table><thead><tr>${b.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>` +
    `<tbody>${b.rows.map((r) => tableRowHtml(r, b.columns.length)).join('')}</tbody></table>`
  );
}

export async function generate(docId: DocId, variant: Variant): Promise<Uint8Array> {
  const doc = buildDoc(docId, variant);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: Helvetica, Arial, sans-serif; font-size: 13px; color: #111; }
    h1 { font-size: 26px; } h2 { font-size: 19px; } h3 { font-size: 15px; }
    table { border-collapse: collapse; width: 100%; font-size: 11px; margin: 8px 0; }
    thead { display: table-header-group; }         /* repeat header across page breaks */
    th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; }
    th, tr.total td { font-weight: bold; }
    tr.section td { background: #f0f0f0; font-weight: bold; }
    p { line-height: 1.4; }
  </style></head><body>${doc.blocks.map(blockHtml).join('')}</body></html>`;

  const exe = chromePath();
  const browser = await puppeteer.launch(
    exe ? { executablePath: exe, headless: true } : { channel: 'chrome', headless: true },
  );
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '40px', bottom: '40px', left: '40px', right: '40px' },
    });
    return new Uint8Array(pdf);
  } finally {
    await browser.close();
  }
}
