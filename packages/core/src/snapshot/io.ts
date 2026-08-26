import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StructuralSnapshot } from '../types.js';
import { serializeSnapshot } from './serialize.js';

export async function readSnapshotFile(path: string): Promise<StructuralSnapshot> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as StructuralSnapshot;
}

export async function writeSnapshotFile(
  path: string,
  snapshot: StructuralSnapshot,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeSnapshot(snapshot) + '\n', 'utf8');
}
