// Generates an invoice PDF with @react-pdf/renderer (diegomura/react-pdf) using
// its documented component model. No JSX (so it runs under `node file.ts`); the
// createElement calls mirror the getting-started example. Headings are plain
// Text at larger font sizes — react-pdf has no semantic heading tag — which is
// exactly the case pdf-testkit's font-size clustering must handle.
import React from 'react';
import { Document, Page, View, Text, renderToBuffer } from '@react-pdf/renderer';
import { amount, buildSpec, money, type Variant } from './_spec.ts';

const h = React.createElement;

export async function generate(variant: Variant): Promise<Uint8Array> {
  const spec = buildSpec(variant);
  const itemsSize = spec.demoteItemsHeading ? 13 : 16; // H2 -> H3 when demoted

  const cell = (text: string, width: string, bold = false) =>
    h(Text, { style: { width, fontSize: 10, fontFamily: bold ? 'Helvetica-Bold' : 'Helvetica' } }, text);

  const row = (cells: React.ReactNode[]) =>
    h(View, { style: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#cccccc', paddingVertical: 3 } }, ...cells);

  const doc = h(
    Document,
    null,
    h(
      Page,
      { size: 'A4', style: { padding: 40 } },
      h(Text, { style: { fontSize: 22, fontFamily: 'Helvetica-Bold', marginBottom: 12 } }, spec.title),
      h(Text, { style: { fontSize: 16, fontFamily: 'Helvetica-Bold', marginBottom: 4 } }, spec.billToHeading),
      h(Text, { style: { fontSize: 10, marginBottom: 12 } }, spec.billTo),
      h(Text, { style: { fontSize: itemsSize, fontFamily: 'Helvetica-Bold', marginBottom: 6 } }, spec.itemsHeading),
      row(spec.columns.map((c, i) => cell(c, i === 0 ? '55%' : '15%', true))),
      ...spec.rows.map((r) =>
        row([cell(r.item, '55%'), cell(String(r.qty), '15%'), cell(money(r.unit), '15%'), cell(money(amount(r)), '15%')]),
      ),
      ...spec.notes.map((n) => h(Text, { style: { fontSize: 10, marginTop: 8 } }, n)),
    ),
  );

  return new Uint8Array(await renderToBuffer(doc));
}
