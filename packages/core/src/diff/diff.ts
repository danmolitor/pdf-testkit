import type { DiffOptions, DiffResult, SemanticEvent, SemanticEventType, Severity } from '../events.js';
import { DEFAULT_POSITION_THRESHOLD_PTS, DEFAULT_SEVERITY } from '../events.js';
import type { NodeRole, StructuralNode, StructuralSnapshot } from '../types.js';
import { centerDistance } from '../geometry.js';
import { textPreview } from '../text/normalize.js';
import { matchNodes } from './match.js';

/**
 * Compare two structural snapshots and emit typed semantic events. Never emits a
 * raw JSON blob or a similarity score — only named events, which is the entire
 * differentiation of the tool.
 */
export function diffSnapshots(
  baseline: StructuralSnapshot,
  next: StructuralSnapshot,
  opts: DiffOptions = {},
): DiffResult {
  // Identical structure -> no work. This is also what keeps re-serializing the
  // same document from ever producing a spurious diff.
  if (baseline.contentHash === next.contentHash) {
    const n = baseline.nodes.length;
    return {
      changed: false,
      events: [],
      baselineHash: baseline.contentHash,
      newHash: next.contentHash,
      stats: { baselineNodes: n, newNodes: n, pairs: n, added: 0, removed: 0 },
    };
  }

  const threshold = opts.positionThresholdPts ?? DEFAULT_POSITION_THRESHOLD_PTS;
  const ignore = new Set<NodeRole>(opts.ignoreRoles ?? []);
  const minConfidence = opts.minConfidence ?? 0;
  const severityOf = (type: SemanticEventType): Severity =>
    opts.severityOverrides?.[type] ?? DEFAULT_SEVERITY[type];

  const baseNodes = baseline.nodes.filter((n) => !ignore.has(n.role));
  const nextNodes = next.nodes.filter((n) => !ignore.has(n.role));

  const events: SemanticEvent[] = [];

  if (baseline.pageCount !== next.pageCount) {
    events.push({
      type: 'page-count-changed',
      severity: severityOf('page-count-changed'),
      confidence: 1,
      from: baseline.pageCount,
      to: next.pageCount,
      message: `page count changed ${baseline.pageCount} → ${next.pageCount}`,
    });
  }

  const { pairs, added, removed } = matchNodes(baseNodes, nextNodes);

  for (const { base, next: after } of pairs) {
    const conf = Math.min(base.confidence, after.confidence);

    if (after.role === 'table') {
      const movedPage = base.pageIndex !== after.pageIndex;
      const movedOnPage = centerDistance(base.bbox, after.bbox) > threshold;
      if (movedPage || movedOnPage) {
        events.push({
          type: 'table-moved',
          severity: severityOf('table-moved'),
          confidence: conf,
          nodeId: after.id,
          baseNodeId: base.id,
          fromPage: base.pageIndex,
          toPage: after.pageIndex,
          fromBBox: base.bbox,
          toBBox: after.bbox,
          message: movedPage
            ? `table moved from page ${base.pageIndex + 1} to page ${after.pageIndex + 1}`
            : `table moved ${Math.round(centerDistance(base.bbox, after.bbox))}pt on page ${after.pageIndex + 1}`,
        });
      }
    } else if (base.pageIndex !== after.pageIndex) {
      events.push({
        type: 'element-moved-to-different-page',
        severity: severityOf('element-moved-to-different-page'),
        confidence: conf,
        nodeId: after.id,
        baseNodeId: base.id,
        role: after.role,
        textPreview: textPreview(after.text),
        fromPage: base.pageIndex,
        toPage: after.pageIndex,
        fromBBox: base.bbox,
        toBBox: after.bbox,
        message: `${describe(after)} moved from page ${base.pageIndex + 1} to page ${after.pageIndex + 1}`,
      });
    } else {
      // Same-page movement for NON-table elements. This branch did not exist
      // for the tool's first months, and the gap was found the expensive way
      // (forme's dogfood replay, 2026-09-05): a running header moving 25pt
      // and table cells redistributing 37pt both reported "no semantic
      // changes". Layout-engine changes move things WITHIN pages far more
      // often than across them — this is the workload's most common event.
      const dist = centerDistance(base.bbox, after.bbox);
      // Only when the pair's text agrees: a slot-matched pair whose text
      // differs is a content change at that slot (tolerated separately),
      // and calling it a "move" would be wrong twice.
      const sameText = base.normText === after.normText;
      if (sameText && dist > threshold) {
        events.push({
          type: 'element-moved',
          severity: severityOf('element-moved'),
          confidence: conf,
          nodeId: after.id,
          baseNodeId: base.id,
          role: after.role,
          textPreview: textPreview(after.text),
          pageIndex: after.pageIndex,
          fromBBox: base.bbox,
          toBBox: after.bbox,
          distancePts: Math.round(dist),
          message: `${describe(after)} moved ${Math.round(dist)}pt on page ${after.pageIndex + 1}`,
        });
      }
    }

    if (base.role === 'heading' && after.role === 'heading' && base.headingLevel !== after.headingLevel) {
      events.push({
        type: 'heading-hierarchy-changed',
        severity: severityOf('heading-hierarchy-changed'),
        confidence: conf,
        nodeId: after.id,
        baseNodeId: base.id,
        fromBBox: base.bbox,
        toBBox: after.bbox,
        textPreview: textPreview(after.text),
        fromLevel: base.headingLevel,
        toLevel: after.headingLevel,
        message: `heading "${textPreview(after.text)}" hierarchy changed ${fmtLevel(base.headingLevel)} → ${fmtLevel(after.headingLevel)}`,
      });
    }

    // Overflow is a regression only when it is newly present in this run.
    if (after.overflow && !base.overflow) {
      events.push(overflowEvent(after, severityOf('text-overflowed-container'), conf, base));
    }
  }

  for (const node of added) {
    events.push({
      type: 'element-added',
      severity: severityOf('element-added'),
      confidence: node.confidence,
      nodeId: node.id,
      role: node.role,
      textPreview: textPreview(node.text),
      pageIndex: node.pageIndex,
      bbox: node.bbox,
      message: `${describe(node)} added on page ${node.pageIndex + 1}`,
    });
    if (node.overflow) {
      events.push(overflowEvent(node, severityOf('text-overflowed-container'), node.confidence, null));
    }
  }

  for (const node of removed) {
    events.push({
      type: 'element-removed',
      severity: severityOf('element-removed'),
      confidence: node.confidence,
      nodeId: node.id,
      role: node.role,
      textPreview: textPreview(node.text),
      pageIndex: node.pageIndex,
      bbox: node.bbox,
      message: `${describe(node)} removed from page ${node.pageIndex + 1}`,
    });
  }

  // The fallback channel: the hashes differ (we are past the identical-hash
  // short-circuit) yet nothing above could name a change. Silence here would
  // be a lie — the same silent-failure shape this tool exists to expose — so
  // the silence itself becomes an event, with enough of a count to aim a
  // human at the right place.
  if (events.length === 0) {
    const eps = 0.5;
    // Count only same-text pairs: a slot pair whose text differs is a
    // tolerated content change, and array reordering pairs untouched
    // elements across slots — neither is unexplained geometry.
    const changedGeometry = pairs.filter(
      ({ base, next: after }) =>
        base.normText === after.normText &&
        (Math.abs(base.bbox.x - after.bbox.x) > eps ||
          Math.abs(base.bbox.y - after.bbox.y) > eps ||
          Math.abs(base.bbox.width - after.bbox.width) > eps ||
          Math.abs(base.bbox.height - after.bbox.height) > eps),
    ).length;
    if (changedGeometry > 0) {
      events.push({
        type: 'uncharacterized-change',
        severity: severityOf('uncharacterized-change'),
        confidence: 1,
        changedGeometry,
        matchedCount: pairs.length,
        message: `snapshot changed but no nameable event fired: ${changedGeometry} of ${pairs.length} matched element${pairs.length === 1 ? '' : 's'} moved or resized below the ${threshold}pt threshold`,
      });
    }
  }

  const filtered = events.filter((e) => e.confidence >= minConfidence);
  return {
    changed: filtered.length > 0,
    events: filtered,
    baselineHash: baseline.contentHash,
    newHash: next.contentHash,
    stats: {
      baselineNodes: baseNodes.length,
      newNodes: nextNodes.length,
      pairs: pairs.length,
      added: added.length,
      removed: removed.length,
    },
  };
}

function overflowEvent(
  node: StructuralNode,
  severity: Severity,
  confidence: number,
  base: StructuralNode | null,
): SemanticEvent {
  const o = node.overflow!;
  return {
    type: 'text-overflowed-container',
    severity,
    confidence,
    nodeId: node.id,
    textPreview: textPreview(node.text),
    overflow: o,
    pageIndex: node.pageIndex,
    bbox: node.bbox,
    baseNodeId: base?.id ?? null,
    fromBBox: base?.bbox ?? null,
    message: `${describe(node)} overflowed its ${o.container} box by ${o.overflowPts}pt (${o.axis})`,
  };
}

function describe(node: StructuralNode): string {
  const preview = textPreview(node.text);
  return preview ? `${node.role} "${preview}"` : node.role;
}

function fmtLevel(level: number | null): string {
  return level == null ? '—' : `H${level}`;
}
