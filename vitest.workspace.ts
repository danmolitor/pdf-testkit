import { defineWorkspace } from 'vitest/config';

// Each package's tests run under the same root config. Vitest resolves
// workspace package imports (e.g. @pdf-testkit/core) via tsconfig paths /
// node_modules symlinks created by `npm install`.
export default defineWorkspace([
  'packages/core',
  'packages/matcher-core',
  'packages/cli',
  'packages/vitest',
  'packages/action',
]);
