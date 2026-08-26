import { createHash } from 'node:crypto';
import type { StructuralSnapshot } from '../types.js';

/** Deterministic JSON with recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Content hash over everything that describes the document structure, excluding
 * volatile/derived fields (`createdAt`, `contentHash` itself, and reporting-only
 * `source`). Identical structure -> identical hash, which lets the matcher and
 * CLI short-circuit to "no change".
 */
export function computeContentHash(
  snapshot: Omit<StructuralSnapshot, 'contentHash'> & { contentHash?: string },
): string {
  const { createdAt: _createdAt, source: _source, contentHash: _hash, ...rest } = snapshot;
  return 'sha256:' + createHash('sha256').update(stableStringify(rest)).digest('hex');
}

export function serializeSnapshot(snapshot: StructuralSnapshot, pretty = true): string {
  return JSON.stringify(snapshot, null, pretty ? 2 : undefined);
}
