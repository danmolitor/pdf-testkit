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
  DiffStats,
  PairedGeometry,
  ElementMovedEvent,
  ElementResizedEvent,
  UncharacterizedChangeEvent,
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
export {
  fromFormeLayout,
  FormeShapeError,
  FORME_ROLE_BY_NODE_TYPE,
  FORME_INTENTIONALLY_UNMAPPED,
} from './extract/fromFormeLayout.js';
export type {
  FormeLayoutInfo,
  FormePageInfo,
  FormeElementInfo,
} from './extract/fromFormeLayout.js';
export { fromPdf } from './extract/fromPdf.js';

// Page images (customer CI only — the service never renders)
export { renderPages } from './render/pages.js';
export type { RenderPagesOptions, RenderedPage, RenderedPages } from './render/pages.js';

// Diff engine
export { diffSnapshots } from './diff/diff.js';
export { matchNodes } from './diff/match.js';
export type { MatchResult, NodePair } from './diff/match.js';

// Causal grouping — a *view* over the event list for human-facing output.
// Never changes DiffResult, the JSON output, or the fail gate.
export { groupEvents } from './diff/group.js';
export type { EventGroup, GroupKind } from './diff/group.js';

// Snapshot IO + helpers
export { readSnapshotFile, writeSnapshotFile } from './snapshot/io.js';
export { loadSnapshotFromFile } from './snapshot/load.js';
export { serializeSnapshot, computeContentHash, stableStringify } from './snapshot/serialize.js';
export { normalizeText, textPreview, textSimilarity } from './text/normalize.js';
