import type { BBox, NodeRole } from './types.js';

export type SemanticEventType =
  | 'page-count-changed'
  | 'element-moved-to-different-page'
  | 'table-moved'
  | 'heading-hierarchy-changed'
  | 'text-overflowed-container'
  | 'element-added'
  | 'element-removed';

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

export interface ElementMovedToPageEvent extends BaseEvent {
  type: 'element-moved-to-different-page';
  nodeId: string;
  role: NodeRole;
  textPreview: string;
  fromPage: number;
  toPage: number;
}

export interface TableMovedEvent extends BaseEvent {
  type: 'table-moved';
  nodeId: string;
  fromPage: number;
  toPage: number;
  fromBBox: BBox;
  toBBox: BBox;
}

export interface HeadingHierarchyChangedEvent extends BaseEvent {
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
}

export interface ElementAddedEvent extends BaseEvent {
  type: 'element-added';
  nodeId: string;
  role: NodeRole;
  textPreview: string;
  pageIndex: number;
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
}

export type SemanticEvent =
  | PageCountChangedEvent
  | ElementMovedToPageEvent
  | TableMovedEvent
  | HeadingHierarchyChangedEvent
  | TextOverflowedEvent
  | ElementAddedEvent
  | ElementRemovedEvent;

export interface DiffResult {
  changed: boolean;
  events: SemanticEvent[];
  baselineHash: string;
  newHash: string;
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
};

export const DEFAULT_POSITION_THRESHOLD_PTS = 24;
