import { expect } from 'vitest';
import { assertMatchesPDFSnapshot, type PdfSnapshotOptions } from '@pdf-testkit/matcher-core';

/**
 * Vitest adapter. Gathers test context from `expect.getState()` (this is the
 * only meaningful difference from the Jest adapter) and delegates to the shared
 * matcher-core implementation.
 */
expect.extend({
  async toMatchPDFSnapshot(received: unknown, options: PdfSnapshotOptions = {}) {
    const state = expect.getState();
    const snapshotState = (state as unknown as { snapshotState?: { _updateSnapshot?: string } })
      .snapshotState;
    const outcome = await assertMatchesPDFSnapshot(received as never, {
      testPath: state.testPath ?? '',
      currentTestName: state.currentTestName ?? 'snapshot',
      snapshotName: options.snapshotName,
      updateMode: snapshotState?._updateSnapshot === 'all',
    }, options);
    return { pass: outcome.pass, message: outcome.message };
  },
});

interface PdfMatchers<R = unknown> {
  toMatchPDFSnapshot(options?: PdfSnapshotOptions): Promise<R>;
}

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars
  interface Assertion<T = any> extends PdfMatchers<T> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends PdfMatchers {}
}

export type { PdfSnapshotOptions };
