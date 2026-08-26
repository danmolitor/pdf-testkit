import type { BBox, FontInfo, NodeRole, StructuralSnapshot } from '../types.js';
import { computeOverflow } from '../geometry.js';
import { buildHeadingLevelMap } from '../text/headingLevels.js';
import { finalize } from './finalize.js';
import type { RawNode, RawPage } from './raw.js';

/**
 * Minimal structural mirror of `@formepdf/core`'s `LayoutInfo`. Declared locally
 * so `@pdf-testkit/core` never has to depend on `@formepdf/core` — any object of
 * this shape (e.g. the result of `renderPdfWithLayout(...).layout`) works.
 *
 * Real FormePDF output (verified by dogfooding, not just the published types):
 *  - headings are `H1`..`H6` (level encoded in the tag), not a generic `Heading`
 *  - block text nodes have `textContent: undefined`; the actual text lives on
 *    nested `TextLine` children
 *  - there is no `Table` wrapper node — `TableRow`s are direct children of the
 *    page (or a container), so a table is synthesized from contiguous rows
 * This extractor also accepts the simpler documented shape (`Heading`, `Table`
 * with `textContent` set directly), so both are supported.
 */
export interface FormeLayoutInfo {
  pages: FormePageInfo[];
}

export interface FormePageInfo {
  width: number;
  height: number;
  contentX: number;
  contentY: number;
  contentWidth: number;
  contentHeight: number;
  elements: FormeElementInfo[];
}

export interface FormeElementInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  /** e.g. "H1".."H6", "Text", "TextLine", "Table", "TableRow", "TableCell", "View", "Image". */
  nodeType: string;
  style?: {
    fontSize?: number;
    fontWeight?: number;
    fontFamily?: string;
    fontStyle?: string;
  };
  children?: FormeElementInfo[];
  textContent?: string;
}

function roleFor(nodeType: string): NodeRole {
  if (/^H[1-6]$/.test(nodeType) || nodeType === 'Heading') return 'heading';
  switch (nodeType) {
    case 'Table':
      return 'table';
    case 'TableRow':
    case 'Row':
      return 'row';
    case 'TableCell':
    case 'Cell':
      return 'cell';
    case 'Text':
    case 'TextLine':
      return 'text';
    case 'Image':
      return 'image';
    default:
      return 'container';
  }
}

/** Explicit heading level from an `H1`..`H6` tag, else null (fall back to size). */
function explicitLevel(nodeType: string): number | null {
  const m = /^H([1-6])$/.exec(nodeType);
  return m ? Number(m[1]) : null;
}

/** Text-leaf roles fold their subtree into one node (text comes from TextLines). */
function isTextLeaf(role: NodeRole): boolean {
  return role === 'heading' || role === 'text' || role === 'cell';
}

/**
 * Authoritative, heuristic-free extraction from FormePDF layout metadata. Roles,
 * heading levels, and the content box are explicit, so every node is emitted at
 * confidence 1.0. This is the reliable path the whole product is validated on
 * before the fragile pdfjs path is touched.
 */
