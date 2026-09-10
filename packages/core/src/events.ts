import type { BBox, NodeRole } from './types.js';

export type SemanticEventType =
  | 'page-count-changed'
  | 'element-moved-to-different-page'
  | 'table-moved'
  | 'table-resized'
  | 'heading-hierarchy-changed'
  | 'text-overflowed-container'
  | 'element-added'
  | 'element-removed'
  | 'element-moved'
  | 'element-resized'
  | 'element-content-changed'
  | 'uncharacterized-change';

export type Severity = 'info' | 'warn' | 'error';

export interface BaseEvent {
  type: SemanticEventType;
  severity: Severity;
  /** Human-readable, used in matcher/CLI failure output. */
  message: string;
  /** Min confidence of the involved nodes (0..1). */
  confidence: number;
}

export interface PageCountChangedEvent extends BaseEvent {
  type: 'page-count-changed';
  from: number;
  to: number;
}

/**
 * Geometry every PAIRED event carries, so a consumer holding only the event
 * list (the cloud review screen drawing highlight overlays on page images) can
 * locate the change on both the baseline page and the new page without
 * re-running the matcher. `nodeId` is the new-snapshot node; `baseNodeId` is
 * its counterpart in the baseline snapshot.
 */
export interface PairedGeometry {
  baseNodeId: string;
  fromBBox: BBox;
  toBBox: BBox;
}

export interface ElementMovedEvent extends BaseEvent, PairedGeometry {
  type: 'element-moved';
  nodeId: string;
  role: NodeRole;
  textPreview: string;
  pageIndex: number;
  distancePts: number;
}

export interface ElementResizedEvent extends BaseEvent, PairedGeometry {
  type: 'element-resized';
  nodeId: string;
  role: NodeRole;
  textPreview: string;
  pageIndex: number;
  widthDelta: number;
  heightDelta: number;
}

/**
 * The text at a stable slot changed — a matched pair whose content differs. This
 * is the one thing structural diffing deliberately does NOT catch by default (a
 * cell that keeps its slot matches, so no geometry event fires — the "wrong
 * total" a spreadsheet-shaped PDF can ship silently). Opt-in via
 * `DiffOptions.contentChanges`, `warn` severity: it is a real finding, but a
 * content diff on a document that is *meant* to change its numbers every run
 * would be pure noise if it failed a suite by default.
 *
 * It stays narrow by inheritance, not by a heuristic: it fires only on pairs the
 * matcher already paired (same role, same slot), so added/removed content is
 * `element-added`/`element-removed` and never reclassified here. A growing
 * invoice's new rows do not become content edits; only its recomputed totals do.
 */
export interface ElementContentChangedEvent extends BaseEvent, PairedGeometry {
  type: 'element-content-changed';
  nodeId: string;
  role: NodeRole;
  pageIndex: number;
  fromTextPreview: string;
  toTextPreview: string;
}

export interface UncharacterizedChangeEvent extends BaseEvent {
  type: 'uncharacterized-change';
  /** Matched element pairs whose geometry differs (sub-threshold). */
  changedGeometry: number;
  /** Total matched element pairs. */
  matchedCount: number;
}

export interface ElementMovedToPageEvent extends BaseEvent, PairedGeometry {
  type: 'element-moved-to-different-page';
  nodeId: string;
  role: NodeRole;
  textPreview: string;
  fromPage: number;
  toPage: number;
}

export interface TableMovedEvent extends BaseEvent, PairedGeometry {
  type: 'table-moved';
  nodeId: string;
  fromPage: number;
  toPage: number;
  /** Origin shift in points when the move is within a page; absent for a page change. */
  distancePts?: number;
}

/**
 * A table whose origin held while its shape or box changed. Distinct from
 * 'table-moved' for the same reason 'element-resized' is distinct from
 * 'element-moved': a table that loses rows keeps its top edge while its
 * centre rises, and centre distance read that as "moved" on the first real
 * PDF through the hosted service.
 */
export interface TableResizedEvent extends BaseEvent, PairedGeometry {
  type: 'table-resized';
  nodeId: string;
  pageIndex: number;
  fromRows: number | null;
  fromCols: number | null;
  toRows: number | null;
  toCols: number | null;
  widthDelta: number;
  heightDelta: number;
}

