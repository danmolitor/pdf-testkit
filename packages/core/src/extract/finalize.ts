import type { Producer, PageSnapshot, StructuralNode, StructuralSnapshot } from '../types.js';
import { median, round1, roundBBox } from '../geometry.js';
import { normalizeText } from '../text/normalize.js';
import { computeContentHash } from '../snapshot/serialize.js';
import type { RawNode, RawPage } from './raw.js';

/**
 * Shared post-processing that turns raw extractor output into a canonical
 * `StructuralSnapshot`: assigns reading order, stable ids, normalized text,
 * rounds all coordinates, links parents, and computes the content hash. Both
 * `fromFormeLayout` and `fromPdf` converge here so downstream code is identical
 * regardless of producer.
 */
export function finalize(
  producer: Producer,
  rawPages: RawPage[],
  rawNodes: RawNode[],
  opts?: { source?: { name?: string }; createdAt?: string },
): StructuralSnapshot {
  const pages = [...rawPages].sort((a, b) => a.index - b.index);

  // Reading order + a per-page ordinal counter keyed by role, computed on nodes
  // sorted by y-band then x. y-band tolerance derives from the page's median
  // line height so items on the same visual line share a band.
  const finalIdByTemp = new Map<string, string>();
  const ordered: RawNode[] = [];
  const orderByTemp = new Map<string, number>();
  const nodeIdsByPage = new Map<number, string[]>();

  for (const page of pages) {
    const pageNodes = rawNodes.filter((n) => n.pageIndex === page.index);
    const rowTol = readingRowTolerance(pageNodes);
    const band = (y: number): number => Math.round(y / rowTol);
    pageNodes.sort((a, b) => band(a.bbox.y) - band(b.bbox.y) || a.bbox.x - b.bbox.x);

    const ordinalByRole = new Map<string, number>();
    const ids: string[] = [];
    pageNodes.forEach((node, i) => {
      const ordinal = ordinalByRole.get(node.role) ?? 0;
      ordinalByRole.set(node.role, ordinal + 1);
      const id = `${page.index}:${node.role}:${ordinal}`;
      finalIdByTemp.set(node.tempId, id);
      orderByTemp.set(node.tempId, i);
      ids.push(id);
      ordered.push(node);
    });
    nodeIdsByPage.set(page.index, ids);
  }

  const nodes: StructuralNode[] = ordered.map((raw) => {
    const id = finalIdByTemp.get(raw.tempId) as string;
    const parentId =
      raw.parentTempId != null ? finalIdByTemp.get(raw.parentTempId) ?? null : null;
    const node: StructuralNode = {
      id,
      role: raw.role,
      pageIndex: raw.pageIndex,
      bbox: roundBBox(raw.bbox),
      order: orderByTemp.get(raw.tempId) ?? 0,
      parentId,
      text: raw.text,
      normText: normalizeText(raw.text),
      font: raw.font
        ? { ...raw.font, size: raw.font.size == null ? null : round1(raw.font.size) }
        : null,
      headingLevel: raw.headingLevel,
      overflow: raw.overflow,
      confidence: raw.confidence,
    };
    if (raw.table) node.table = raw.table;
    return node;
  });

  const pageSnapshots: PageSnapshot[] = pages.map((p) => ({
    index: p.index,
    width: round1(p.width),
    height: round1(p.height),
    contentBox: roundBBox(p.contentBox),
    nodeIds: nodeIdsByPage.get(p.index) ?? [],
  }));

  const withoutHash: Omit<StructuralSnapshot, 'contentHash'> = {
    version: 1,
    producer,
    createdAt: opts?.createdAt ?? new Date().toISOString(),
    ...(opts?.source ? { source: opts.source } : {}),
    pageCount: pageSnapshots.length,
    pages: pageSnapshots,
    nodes,
  };

  return { ...withoutHash, contentHash: computeContentHash(withoutHash) };
}

function readingRowTolerance(nodes: RawNode[]): number {
  const heights = nodes
    .filter((n) => n.role === 'text' || n.role === 'heading' || n.role === 'cell')
    .map((n) => n.font?.size ?? n.bbox.height)
    .filter((h) => h > 0);
  if (heights.length === 0) return 6;
  return Math.max(2, 0.5 * median(heights));
}
