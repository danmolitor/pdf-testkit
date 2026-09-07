// Properties the committed Action bundle must have. ncc will happily follow a
// dynamic import into a native module and pack this machine's binary into
// dist, which loads here and fails only on a Linux runner. Assert the
// artifact rather than trusting the build.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  // A static import of anything but a Node builtin fails at load time on a
  // runner, whether or not the code path that needs it ever runs. Dynamic
  // import() is fine: it resolves only when called.
  for (const m of src.matchAll(/(?:^|[;{}\s])import(?:\s|\{|\*)[^;]{0,200}?from\s*["']([^"']+)["']/g)) {
    const spec = m[1];
    if (!spec.startsWith('node:') && !BUILTINS.has(spec)) problems.push(`index.js statically imports "${spec}", which a runner will not have`);
  }
  return problems;
}

const BUILTINS = new Set(['module', 'fs', 'path', 'os', 'url', 'util', 'child_process', 'crypto', 'events', 'stream', 'http', 'https', 'zlib', 'buffer', 'assert', 'tty', 'net', 'worker_threads', 'perf_hooks', 'process']);

/**
 * Run the bundle from a directory with no node_modules anywhere above it, the
 * way a runner does. Resolution from the monorepo hid a missing package once.
 * Success is the Action failing on its inputs, not on a module.
 */
export function smokeRun(dir) {
  const iso = mkdtempSync(join(tmpdir(), 'action-smoke-'));
  copyFileSync(join(dir, 'index.js'), join(iso, 'index.js'));
  const r = spawnSync(process.execPath, [join(iso, 'index.js')], { cwd: iso, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '/dev/null' } });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  if (/ERR_MODULE_NOT_FOUND|Cannot find (package|module)/.test(out)) return [`bundle fails to load in isolation: ${out.split('\n').find((l) => /Cannot find/.test(l))}`];
  if (!/Input required/.test(out)) return [`bundle did not reach input validation in isolation; output was: ${out.slice(0, 300)}`];
  return [];
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const dir = process.argv[2] ?? new URL('../dist', import.meta.url).pathname;
  const problems = [...checkBundle(dir), ...smokeRun(dir)];
  for (const p of problems) console.error(`check-bundle: ${p}`);
  process.exit(problems.length ? 1 : 0);
}
