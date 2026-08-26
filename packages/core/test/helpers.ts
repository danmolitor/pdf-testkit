import type { FormeLayoutInfo, StructuralNode, StructuralSnapshot } from '@pdf-testkit/core';
import { computeContentHash, normalizeText } from '@pdf-testkit/core';

/** Build a StructuralNode with sensible defaults for diff-engine unit tests. */
export function node(partial: Partial<StructuralNode> & { id: string }): StructuralNode {
  const text = partial.text ?? null;
  return {
    role: 'text',
    pageIndex: 0,
    bbox: { x: 0, y: 0, width: 100, height: 14 },
    order: 0,
    parentId: null,
    text,
    normText: partial.normText ?? normalizeText(text),
    font: null,
    headingLevel: null,
    overflow: null,
    confidence: 1,
    ...partial,
  };
}

/** Assemble a snapshot (with a real content hash) from hand-built nodes. */
export function snapshot(
  nodes: StructuralNode[],
  opts: { pageCount?: number; producer?: 'formepdf' | 'pdfjs' } = {},
): StructuralSnapshot {
  const withoutHash = {
    version: 1 as const,
    producer: opts.producer ?? ('formepdf' as const),
    createdAt: '2026-01-01T00:00:00.000Z',
    pageCount: opts.pageCount ?? 1,
    pages: [],
    nodes,
  };
  return { ...withoutHash, contentHash: computeContentHash(withoutHash) };
}

/**
 * A representative FormePDF LayoutInfo: two headings (24pt, 18pt), body text, a
 * long line that overflows the content box, and a 2x3 table.
 */
export function sampleLayout(): FormeLayoutInfo {
  return {
    pages: [
      {
        width: 595,
        height: 842,
        contentX: 40,
        contentY: 40,
        contentWidth: 520,
        contentHeight: 762,
        elements: [
          {
            nodeType: 'Heading',
            x: 40,
            y: 40,
            width: 300,
            height: 28,
            style: { fontSize: 24, fontWeight: 700 },
            textContent: 'Quarterly Results',
          },
          {
            nodeType: 'Heading',
            x: 40,
            y: 80,
            width: 200,
            height: 20,
            style: { fontSize: 18, fontWeight: 700 },
            textContent: 'Revenue',
          },
          {
            nodeType: 'Text',
            x: 40,
            y: 110,
            width: 400,
            height: 14,
            style: { fontSize: 11 },
            textContent: 'Some ordinary body text here.',
          },
          {
            nodeType: 'Text',
            x: 50,
            y: 130,
            width: 600,
            height: 14,
            style: { fontSize: 11 },
            textContent: 'This line is far too long and spills past the content box badly.',
          },
          {
            nodeType: 'Table',
            x: 40,
            y: 160,
            width: 400,
            height: 40,
            children: [
              {
                nodeType: 'TableRow',
                x: 40,
                y: 160,
                width: 400,
                height: 20,
                children: [
                  { nodeType: 'TableCell', x: 40, y: 160, width: 133, height: 20, textContent: 'A' },
                  { nodeType: 'TableCell', x: 173, y: 160, width: 133, height: 20, textContent: 'B' },
                  { nodeType: 'TableCell', x: 306, y: 160, width: 134, height: 20, textContent: 'C' },
                ],
              },
              {
                nodeType: 'TableRow',
                x: 40,
                y: 180,
                width: 400,
                height: 20,
                children: [
                  { nodeType: 'TableCell', x: 40, y: 180, width: 133, height: 20, textContent: '1' },
                  { nodeType: 'TableCell', x: 173, y: 180, width: 133, height: 20, textContent: '2' },
                  { nodeType: 'TableCell', x: 306, y: 180, width: 134, height: 20, textContent: '3' },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
