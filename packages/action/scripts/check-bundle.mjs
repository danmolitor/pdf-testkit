// Properties the committed Action bundle must have. ncc will happily follow a
// dynamic import into a native module and pack this machine's binary into
// dist, which loads here and fails only on a Linux runner. Assert the
// artifact rather than trusting the build.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const LIMITS = { minBytes: 400_000, maxBytes: 1_500_000 };

export function checkBundle(dir) {
  const problems = [];
  const files = readdirSync(dir);
  for (const f of files) {
    if (f.endsWith('.node')) problems.push(`native binary in bundle: ${f} (platform-specific; the Action must not need one)`);
    if (/^\d+\.index\.js$/.test(f)) problems.push(`split chunk in bundle: ${f} (ncc externalised something lazily; mark it -e)`);
  }
  if (!files.includes('index.js')) {
    problems.push('dist/index.js missing');
    return problems;
  }
  const size = statSync(join(dir, 'index.js')).size;
  if (size < LIMITS.minBytes) problems.push(`index.js is ${size} bytes; below ${LIMITS.minBytes}, the core engine is probably not bundled`);
  if (size > LIMITS.maxBytes) problems.push(`index.js is ${size} bytes; above ${LIMITS.maxBytes}, something large was pulled in`);
  const src = readFileSync(join(dir, 'index.js'), 'utf8');
  if (/\.node["']/.test(src) || /skia\./.test(src)) problems.push('index.js references a native .node module');
  return problems;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const dir = process.argv[2] ?? new URL('../dist', import.meta.url).pathname;
  const problems = checkBundle(dir);
  for (const p of problems) console.error(`check-bundle: ${p}`);
  process.exit(problems.length ? 1 : 0);
}