export function fromFormeLayout(
  layout: FormeLayoutInfo,
  opts?: { source?: { name?: string }; createdAt?: string; assertShape?: boolean },
): StructuralSnapshot {
  const rawPages: RawPage[] = [];
  const rawNodes: RawNode[] = [];
  let counter = 0;
  const nextId = (): string => `f${counter++}`;

  // Font sizes of headings that lack an explicit H-level, for cluster fallback.
  const headingSizes: number[] = [];
  for (const page of layout.pages) {
    walk(page.elements, (el) => {
      if (roleFor(el.nodeType) === 'heading' && explicitLevel(el.nodeType) == null && el.style?.fontSize) {
        headingSizes.push(el.style.fontSize);
      }
    });
  }
  const levelFor = buildHeadingLevelMap(headingSizes);

  layout.pages.forEach((page, pageIndex) => {
    const contentBox: BBox = {
      x: page.contentX,
      y: page.contentY,
      width: page.contentWidth,
      height: page.contentHeight,
    };
    rawPages.push({ index: pageIndex, width: page.width, height: page.height, contentBox });

    const emit = (el: FormeElementInfo, parentTempId: string | null, parentBBox: BBox | null): void => {
      const role = roleFor(el.nodeType);
      const tempId = nextId();
      const bbox: BBox = { x: el.x, y: el.y, width: el.width, height: el.height };

      let overflow = null;
      if (role === 'text' || role === 'heading') {
        overflow = computeOverflow(bbox, contentBox, 'page-content');
      } else if (role === 'cell' && parentBBox) {
        overflow = computeOverflow(bbox, parentBBox, 'parent');
      }

      const node: RawNode = {
        tempId,
        parentTempId,
        role,
        pageIndex,
        bbox,
        text: isTextLeaf(role) ? collectText(el) : null,
        font: fontFrom(el.style),
        headingLevel:
          role === 'heading' ? explicitLevel(el.nodeType) ?? levelFor(el.style?.fontSize ?? 0) : null,
        overflow,
        confidence: 1,
      };
      if (role === 'table') node.table = tableShape(el.children ?? []);
      rawNodes.push(node);

      // Text leaves fold their subtree (text already collected). Tables mark
      // their children as already-in-a-table so rows aren't re-synthesized.
      if (!isTextLeaf(role)) {
        processChildren(el.children ?? [], tempId, bbox, role === 'table');
      }
    };

    // Iterate a sibling list, synthesizing a table node around any run of
    // contiguous TableRows that aren't already inside a Table.
    const processChildren = (
      children: FormeElementInfo[],
      parentTempId: string | null,
      parentBBox: BBox | null,
      parentIsTable: boolean,
    ): void => {
      let i = 0;
      while (i < children.length) {
        const el = children[i] as FormeElementInfo;
        if (roleFor(el.nodeType) === 'row' && !parentIsTable) {
          const run: FormeElementInfo[] = [];
          let j = i;
          while (j < children.length && roleFor((children[j] as FormeElementInfo).nodeType) === 'row') {
            run.push(children[j] as FormeElementInfo);
            j++;
          }
          const tableTempId = nextId();
          const bbox = unionBBox(run);
          rawNodes.push({
            tempId: tableTempId,
            parentTempId,
            role: 'table',
            pageIndex,
            bbox,
            text: null,
            font: null,
            headingLevel: null,
            overflow: null,
            table: tableShape(run),
            confidence: 1,
          });
          for (const row of run) emit(row, tableTempId, bbox);
          i = j;
          continue;
        }
        emit(el, parentTempId, parentBBox);
        i++;
      }
    };

    processChildren(page.elements, null, null, false);
  });

  const snapshot = finalize('formepdf', rawPages, rawNodes, opts);
  if (opts?.assertShape !== false) assertShapeRecognized(layout, snapshot);
  return snapshot;
}

/** Thrown when FormePDF's layout shape no longer matches what this extractor
 * understands — a broken contract on the authoritative fast path, which must
 * fail loudly rather than silently produce a wrong diff. */
export class FormeShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormeShapeError';
  }
}

/**
 * Guard against silent misclassification when FormePDF's runtime layout shape
 * drifts (as it has before: `H1`..`H6`, `TextLine`, and the missing `Table`
 * wrapper were all undocumented). Rather than allow-listing every nodeType
 * (FormePDF emits many, and the set isn't fully documented — a strict list would
 * false-throw on the next benign addition), assert the invariants this extractor
 * depends on. Verified against @formepdf/core 0.12.0 runtime output (2026-08).
 */
