import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain module shared with the bundle script
import { checkBundle, LIMITS } from '../scripts/check-bundle.mjs';

const dist = new URL('../dist', import.meta.url).pathname;

/**
 * The committed bundle is what every workflow runs. ncc once followed core's
 * dynamic import of @napi-rs/canvas and packed a 25 MB darwin binary into
 * dist: fine on the laptop that built it, dead on ubuntu-latest, and only
 * for people who had already installed the Action.
 */
describe('the committed Action bundle', () => {
  it('has no native binaries, no split chunks, and a plausible size', () => {
    expect(checkBundle(dist)).toEqual([]);
  });

  it('the check catches the darwin-binary bundle it was written for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    writeFileSync(join(dir, 'index.js'), 'x'.repeat(LIMITS.minBytes) + '__webpack_require__.ab + "skia.darwin-arm64.node"');
    writeFileSync(join(dir, '987.index.js'), '');
    writeFileSync(join(dir, 'skia.darwin-arm64.node'), '');
    const problems = checkBundle(dir);
    expect(problems.some((p: string) => p.includes('native binary'))).toBe(true);
    expect(problems.some((p: string) => p.includes('split chunk'))).toBe(true);
    expect(problems.some((p: string) => p.includes('references a native'))).toBe(true);
  });

  it('a bundle without the engine is as wrong as one with a binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    writeFileSync(join(dir, 'index.js'), 'console.log(1)');
    expect(checkBundle(dir).join()).toMatch(/below/);
  });
});
