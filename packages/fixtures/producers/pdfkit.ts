// PDFKit — imperative API, no document structure at all: text is positioned by
// coordinate, tables are drawn with ruled lines. The honest worst case for the
// pdfjs heuristics. CreationDate is pinned so the committed PDF bytes are stable.
import PDFDocument from 'pdfkit';
import { buildDoc, type Block, type DocId, type TableRow, type Variant } from './_spec.ts';

export const meta = {
  id: 'pdfkit' as const,
  packageName: 'pdfkit',
  renderCommand: 'new PDFDocument() + imperative text/lines',
};

const HSIZE: Record<1 | 2 | 3, number> = { 1: 22, 2: 16, 3: 13 };
const LEFT = 40;
const RIGHT = 555;
const BOTTOM = 800;

export async function generate(docId: DocId, variant: Variant): Promise<Uint8Array> {
  const doc = buildDoc(docId, variant);
  const pdf = new PDFDocument({ size: 'A4', margin: 40 });
  pdf.info.CreationDate = new Date(0); // pin for byte-stable fixtures
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));

  let y = 40;
  const ensure = (need: number): void => {
    if (y + need > BOTTOM) {
      pdf.addPage();
      y = 40;
    }
  };

  for (const b of doc.blocks) {
    if (b.kind === 'heading') {
      ensure(HSIZE[b.level] + 8);
      pdf.font('Helvetica-Bold').fontSize(HSIZE[b.level]).text(b.text, LEFT, y);
      y = pdf.y + 6;
    } else if (b.kind === 'para') {
      ensure(28);
      pdf.font('Helvetica').fontSize(10).text(b.text, LEFT, y, { width: RIGHT - LEFT });
      y = pdf.y + 6;
    } else {
      const n = b.columns.length;
      const colX = Array.from({ length: n }, (_, i) => LEFT + (i * (RIGHT - LEFT)) / n);
      const drawRow = (row: TableRow, bold: boolean): void => {
        ensure(18);
        pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
        if (row.kind === 'section') {
          pdf.text(row.cells[0] ?? '', LEFT, y, { width: RIGHT - LEFT, lineBreak: false });
        } else {
          row.cells.forEach((c, i) => {
            const w = (colX[i + 1] ?? RIGHT) - (colX[i] ?? LEFT) - 6;
            pdf.text(c, colX[i] ?? LEFT, y, { width: w, lineBreak: false, ellipsis: true });
          });
        }
        pdf.moveTo(LEFT, y + 13).lineTo(RIGHT, y + 13).lineWidth(0.5).stroke();
        y += 18;
      };
      drawRow({ cells: b.columns }, true);
      for (const row of b.rows) drawRow(row, row.kind === 'total');
      y += 6;
    }
  }

  pdf.end();
  return new Uint8Array(await done);
}