function assertShapeRecognized(layout: FormeLayoutInfo, snapshot: StructuralSnapshot): void {
  const fragments: string[] = [];
  const nodeTypesSeen = new Set<string>();
  let hasRow = false;
  let hasCell = false;
  let hasHeading = false;
  for (const page of layout.pages) {
    walk(page.elements, (el) => {
      nodeTypesSeen.add(el.nodeType);
      if (el.nodeType === 'TableRow' || el.nodeType === 'Row') hasRow = true;
      if (el.nodeType === 'TableCell' || el.nodeType === 'Cell') hasCell = true;
      if (/^H[1-6]$/.test(el.nodeType) || el.nodeType === 'Heading') hasHeading = true;
      if (typeof el.textContent === 'string') {
        const t = el.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
        if (t) fragments.push(t);
      }
    });
  }
  const context = `Seen FormePDF nodeTypes: [${[...nodeTypesSeen].sort().join(', ')}].`;

  // 1. Every text fragment in the layout must be captured somewhere. Aggregate
  //    (not per-node) so legitimately empty cells/blocks never false-trip.
  if (fragments.length > 0) {
    const haystack = snapshot.nodes.map((n) => n.normText ?? '').join('');
    const missing = fragments.filter((f) => !haystack.includes(f));
    if (missing.length > 0) {
      throw new FormeShapeError(
        `fromFormeLayout dropped ${missing.length}/${fragments.length} text fragment(s) from the ` +
          `FormePDF layout (e.g. ${JSON.stringify(missing.slice(0, 3))}). The layout node shape has ` +
          `likely changed; the nodeType→role mapping needs updating. ${context}`,
      );
    }
  }

  // 2. Text/table carriers present in the layout must produce their roles.
  const produced = new Set(snapshot.nodes.map((n) => n.role));
  if (hasRow && !produced.has('row')) {
    throw new FormeShapeError(`Layout has TableRow nodes but none were extracted as rows. ${context}`);
  }
  if (hasCell && !produced.has('cell')) {
    throw new FormeShapeError(`Layout has TableCell nodes but none were extracted as cells. ${context}`);
  }
  if (hasHeading && !produced.has('heading')) {
    throw new FormeShapeError(`Layout has H1–H6/Heading nodes but none were extracted as headings. ${context}`);
  }

  // 3. Table synthesis sanity: a table with zero rows is malformed.
  for (const node of snapshot.nodes) {
    if (node.role === 'table' && node.table && node.table.rows === 0) {
      throw new FormeShapeError(`Synthesized a table with zero rows — row grouping is broken. ${context}`);
    }
  }
}

/** Gather text from a node's subtree (TextLine carries it), collapsing space. */
function collectText(el: FormeElementInfo): string | null {
  const parts: string[] = [];
  const rec = (n: FormeElementInfo): void => {
    if (typeof n.textContent === 'string' && n.textContent.length) parts.push(n.textContent);
    for (const c of n.children ?? []) rec(c);
  };
  rec(el);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length ? text : null;
}

function fontFrom(style: FormeElementInfo['style']): FontInfo | null {
  if (!style) return null;
  if (style.fontSize == null && style.fontWeight == null && style.fontFamily == null) return null;
  return {
    size: style.fontSize ?? null,
    weight: style.fontWeight ?? null,
    family: style.fontFamily ?? null,
    italic: style.fontStyle ? /italic|oblique/i.test(style.fontStyle) : undefined,
  };
}

/** rows = number of row children; cols = max cells across those rows. */
function tableShape(rows: FormeElementInfo[]): { rows: number; cols: number } {
  const rowEls = rows.filter((c) => roleFor(c.nodeType) === 'row');
  let cols = 0;
  for (const row of rowEls) {
    const cells = (row.children ?? []).filter((c) => roleFor(c.nodeType) === 'cell').length;
    cols = Math.max(cols, cells);
  }
  return { rows: rowEls.length, cols };
}

function unionBBox(els: FormeElementInfo[]): BBox {
  const minX = Math.min(...els.map((e) => e.x));
  const maxX = Math.max(...els.map((e) => e.x + e.width));
  const minY = Math.min(...els.map((e) => e.y));
  const maxY = Math.max(...els.map((e) => e.y + e.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function walk(elements: FormeElementInfo[], fn: (el: FormeElementInfo) => void): void {
  for (const el of elements) {
    fn(el);
    if (el.children?.length) walk(el.children, fn);
  }
}
