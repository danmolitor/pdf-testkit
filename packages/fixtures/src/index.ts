import { fileURLToPath } from 'node:url';

/** Absolute path to a bundled sample PDF (hermetic — copied into this package). */
export function fixturePath(name: FixtureName): string {
  return fileURLToPath(new URL(`../pdfs/${name}.pdf`, import.meta.url));
}

export type FixtureName = 'invoice' | 'catalog' | 'report' | 'certified';

export const FIXTURES: FixtureName[] = ['invoice', 'catalog', 'report', 'certified'];
