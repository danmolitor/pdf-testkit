// Regenerates the whole producer corpus: every logical document (_spec.ts)
// rendered by every producer, plus Forme's authoritative layout sidecar, plus a
// manifest recording producer/version/command/structure-hash per fixture.
//
// Run: `node packages/fixtures/producers/generate.ts`
// Needs the fixtures dev deps (@react-pdf/renderer, pdfkit, puppeteer-core +
// system/CI Chrome, @formepdf/core + @formepdf/react). The generated files are
// committed so the per-commit assertion suite is hermetic and never renders.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fromPdf, fromFormeLayout } from '@pdf-testkit/core';
import { DOC_IDS, type DocId, type Variant } from './_spec.ts';
import * as reactPdf from './react-pdf.ts';
import * as pdfkit from './pdfkit.ts';
import * as puppeteer from './puppeteer.ts';
import * as forme from './forme.ts';

const require = createRequire(import.meta.url);
const pdfsDir = fileURLToPath(new URL('../pdfs/', import.meta.url));
const manifestPath = fileURLToPath(new URL('../corpus-manifest.json', import.meta.url));

const PRODUCERS = [reactPdf, pdfkit, puppeteer, forme];
const VARIANTS: Variant[] = ['baseline', 'changed'];

function versionOf(pkg: string): string {
  try {
    return require(`${pkg}/package.json`).version as string;
  } catch {
    // Some packages gate ./package.json behind exports; resolve the main file.
    const main = require.resolve(pkg).replace(/\.[cm]?js$/, '');
    return require(`${main.slice(0, main.lastIndexOf('/'))}/../package.json`)?.version ?? 'unknown';
  }
}

interface Entry {
  producer: string;
  producerVersion: string;
  doc: DocId;
  variant: Variant;
  renderCommand: string;
  file: string;
  structureHash: string; // pdfjs-path structure of the committed PDF
  layoutHash?: string; // Forme only: authoritative LayoutInfo structure
}

const manifest: Entry[] = [];

for (const mod of PRODUCERS) {
  const version = versionOf(mod.meta.packageName);
  for (const doc of DOC_IDS) {
    for (const variant of VARIANTS) {
      const bytes = await mod.generate(doc, variant);
      const file = `${mod.meta.id}-${doc}-${variant}.pdf`;
      writeFileSync(pdfsDir + file, Buffer.from(bytes));
      const snap = await fromPdf(new Uint8Array(bytes), { source: { name: file } });
      const entry: Entry = { producer: mod.meta.id, producerVersion: version, doc, variant, renderCommand: mod.meta.renderCommand, file, structureHash: snap.contentHash };

      if (mod === forme) {
        const layout = await forme.generateLayout(doc, variant);
        const sidecar = `${file}.layout.json`;
        writeFileSync(pdfsDir + sidecar, JSON.stringify(layout));
        entry.layoutHash = fromFormeLayout(layout, { source: { name: sidecar } }).contentHash;
      }

      manifest.push(entry);
      const roles: Record<string, number> = {};
      for (const n of snap.nodes) roles[n.role] = (roles[n.role] ?? 0) + 1;
      console.log(`${mod.meta.id}/${doc}/${variant}`.padEnd(28), `p${snap.pageCount}`, `h${roles.heading ?? 0}`, `tbl${roles.table ?? 0}`, `row${roles.row ?? 0}`, `cell${roles.cell ?? 0}`);
    }
  }
}

manifest.sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`\nwrote ${manifest.length} fixtures + manifest`);
