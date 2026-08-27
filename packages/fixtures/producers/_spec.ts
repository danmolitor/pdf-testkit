/**
 * A single representative invoice spec, rendered by each producer (react-pdf,
 * PDFKit, Puppeteer) so pdf-testkit's general/pdfjs path can be measured against
 * real third-party output. Not a synthetic stress test: title + two section
 * headings + a paragraph + a multi-column line-item table long enough to cross a
 * page break — what an actual invoice looks like.
 */
export type Variant = 'baseline' | 'heading-demoted' | 'reordered';

export interface LineItem {
  item: string;
  qty: number;
  unit: number;
}

export interface InvoiceSpec {
  title: string;
  billToHeading: string;
  billTo: string;
  itemsHeading: string;
  /** true in the 'heading-demoted' variant: render itemsHeading one level smaller. */
  demoteItemsHeading: boolean;
  columns: string[];
  rows: LineItem[];
  /** trailing paragraphs, reordered in the 'reordered' variant. */
  notes: string[];
}

const ITEMS = [
  'Rocket-powered roller skates',
  'Giant electromagnet',
  'ACME anvil, 500 lb',
  'Spring-loaded boxing glove',
  'Jet-propelled unicycle',
  'Portable hole',
  'Earthquake pills',
  'Dehydrated boulders',
  'Triple-strength fortified leg muscle vitamins',
  'Bat-man outfit',
];

const NOTES = [
  'Payment is due within 30 days of the invoice date via bank transfer.',
  'Thank you for your continued business with ACME Corporation.',
];

export function buildSpec(variant: Variant): InvoiceSpec {
  const rows: LineItem[] = Array.from({ length: 45 }, (_, i) => ({
    item: `${ITEMS[i % ITEMS.length]} (SKU ${1000 + i})`,
    qty: (i % 5) + 1,
    unit: 19.99 + i * 3,
  }));
  return {
    title: 'ACME Corporation — Invoice #1042',
    billToHeading: 'Bill To',
    billTo: 'Wile E. Coyote, 1 Desert Road, Tucson, Arizona. Net 30 terms.',
    itemsHeading: 'Line Items',
    demoteItemsHeading: variant === 'heading-demoted',
    columns: ['Item', 'Qty', 'Unit Price', 'Amount'],
    rows,
    notes: variant === 'reordered' ? [...NOTES].reverse() : NOTES,
  };
}

export const amount = (r: LineItem): number => r.qty * r.unit;
export const money = (n: number): string => `$${n.toFixed(2)}`;
