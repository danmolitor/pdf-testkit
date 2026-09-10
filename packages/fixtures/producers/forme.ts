// Forme (@formepdf) — the calibration point. It is the only producer that emits
// authoritative structure (LayoutInfo: real H1/Table/TableCell node types) AND a
// PDF that also goes through the pdfjs path. Comparing the two gives every other
// producer's pdfjs fidelity a reference: "PDFKit is materially worse" needs a
// ground truth, and this is it.
import React from 'react';
import { renderDocumentWithLayout, type FormeLayoutInfo } from '@formepdf/core';
import * as C from '@formepdf/react';
import { buildDoc, type Block, type DocId, type TableRow, type Variant } from './_spec.ts';

export const meta = {
  id: 'forme' as const,
  packageName: '@formepdf/core',
  renderCommand: 'renderDocumentWithLayout(<Document>)',
};

const h = React.createElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const HTAG: Record<1 | 2 | 3, any> = { 1: C.H1, 2: C.H2, 3: C.H3 };

function cell(text: string, bold = false): React.ReactNode {
  return h(C.Cell, null, h(C.Text, bold ? { style: { fontWeight: 700 } } : null, text));
}

function tableRow(row: TableRow, cols: number): React.ReactNode {
  if (row.kind === 'section') {
    // Padded to the column count (Forme cells are per-column); the first carries
    // the label. Still a real TableRow/TableCell in the layout.
    return h(C.Row, null, cell(row.cells[0] ?? '', true), ...Array.from({ length: cols - 1 }, () => cell('')));
  }
  const bold = row.kind === 'total';
  return h(C.Row, null, ...Array.from({ length: cols }, (_, i) => cell(row.cells[i] ?? '', bold)));
}

function block(b: Block, i: number): React.ReactNode {
  if (b.kind === 'heading') return h(HTAG[b.level], { key: i }, b.text);
  if (b.kind === 'para') return h(C.Text, { key: i }, b.text);
  const columns = b.columns.map(() => ({ width: { fraction: 1 / b.columns.length } }));
  return h(
    C.Table,
    { key: i, columns },
    h(C.Row, { header: true }, ...b.columns.map((c) => cell(c, true))),
    ...b.rows.map((r) => tableRow(r, b.columns.length)),
  );
}

function element(docId: DocId, variant: Variant): React.ReactElement {
  const doc = buildDoc(docId, variant);
  return h(C.Document, null, ...doc.blocks.map(block));
}

export async function generate(docId: DocId, variant: Variant): Promise<Uint8Array> {
  const { pdf } = await renderDocumentWithLayout(element(docId, variant));
  return new Uint8Array(pdf);
}

/** The authoritative layout — committed as a `.layout.json` sidecar and used to
 * calibrate the pdfjs path's fidelity on the same document. */
export async function generateLayout(docId: DocId, variant: Variant): Promise<FormeLayoutInfo> {
  const { layout } = await renderDocumentWithLayout(element(docId, variant));
  return layout as FormeLayoutInfo;
}
