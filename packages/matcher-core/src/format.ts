import type { SemanticEvent, Severity } from '@pdf-testkit/core';

const SYMBOL: Record<Severity, string> = { error: '✗', warn: '⚠', info: 'ℹ' };

/**
 * The failure message shows ONLY the semantic event list — never a raw JSON blob
 * or a pixel/percentage. That is the product's entire differentiation.
 */
export function formatFailure(events: SemanticEvent[], snapshotPath: string): string {
  const header = `PDF snapshot changed (${events.length} semantic event${events.length === 1 ? '' : 's'}):`;
  const lines = events.map((e) => {
    const conf = e.confidence < 1 ? `  (confidence ${e.confidence.toFixed(2)})` : '';
    return `  ${SYMBOL[e.severity]} ${e.type}  ${e.message}${conf}`;
  });
  return [
    header,
    ...lines,
    '',
    '  → Run with -u (or PDF_TESTKIT_UPDATE=1) to accept these changes.',
    `  baseline: ${snapshotPath}`,
  ].join('\n');
}
