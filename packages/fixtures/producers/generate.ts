// Regenerates the committed general-path fixture PDFs from the three producers.
// Run with: `node packages/fixtures/producers/generate.ts` (needs the fixtures
// dev deps: @react-pdf/renderer, pdfkit, puppeteer-core + system Chrome). The
// generated PDFs are committed so the regression test stays hermetic and fast —
// it never launches Chrome or imports the producer libraries.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Variant } from './_spec.ts';

const outPath = (name: string): string => fileURLToPath(new URL(`../pdfs/${name}.pdf`, import.meta.url));

const producers: Record<string, { generate: (v: Variant) => Promise<Uint8Array> }> = {
  'react-pdf': await import('./react-pdf.ts'),
  pdfkit: await import('./pdfkit.ts'),
  puppeteer: await import('./puppeteer.ts'),
};

const variants: [Variant, string][] = [
  ['baseline', ''],
  ['heading-demoted', '-demoted'],
  ['reordered', '-reordered'],
];

for (const [name, mod] of Object.entries(producers)) {
  for (const [variant, suffix] of variants) {
    const bytes = await mod.generate(variant);
    const file = `${name}-invoice${suffix}`;
    writeFileSync(outPath(file), bytes);
    console.log(`wrote ${file}.pdf (${bytes.length} bytes)`);
  }
}
console.log('done');
