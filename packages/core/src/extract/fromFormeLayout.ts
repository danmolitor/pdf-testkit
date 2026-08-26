import type { FontInfo, NodeRole, StructuralSnapshot } from '../types.js';
import { computeOverflow } from '../geometry.js';
import { buildHeadingLevelMap } from '../text/headingLevels.js';
import { finalize } from './finalize.js';
import type { RawNode, RawPage } from './raw.js';

/**
 * Minimal structural mirror of `@formepdf/core`'s `LayoutInfo`. Declared locally
 * so `@pdf-testkit/core` never has to depend on `@formepdf/core` — any object of
 * this shape (e.g. the result of `renderPdfWithLayout(...).layout`) works.
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
  /** Semantic type: "Text" | "Heading" | "Table" | "TableRow" | "TableCell" | "View" | "Image" | ... */
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

const ROLE_BY_NODE_TYPE: Record<string, NodeRole> = {
  Heading: 'heading',
  Table: 'table',
  TableRow: 'row',
  TableCell: 'cell',
  Text: 'text',
  Image: 'image',
  View: 'container',
};

function roleFor(nodeType: string): NodeRole {
  return ROLE_BY_NODE_TYPE[nodeType] ?? 'container';
}

/**
 * Authoritative, heuristic-free extraction from FormePDF layout metadata. Roles,
 * headings, tables, and the content box are all explicit, so every node is
 * emitted at confidence 1.0. This is the reliable path the whole product is
 * validated on before the fragile pdfjs path is touched.
 */
export function fromFormeLayout(
  layout: FormeLayoutInfo,
  opts?: { source?: { name?: string }; createdAt?: string },
): StructuralSnapshot {
  const rawPages: RawPage[] = [];
  const rawNodes: RawNode[] = [];
  let counter = 0;
  const nextId = (): string => `f${counter++}`;

  // First pass: collect heading font sizes across the whole document so levels
  // are assigned consistently (largest -> H1), matching pdfjs behavior.
  const headingSizes: number[] = [];
  for (const page of layout.pages) {
    walk(page.elements, (el) => {
      if (roleFor(el.nodeType) === 'heading' && el.style?.fontSize) {
        headingSizes.push(el.style.fontSize);
      }
    });
  }
  const levelFor = buildHeadingLevelMap(headingSizes);

  layout.pages.forEach((page, pageIndex) => {
    const contentBox = {
      x: page.contentX,
      y: page.contentY,
      width: page.contentWidth,
      height: page.contentHeight,
    };
    rawPages.push({ index: pageIndex, width: page.width, height: page.height, contentBox });

    const visit = (
      el: FormeElementInfo,
      parentTempId: string | null,
      parentBBox: { x: number; y: number; width: number; height: number } | null,
    ): void => {
      const role = roleFor(el.nodeType);
      const tempId = nextId();
      const bbox = { x: el.x, y: el.y, width: el.width, height: el.height };
      const font = fontFrom(el.style);

      // Overflow: leaf text/heading vs the page content box; cells vs their
      // parent box (a cell overflowing a fixed-width column).
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
        text: el.textContent ?? null,
        font,
        headingLevel: role === 'heading' ? levelFor(el.style?.fontSize ?? 0) : null,
        overflow,
        confidence: 1,
      };

      if (role === 'table') {
        node.table = tableShape(el);
      }
      rawNodes.push(node);

      for (const child of el.children ?? []) {
        visit(child, tempId, bbox);
      }
    };

    for (const el of page.elements) visit(el, null, null);
  });

  return finalize('formepdf', rawPages, rawNodes, opts);
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

/** rows = number of TableRow children; cols = max cells across those rows. */
function tableShape(table: FormeElementInfo): { rows: number; cols: number } {
  const rows = (table.children ?? []).filter((c) => roleFor(c.nodeType) === 'row');
  let cols = 0;
  for (const row of rows) {
    const cells = (row.children ?? []).filter((c) => roleFor(c.nodeType) === 'cell').length;
    cols = Math.max(cols, cells);
  }
  return { rows: rows.length, cols };
}

function walk(elements: FormeElementInfo[], fn: (el: FormeElementInfo) => void): void {
  for (const el of elements) {
    fn(el);
    if (el.children?.length) walk(el.children, fn);
  }
}
