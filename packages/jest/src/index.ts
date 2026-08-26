import { expect } from 'expect';
import { assertMatchesPDFSnapshot, type PdfSnapshotOptions } from '@pdf-testkit/matcher-core';

/**
 * Jest adapter. Gathers test context from the matcher `this` (Jest passes
 * `testPath`, `currentTestName`, and `snapshotState`) — the only meaningful
 * difference from the Vitest adapter — and delegates to shared matcher-core.
 */
expect.extend({
  async toMatchPDFSnapshot(received: unknown, options: PdfSnapshotOptions = {}) {
    const state = this as unknown as {
      testPath?: string;
      currentTestName?: string;
      snapshotState?: { _updateSnapshot?: string };
    };
    const outcome = await assertMatchesPDFSnapshot(received as never, {
      testPath: state.testPath ?? '',
      currentTestName: state.currentTestName ?? 'snapshot',
      snapshotName: options.snapshotName,
      updateMode: state.snapshotState?._updateSnapshot === 'all',
    }, options);
    return { pass: outcome.pass, message: outcome.message };
  },
});

interface PdfMatchers<R = void> {
  toMatchPDFSnapshot(options?: PdfSnapshotOptions): Promise<R>;
}

declare module 'expect' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Matchers<R extends void | Promise<void>> extends PdfMatchers<R> {}
}

export type { PdfSnapshotOptions };
