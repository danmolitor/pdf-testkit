/**
 * The producer corpus: a small set of logical documents expressed ONCE as a
 * semantic block model, rendered by every producer (Puppeteer, react-pdf,
 * PDFKit, Forme). The renderings are not pixel-identical across producers and
 * do not need to be — they are the same document semantically. Each producer
 * script walks these blocks and maps them to its own API as faithfully as it can.
 *
 * Each document has a `baseline` and a `changed` variant; the change is the
 * realistic edit a human would make, chosen to exercise one event type:
 *   invoice   — add line items so the table crosses a page   (pagination)
 *   contract  — demote an H2 heading to H3                   (heading hierarchy)
 *   statement — alter a total in one of several tables       (value change)
 *   compact   — move a block                                 (same-page move)
 */
export type DocId = 'invoice' | 'contract' | 'statement' | 'compact';
export type Variant = 'baseline' | 'changed';

export interface TableRow {
  cells: string[];
  /** undefined = a data row; 'section' spans all columns; 'total' is a totals row. */
  kind?: 'section' | 'total';
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'table'; columns: string[]; rows: TableRow[] };

export interface Doc {
  id: DocId;
  title: string;
  blocks: Block[];
}

export const DOC_IDS: DocId[] = ['invoice', 'contract', 'statement', 'compact'];

const money = (n: number): string => `$${n.toFixed(2)}`;

const ITEMS = [
  'Rocket-powered roller skates',
  'Giant electromagnet',
  'ACME anvil, 500 lb',
  'Spring-loaded boxing glove',
  'Jet-propelled unicycle',
  'Portable hole',
  'Earthquake pills',
  'Dehydrated boulders',
  'Fortified leg-muscle vitamins',
  'Bat-man outfit',
];

function invoiceRows(count: number): TableRow[] {
  const data: TableRow[] = [];
  let subtotal = 0;
  for (let i = 0; i < count; i++) {
    const qty = (i % 5) + 1;
    const unit = 19.99 + i * 3;
    const amount = qty * unit;
    subtotal += amount;
    // A colspan "section" row every 6 items, to exercise a full-width row.
    if (i % 6 === 0) data.push({ kind: 'section', cells: [`Group ${i / 6 + 1}`] });
    data.push({ cells: [`${ITEMS[i % ITEMS.length]} (SKU ${1000 + i})`, String(qty), money(unit), money(amount)] });
  }
  const tax = subtotal * 0.08;
  data.push({ kind: 'total', cells: ['', '', 'Subtotal', money(subtotal)] });
  data.push({ kind: 'total', cells: ['', '', 'Tax (8%)', money(tax)] });
  data.push({ kind: 'total', cells: ['', '', 'Total', money(subtotal + tax)] });
  return data;
}

function buildInvoice(variant: Variant): Doc {
  // baseline stays on one page; changed adds items so the table crosses a page.
  const rows = invoiceRows(variant === 'changed' ? 34 : 8);
  return {
    id: 'invoice',
    title: 'ACME Corporation — Invoice #1042',
    blocks: [
      { kind: 'heading', level: 1, text: 'ACME Corporation — Invoice #1042' },
      { kind: 'heading', level: 2, text: 'Bill To' },
      { kind: 'para', text: 'Wile E. Coyote, 1 Desert Road, Tucson, Arizona. Net 30 terms.' },
      { kind: 'heading', level: 2, text: 'Line Items' },
      { kind: 'table', columns: ['Item', 'Qty', 'Unit Price', 'Amount'], rows },
    ],
  };
}

const CONTRACT_PROSE =
  'This Agreement is entered into by and between the parties as of the effective date. ' +
  'Each party represents that it has full authority to enter into this Agreement and to ' +
  'perform its obligations hereunder. The provisions below govern the relationship in full ' +
  'and supersede any prior understanding, whether written or oral, relating to its subject.';

function buildContract(variant: Variant): Doc {
  // changed demotes the "Payment" H2 to H3.
  const paymentLevel: 2 | 3 = variant === 'changed' ? 3 : 2;
  return {
    id: 'contract',
    title: 'Master Services Agreement',
    blocks: [
      { kind: 'heading', level: 1, text: 'Master Services Agreement' },
      { kind: 'heading', level: 2, text: '1. Definitions' },
      { kind: 'para', text: CONTRACT_PROSE },
      { kind: 'heading', level: 3, text: '1.1 Interpretation' },
      { kind: 'para', text: CONTRACT_PROSE },
      { kind: 'heading', level: 2, text: '2. Scope of Services' },
      { kind: 'para', text: CONTRACT_PROSE },
      { kind: 'heading', level: paymentLevel, text: '3. Payment Terms' },
      { kind: 'para', text: CONTRACT_PROSE },
      { kind: 'heading', level: 3, text: '3.1 Late Fees' },
      { kind: 'para', text: CONTRACT_PROSE },
    ],
  };
}

function buildStatement(variant: Variant): Doc {
  // changed alters a total in the second (Payments) table.
  const paymentsTotal = variant === 'changed' ? 1450.0 : 1250.0;
  return {
    id: 'statement',
    title: 'Account Statement — August 2026',
    blocks: [
      { kind: 'heading', level: 1, text: 'Account Statement — August 2026' },
      { kind: 'heading', level: 2, text: 'Charges' },
      {
        kind: 'table',
        columns: ['Date', 'Description', 'Amount'],
        rows: [
          { cells: ['Aug 03', 'Subscription', money(99.0)] },
          { cells: ['Aug 12', 'Overage', money(41.5)] },
          { cells: ['Aug 20', 'Support plan', money(200.0)] },
          { kind: 'total', cells: ['', 'Total charges', money(340.5)] },
        ],
      },
      { kind: 'heading', level: 2, text: 'Payments' },
      {
        kind: 'table',
        columns: ['Date', 'Method', 'Amount'],
        rows: [
          { cells: ['Aug 05', 'ACH', money(1000.0)] },
          { cells: ['Aug 25', 'Card', money(paymentsTotal - 1000.0)] },
          { kind: 'total', cells: ['', 'Total payments', money(paymentsTotal)] },
        ],
      },
    ],
  };
}

function buildCompact(variant: Variant): Doc {
  const intro: Block = { kind: 'para', text: 'A short confirmation of your recent order.' };
  const notice: Block = { kind: 'para', text: 'Delivery is expected within five business days.' };
  // changed moves the notice above the table (a same-page block move).
  const table: Block = {
    kind: 'table',
    columns: ['Item', 'Qty'],
    rows: [
      { cells: ['Widget', '2'] },
      { cells: ['Gadget', '1'] },
    ],
  };
  const blocks: Block[] =
    variant === 'changed'
      ? [{ kind: 'heading', level: 1, text: 'Order Confirmation' }, intro, notice, table]
      : [{ kind: 'heading', level: 1, text: 'Order Confirmation' }, intro, table, notice];
  return { id: 'compact', title: 'Order Confirmation', blocks };
}

export function buildDoc(id: DocId, variant: Variant): Doc {
  switch (id) {
    case 'invoice':
      return buildInvoice(variant);
    case 'contract':
      return buildContract(variant);
    case 'statement':
      return buildStatement(variant);
    case 'compact':
      return buildCompact(variant);
  }
}

/** One-line description of each document's `changed` edit, for READMEs/tests. */
export const CHANGE_DESCRIPTION: Record<DocId, string> = {
  invoice: 'add line items so the table crosses a page',
  contract: 'demote the "Payment Terms" heading H2 → H3',
  statement: 'alter a total in the Payments table',
  compact: 'move the delivery-notice block above the table',
};
