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
    return { changed: false, events: [], baselineHash: baseline.contentHash, newHash: next.contentHash };
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
        role: after.role,
        textPreview: textPreview(after.text),
        fromPage: base.pageIndex,
        toPage: after.pageIndex,
        message: `${describe(after)} moved from page ${base.pageIndex + 1} to page ${after.pageIndex + 1}`,
      });
    }

    if (base.role === 'heading' && after.role === 'heading' && base.headingLevel !== after.headingLevel) {
      events.push({
        type: 'heading-hierarchy-changed',
        severity: severityOf('heading-hierarchy-changed'),
        confidence: conf,
        nodeId: after.id,
        textPreview: textPreview(after.text),
        fromLevel: base.headingLevel,
        toLevel: after.headingLevel,
        message: `heading "${textPreview(after.text)}" hierarchy changed ${fmtLevel(base.headingLevel)} → ${fmtLevel(after.headingLevel)}`,
      });
    }

    // Overflow is a regression only when it is newly present in this run.
    if (after.overflow && !base.overflow) {
      events.push(overflowEvent(after, severityOf('text-overflowed-container'), conf));
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
      message: `${describe(node)} added on page ${node.pageIndex + 1}`,
    });
    if (node.overflow) {
      events.push(overflowEvent(node, severityOf('text-overflowed-container'), node.confidence));
    }
  }

  for (const node of removed) {
    events.push({
      type: 'element-removed',
      severity: severityOf('element-removed'),
      confidence: node.confidence,
      role: node.role,
      textPreview: textPreview(node.text),
      pageIndex: node.pageIndex,
      message: `${describe(node)} removed from page ${node.pageIndex + 1}`,
    });
  }

  const filtered = events.filter((e) => e.confidence >= minConfidence);
  return {
    changed: filtered.length > 0,
    events: filtered,
    baselineHash: baseline.contentHash,
    newHash: next.contentHash,
  };
}

function overflowEvent(
  node: StructuralNode,
  severity: Severity,
  confidence: number,
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
