// Investigation harness (not the committed test): runs pdf-testkit's general
// pdfjs path against real react-pdf / PDFKit / Puppeteer output and reports what
// it actually sees, so the README reliability matrix can be replaced with
// measured findings instead of design-time estimates.
import { fromPdf, diffSnapshots } from '@pdf-testkit/core';
import type { Variant } from './_spec.ts';

const producers: Record<string, { generate: (v: Variant) => Promise<Uint8Array> }> = {
  'react-pdf': await import('./react-pdf.ts'),
  pdfkit: await import('./pdfkit.ts'),
  puppeteer: await import('./puppeteer.ts'),
};

const EXPECTED_HEADINGS = ['ACME Corporation', 'Bill To', 'Line Items'];

for (const [name, mod] of Object.entries(producers)) {
  console.log(`\n================ ${name} ================`);
  try {
    const bytes = await mod.generate('baseline');
    const snap = await fromPdf(bytes, { source: { name } });

    const roles: Record<string, number> = {};
    for (const n of snap.nodes) roles[n.role] = (roles[n.role] ?? 0) + 1;
    console.log('pages:', snap.pageCount, '| roles:', JSON.stringify(roles));

    const headings = snap.nodes.filter((n) => n.role === 'heading');
    console.log(`headings detected (${headings.length}):`);
    for (const h of headings) {
      console.log(`   H${h.headingLevel}  ${JSON.stringify((h.text ?? '').slice(0, 45))}  conf=${h.confidence}`);
    }
    const detectedTexts = headings.map((h) => h.text ?? '');
    const missed = EXPECTED_HEADINGS.filter((e) => !detectedTexts.some((t) => t.includes(e)));
    const extra = headings.filter((h) => !EXPECTED_HEADINGS.some((e) => (h.text ?? '').includes(e)));
    console.log('   expected-but-missed:', missed.length ? missed.join(', ') : 'none ✓');
    console.log('   over-fired (not a real heading):', extra.length ? extra.map((h) => JSON.stringify((h.text ?? '').slice(0, 30))).join(', ') : 'none ✓');

    const table = snap.nodes.find((n) => n.role === 'table');
    console.log('table:', table ? `DETECTED ${JSON.stringify(table.table)} (rows=${roles.row ?? 0}, cells=${roles.cell ?? 0}, conf=${table.confidence})` : 'NOT DETECTED — fell through to text runs');

    console.log('confidence values present:', [...new Set(snap.nodes.map((n) => n.confidence))].sort((a, b) => a - b).join(', '));

    // POSITIVE — demote the "Line Items" heading; expect heading-hierarchy-changed.
    const pos = diffSnapshots(snap, await fromPdf(await mod.generate('heading-demoted')));
    const hh = pos.events.filter((e) => e.type === 'heading-hierarchy-changed');
    console.log(`POSITIVE (Line Items demoted): ${hh.length ? 'CAUGHT ✓ — ' + hh.map((e) => e.message).join(' | ') : 'MISSED ✗ — no heading-hierarchy-changed'}  [${pos.events.length} total events: ${[...new Set(pos.events.map((e) => e.type))].join(', ')}]`);

    // NEGATIVE — reorder two trailing notes; expect no blocking events.
    const neg = diffSnapshots(snap, await fromPdf(await mod.generate('reordered')));
    const blocking = neg.events.filter((e) => e.severity !== 'info');
    console.log(`NEGATIVE (notes reordered): ${blocking.length === 0 ? 'CLEAN ✓' : 'FALSE ALARM ✗ — ' + blocking.map((e) => `${e.type} ${(e.message ?? '').slice(0, 50)}`).join(' | ')}  [${neg.events.length} total]`);
  } catch (err) {
    console.log('ERROR:', (err as Error).message);
  }
}
console.log('\n(done)');
