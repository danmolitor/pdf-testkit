import { fileURLToPath } from 'node:url';

/** Absolute path to a bundled sample PDF (hermetic — copied into this package). */
export function fixturePath(name: FixtureName): string {
  return fileURLToPath(new URL(`../pdfs/${name}.pdf`, import.meta.url));
}

export type FixtureName = 'invoice' | 'catalog' | 'report' | 'certified';

export const FIXTURES: FixtureName[] = ['invoice', 'catalog', 'report', 'certified'];

/**
 * Absolute path to a bundled structural snapshot. These are real FormePDF
 * dogfood output rather than hand-built nodes: the `invoice-baseline` →
 * `invoice-grown` pair is the 5-row → 19-row line-item change that produces 123
 * semantic events, and it is the reference case for event grouping.
 */
export function snapshotFixturePath(name: SnapshotFixtureName): string {
  return fileURLToPath(new URL(`../snapshots/${name}.snapshot.json`, import.meta.url));
}

export type SnapshotFixtureName = 'invoice-baseline' | 'invoice-grown';
