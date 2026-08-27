// Generates an invoice PDF by rendering HTML with Chrome via Puppeteer, the
// Puppeteer "PDF generation" documented pattern (page.pdf()). Uses puppeteer-core
// + the system Chrome so no Chromium download is needed. Headings are real
// <h1>/<h2> (Chrome renders them larger/bold); the table is a normal bordered
// <table> — a ruled grid — so this also touches the ruled-table case.
import puppeteer from 'puppeteer-core';
import { amount, buildSpec, money, type Variant } from './_spec.ts';

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function generate(variant: Variant): Promise<Uint8Array> {
  const spec = buildSpec(variant);
  const itemsTag = spec.demoteItemsHeading ? 'h3' : 'h2'; // real HTML heading demotion

  const rowsHtml = spec.rows
    .map(
      (r) =>
        `<tr><td>${r.item}</td><td>${r.qty}</td><td>${money(r.unit)}</td><td>${money(amount(r))}</td></tr>`,
    )
    .join('');
  const notesHtml = spec.notes.map((n) => `<p class="note">${n}</p>`).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: Helvetica, Arial, sans-serif; font-size: 13px; color: #111; }
    h1 { font-size: 26px; } h2 { font-size: 19px; } h3 { font-size: 15px; }
    table { border-collapse: collapse; width: 100%; font-size: 11px; }
    th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; }
    th { background: #eee; }
    p.note { margin: 6px 0 0; }
  </style></head><body>
    <h1>${spec.title}</h1>
    <h2>${spec.billToHeading}</h2>
    <p>${spec.billTo}</p>
    <${itemsTag}>${spec.itemsHeading}</${itemsTag}>
    <table><thead><tr>${spec.columns.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
    <tbody>${rowsHtml}</tbody></table>
    ${notesHtml}
  </body></html>`;

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
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
