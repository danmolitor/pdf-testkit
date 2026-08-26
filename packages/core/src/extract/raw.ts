import type { BBox, FontInfo, NodeRole, OverflowInfo } from '../types.js';

/**
 * Intermediate extractor output, before `finalize` assigns stable ids, reading
 * order, normalized text, and the content hash. Extractors reference parents by
 * a temporary key; finalize remaps those to final ids.
 */
export interface RawNode {
  tempId: string;
  parentTempId: string | null;
  role: NodeRole;
  pageIndex: number;
  bbox: BBox;
  text: string | null;
  font: FontInfo | null;
  headingLevel: number | null;
  overflow: OverflowInfo | null;
  table?: { rows: number; cols: number };
  confidence: number;
}

export interface RawPage {
  index: number;
  width: number;
  height: number;
  contentBox: BBox;
}
