/** Public API for @pdf-testkit/core. */

// Model
export type {
  BBox,
  FontInfo,
  NodeRole,
  OverflowInfo,
  PageSnapshot,
  Producer,
  SnapshotSchemaVersion,
  StructuralNode,
  StructuralSnapshot,
} from './types.js';

// Events + diff options
export type {
  BaseEvent,
  DiffOptions,
  DiffResult,
  ElementAddedEvent,
  ElementMovedToPageEvent,
  ElementRemovedEvent,
  HeadingHierarchyChangedEvent,
  PageCountChangedEvent,
  SemanticEvent,
  SemanticEventType,
  Severity,
  TableMovedEvent,
  TextOverflowedEvent,
} from './events.js';
export { DEFAULT_SEVERITY, DEFAULT_POSITION_THRESHOLD_PTS } from './events.js';

// Extractors
export { fromFormeLayout, FormeShapeError } from './extract/fromFormeLayout.js';
export type {
  FormeLayoutInfo,
  FormePageInfo,
  FormeElementInfo,
} from './extract/fromFormeLayout.js';
export { fromPdf } from './extract/fromPdf.js';

// Diff engine
export { diffSnapshots } from './diff/diff.js';
export { matchNodes } from './diff/match.js';
export type { MatchResult, NodePair } from './diff/match.js';

// Snapshot IO + helpers
export { readSnapshotFile, writeSnapshotFile } from './snapshot/io.js';
export { loadSnapshotFromFile } from './snapshot/load.js';
export { serializeSnapshot, computeContentHash, stableStringify } from './snapshot/serialize.js';
export { normalizeText, textPreview, textSimilarity } from './text/normalize.js';
