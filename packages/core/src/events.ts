import type { BBox, NodeRole } from './types.js';

export type SemanticEventType =
  | 'page-count-changed'
  | 'element-moved-to-different-page'
  | 'table-moved'
  | 'heading-hierarchy-changed'
  | 'text-overflowed-container'
  | 'element-added'
  | 'element-removed'
  | 'element-moved'
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
}

export interface HeadingHierarchyChangedEvent extends BaseEvent, PairedGeometry {
  type: 'heading-hierarchy-changed';
  nodeId: string;
  textPreview: string;
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
  | HeadingHierarchyChangedEvent
  | TextOverflowedEvent
  | ElementAddedEvent
  | ElementRemovedEvent
  | ElementMovedEvent
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
}

export const DEFAULT_SEVERITY: Record<SemanticEventType, Severity> = {
  'page-count-changed': 'error',
  'heading-hierarchy-changed': 'error',
  'text-overflowed-container': 'error',
  'element-moved-to-different-page': 'warn',
  'table-moved': 'warn',
  'element-added': 'warn',
  'element-removed': 'warn',
  // Same-page movement (non-table). Tables keep their richer 'table-moved'.
  'element-moved': 'warn',
  // The fallback channel: the content hash changed but no nameable event
  // fired. A diff that stays silent over changed content is the same
  // silent-failure shape this tool exists to expose — so the silence
  // itself becomes an event. info by default: it must be VISIBLE without
  // reclassifying tolerated jitter as failure (the matcher gates on
  // non-info); strict callers can raise it via severityOverrides.
  'uncharacterized-change': 'info',
};

export const DEFAULT_POSITION_THRESHOLD_PTS = 24;