export interface HeadingHierarchyChangedEvent extends BaseEvent, PairedGeometry {
  type: 'heading-hierarchy-changed';
  nodeId: string;
  textPreview: string;
  /** Where the heading is on each side; a consumer with only the event list needs this to find the boxes. */
  fromPage: number;
  toPage: number;
  fromLevel: number | null;
  toLevel: number | null;
}

export interface TextOverflowedEvent extends BaseEvent {
  type: 'text-overflowed-container';
  nodeId: string;
  textPreview: string;
  overflow: import('./types.js').OverflowInfo;
  pageIndex: number;
  /** Box of the overflowing node in the new snapshot. */
  bbox: BBox;
  /** The baseline pair, when the node existed before; null for a newly added node. */
  baseNodeId: string | null;
  fromBBox: BBox | null;
}

export interface ElementAddedEvent extends BaseEvent {
  type: 'element-added';
  nodeId: string;
  role: NodeRole;
  textPreview: string;
  pageIndex: number;
  bbox: BBox;
}

export interface ElementRemovedEvent extends BaseEvent {
  type: 'element-removed';
  /**
   * Id in the *baseline* snapshot — a removed node exists nowhere else. Every
   * other event's `nodeId` refers to the new run; this one cannot, so callers
   * resolving ids must pick the matching snapshot.
   */
  nodeId: string;
  role: NodeRole;
  textPreview: string;
  pageIndex: number;
  bbox: BBox;
}

export type SemanticEvent =
  | PageCountChangedEvent
  | ElementMovedToPageEvent
  | TableMovedEvent
  | TableResizedEvent
  | HeadingHierarchyChangedEvent
  | TextOverflowedEvent
  | ElementAddedEvent
  | ElementRemovedEvent
  | ElementMovedEvent
  | ElementResizedEvent
  | ElementContentChangedEvent
  | UncharacterizedChangeEvent;

/** How much work a comparison did — reported, not interpreted. */
export interface DiffStats {
  baselineNodes: number;
  newNodes: number;
  pairs: number;
  added: number;
  removed: number;
}

export interface DiffResult {
  changed: boolean;
  events: SemanticEvent[];
  baselineHash: string;
  newHash: string;
  stats: DiffStats;
}

export interface DiffOptions {
  /** Override the default severity for any event type. */
  severityOverrides?: Partial<Record<SemanticEventType, Severity>>;
  /** On-page movement beyond this many points counts as a table move. Default 24. */
  positionThresholdPts?: number;
  /** Roles to ignore entirely when diffing (e.g. ['image']). */
  ignoreRoles?: NodeRole[];
  /** Drop events whose confidence is below this (0..1). Default 0. */
  minConfidence?: number;
  /**
   * Emit `element-content-changed` for matched pairs whose text differs.
   * Off by default: structural diffing checks structure, not values, and a
   * document meant to carry different numbers each run would fail on every diff.
   * Turn it on to catch the wrong-total case. See {@link ElementContentChangedEvent}.
   */
  contentChanges?: boolean;
}

export const DEFAULT_SEVERITY: Record<SemanticEventType, Severity> = {
  'page-count-changed': 'error',
  'heading-hierarchy-changed': 'error',
  'text-overflowed-container': 'error',
  'element-moved-to-different-page': 'warn',
  'table-moved': 'warn',
  'table-resized': 'warn',
  'element-added': 'warn',
  'element-removed': 'warn',
  // Same-page movement (non-table). Tables keep their richer 'table-moved'.
  'element-moved': 'warn',
  // A size change with a stable origin. Discriminated from 'element-moved'
  // because they are different findings — "content grew" vs "layout
  // shifted" — and centerDistance alone reads half a height delta as
  // movement (a 112pt-taller container reported as "moved 56pt" on this
  // event's first CI run).
  'element-resized': 'warn',
  // A text edit at a stable slot, surfaced only when `contentChanges` is on.
  // warn, not error: it is opt-in already, and a suite that enables it on a
  // document whose numbers legitimately change should see it without a red
  // build unless the caller raises it via severityOverrides.
  'element-content-changed': 'warn',
  // The fallback channel: the content hash changed but no nameable event
  // fired. A diff that stays silent over changed content is the same
  // silent-failure shape this tool exists to expose — so the silence
  // itself becomes an event. info by default: it must be VISIBLE without
  // reclassifying tolerated jitter as failure (the matcher gates on
  // non-info); strict callers can raise it via severityOverrides.
  'uncharacterized-change': 'info',
};

export const DEFAULT_POSITION_THRESHOLD_PTS = 24;
