// Generates an invoice PDF with PDFKit. PDFKit has no table primitive; the
// common real-world pattern is manual column positioning plus DRAWN RULED LINES
// under each row. That is deliberate here — it exercises pdf-testkit's known
// deferred gap (tables whose grid is drawn, not whitespace-separated). The text
// is still placed in columns, so this measures whether column clustering can
// recover the table from the text alone despite the ruled borders.
import PDFDocument from 'pdfkit';
import { amount, buildSpec, money, type Variant } from './_spec.ts';

const COLS = [40, 300, 380, 470]; // x of each column
const RIGHT = 555;
const BOTTOM = 800;

export async function generate(variant: Variant): Promise<Uint8Array> {
  const spec = buildSpec(variant);
  const itemsSize = spec.demoteItemsHeading ? 13 : 16;

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.font('Helvetica-Bold').fontSize(22).text(spec.title, 40, 40);
  doc.moveDown(0.5).font('Helvetica-Bold').fontSize(16).text(spec.billToHeading);
  doc.font('Helvetica').fontSize(10).text(spec.billTo);
  doc.moveDown(0.5).font('Helvetica-Bold').fontSize(itemsSize).text(spec.itemsHeading);

  let y = doc.y + 8;
  const drawRow = (cells: string[], bold = false): void => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
    cells.forEach((c, i) => {
      const w = (COLS[i + 1] ?? RIGHT) - COLS[i] - 6;
      doc.text(c, COLS[i], y, { width: w, lineBreak: false, ellipsis: true });
    });
    doc.moveTo(40, y + 13).lineTo(RIGHT, y + 13).lineWidth(0.5).stroke(); // ruled line under the row
    y += 18;
    if (y > BOTTOM) {
      doc.addPage();
      y = 40;
    }
  };

  drawRow(spec.columns, true);
  for (const r of spec.rows) drawRow([r.item, String(r.qty), money(r.unit), money(amount(r))]);

  let ny = y + 10;
  doc.font('Helvetica').fontSize(10);
  for (const n of spec.notes) {
    doc.text(n, 40, ny);
    ny += 16;
  }

  doc.end();
  return new Uint8Array(await done);
}
