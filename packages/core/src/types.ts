/**
 * The normalized structural model that every extractor produces and the diff
 * engine + matcher consume. This is the architectural crux of pdf-testkit: a
 * flat, producer-agnostic, coordinate-normalized representation of a document's
 * structure (NOT its pixels).
 */

export type SnapshotSchemaVersion = 1;

export type Producer = 'formepdf' | 'pdfjs';

export type NodeRole =
  | 'text' // generic text run / paragraph
  | 'heading' // headingLevel is set
  | 'table' // a detected/declared table region (container)
  | 'row' // table row
  | 'cell' // table cell
  | 'image' // image/graphic region (recorded, not deeply diffed in v0.1)
  | 'container'; // generic view/group (e.g. a FormePDF View)

/** Axis-aligned bounding box. Top-left origin, points, rounded to 0.1pt. */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FontInfo {
  /** Point size, rounded to 0.1. `null` when unknown. */
  size: number | null;
  /** 100..900. pdfjs infers 700 from a bold-ish font name, else 400. */
  weight: number | null;
  /** May be a subset name from pdfjs (e.g. "ABCDEE+Helvetica"). */
  family: string | null;
  italic?: boolean;
}

export interface OverflowInfo {
  axis: 'x' | 'y' | 'both';
  /** How far past the container box, in points, rounded to 0.1 (max axis). */
  overflowPts: number;
  container: 'page-content' | 'parent';
}

export interface StructuralNode {
  /** Stable within a snapshot: `${pageIndex}:${role}:${ordinal}`. */
  id: string;
  role: NodeRole;
  /** 0-based page index. */
  pageIndex: number;
  bbox: BBox;
  /** Reading order within the page (top-to-bottom by y-band, then left-to-right). */
  order: number;
  /** For nesting: cell -> row -> table. `null` at the top level. */
  parentId: string | null;
  /** Raw concatenated text; `null` for containers/images. */
  text: string | null;
  /** Normalized text (trimmed, whitespace-collapsed, lowercased); `null` if empty. */
  normText: string | null;
  font: FontInfo | null;
  /** 1..6 when role === 'heading', else null. */
  headingLevel: number | null;
  /** Set when this node's bbox exceeds its container. */
  overflow: OverflowInfo | null;
  /** Summary for table nodes so table diffs don't require walking children. */
  table?: { rows: number; cols: number };
  /** 0..1 — 1.0 for authoritative (FormePDF) roles, <1 for pdfjs-inferred. */
  confidence: number;
}

export interface PageSnapshot {
  index: number;
  width: number;
  height: number;
  /** FormePDF: the real content box. pdfjs: an inferred margin box. */
  contentBox: BBox;
  /** Ids of nodes on this page, in reading order. */
  nodeIds: string[];
}

export interface StructuralSnapshot {
  version: SnapshotSchemaVersion;
  producer: Producer;
  /** ISO timestamp; excluded from the diff and from `contentHash`. */
  createdAt: string;
  /** Reporting-only provenance (e.g. original filename). */
  source?: { name?: string };
  pageCount: number;
  pages: PageSnapshot[];
  /** All nodes, all pages, flat. */
  nodes: StructuralNode[];
  /** `sha256:...` over the canonical serialization, excluding createdAt. */
  contentHash: string;
}
