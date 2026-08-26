import type { DiffOptions, FormeLayoutInfo, StructuralSnapshot } from '@pdf-testkit/core';

/** Anything the matcher can accept and normalize into a structural snapshot. */
export type MatcherInput =
  | Uint8Array
  | ArrayBuffer
  | FormeLayoutInfo
  | StructuralSnapshot
  | { path: string };

/** Per-invocation context the framework adapter supplies. */
export interface MatcherContext {
  /** Absolute path of the test file (baselines are resolved next to it). */
  testPath: string;
  currentTestName: string;
  /** Explicit snapshot name, when the caller passed one. */
  snapshotName?: string;
  /** True when the framework was run in update mode (-u / --update). */
  updateMode: boolean;
}

export interface PdfSnapshotOptions extends DiffOptions {
  /** Override the baseline directory (default: `<testDir>/__pdf_snapshots__`). */
  snapshotDir?: string;
  /** Override the snapshot name (default: the test name). */
  snapshotName?: string;
}

export interface MatcherOutcome {
  pass: boolean;
  message: () => string;
}
