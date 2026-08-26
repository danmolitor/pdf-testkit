import { describe, it, expect } from 'vitest';
import { computeContentHash, serializeSnapshot, fromFormeLayout } from '@pdf-testkit/core';
import { sampleLayout } from './helpers';

describe('canonical serialization + content hash', () => {
  it('is stable across re-serialization and key ordering', () => {
    const snap = fromFormeLayout(sampleLayout());
    const again = JSON.parse(serializeSnapshot(snap));
    // Recomputing over a round-tripped object yields the same hash.
    expect(computeContentHash(again)).toBe(snap.contentHash);
  });

  it('excludes createdAt from the hash', () => {
    const a = fromFormeLayout(sampleLayout(), { createdAt: '2020-01-01T00:00:00.000Z' });
    const b = fromFormeLayout(sampleLayout(), { createdAt: '2099-12-31T23:59:59.000Z' });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.createdAt).not.toBe(b.createdAt);
  });

  it('changes the hash when structure changes', () => {
    const a = fromFormeLayout(sampleLayout());
    const mutated = sampleLayout();
    mutated.pages[0]!.elements[0]!.textContent = 'Different heading';
    const b = fromFormeLayout(mutated);
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});
