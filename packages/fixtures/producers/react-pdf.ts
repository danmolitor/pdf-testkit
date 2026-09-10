// react-pdf (@react-pdf/renderer) — declarative component model, no JSX so it
// runs under `node file.ts`. Headings are plain Text at larger sizes (react-pdf
// has no heading tag), the exact case the font-size heading model must handle.
import React from 'react';
import { Document, Page, View, Text, renderToBuffer } from '@react-pdf/renderer';
import { buildDoc, type Block, type DocId, type TableRow, type Variant } from './_spec.ts';

export const meta = {
  id: 'react-pdf' as const,
  packageName: '@react-pdf/renderer',
  renderCommand: 'renderToBuffer(<Document>…)',
};

const h = React.createElement;
const HSIZE: Record<1 | 2 | 3, number> = { 1: 22, 2: 16, 3: 13 };

function colWidths(n: number): string[] {
  if (n <= 1) return ['100%'];
  const first = 55;
  const rest = (100 - first) / (n - 1);
  return [`${first}%`, ...Array.from({ length: n - 1 }, () => `${rest}%`)];
}

function tableRow(row: TableRow, widths: string[], header = false): React.ReactNode {
  const bold = header || row.kind === 'total';
  const style = { flexDirection: 'row' as const, borderBottomWidth: 1, borderBottomColor: '#cccccc', paddingVertical: 3 };
  if (row.kind === 'section') {
    return h(View, { style: { ...style, backgroundColor: '#f0f0f0' } }, h(Text, { style: { width: '100%', fontSize: 10, fontFamily: 'Helvetica-Bold' } }, row.cells[0] ?? ''));
  }
  return h(
    View,
    { style },
    ...widths.map((w, i) => h(Text, { key: i, style: { width: w, fontSize: 10, fontFamily: bold ? 'Helvetica-Bold' : 'Helvetica' } }, row.cells[i] ?? '')),
  );
}

function renderBlock(b: Block, i: number): React.ReactNode {
  if (b.kind === 'heading') {
    return h(Text, { key: i, style: { fontSize: HSIZE[b.level], fontFamily: 'Helvetica-Bold', marginTop: 8, marginBottom: 4 } }, b.text);
  }
  if (b.kind === 'para') {
    return h(Text, { key: i, style: { fontSize: 10, marginBottom: 6, lineHeight: 1.4 } }, b.text);
  }
  const widths = colWidths(b.columns.length);
  return h(
    View,
    { key: i, style: { marginBottom: 8 } },
    tableRow({ cells: b.columns }, widths, true),
    ...b.rows.map((r) => tableRow(r, widths)),
  );
}

export async function generate(docId: DocId, variant: Variant): Promise<Uint8Array> {
  const doc = buildDoc(docId, variant);
  const el = h(Document, null, h(Page, { size: 'A4', style: { padding: 40 } }, ...doc.blocks.map(renderBlock)));
  return new Uint8Array(await renderToBuffer(el));
}
