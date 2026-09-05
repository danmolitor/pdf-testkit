import { causeTally, formatTally, type EventGroup, type SemanticEvent, type Severity } from '@pdf-testkit/core';

const SYMBOL: Record<Severity, string> = { error: '✗', warn: '⚠', info: 'ℹ' };

/**
 * The failure message shows ONLY the semantic event list — never a raw JSON blob
 * or a pixel/percentage. That is the product's entire differentiation.
 *
 * When `groups` is supplied, causally-related events collapse to one line each
 * and the footer says how to get the rest. A matcher has no flag surface of its
 * own, hence the env var (matching the `PDF_TESTKIT_UPDATE` precedent).
 */
export function formatFailure(
  events: SemanticEvent[],
  snapshotPath: string,
  groups: EventGroup[] | null = null,
): string {
  const header = groups
    ? (() => {
        const t = causeTally(groups);
        return `PDF snapshot changed: ${formatTally(t)} · ${t.causes} cause${t.causes === 1 ? '' : 's'}, ${events.length} event${events.length === 1 ? '' : 's'}:`;
      })()
    : `PDF snapshot changed (${events.length} semantic event${events.length === 1 ? '' : 's'}):`;
  const collapsed = groups ? events.length - groups.length : 0;
  const lines = groups
    ? groups.map((g) => {
        const count = g.events.length > 1 ? `  [${g.events.length} events]` : '';
        return `  ${SYMBOL[g.severity]} ${g.root.type}  ${g.summary}${conf(g.root)}${count}`;
      })
    : events.map((e) => `  ${SYMBOL[e.severity]} ${e.type}  ${e.message}${conf(e)}`);
  return [
    header,
    ...lines,
    ...(collapsed > 0
      ? ['', `  → ${collapsed} related event${collapsed === 1 ? '' : 's'} collapsed; set PDF_TESTKIT_VERBOSE=1 for the full list.`]
      : []),
    '',
    '  → Run with -u (or PDF_TESTKIT_UPDATE=1) to accept these changes.',
    `  baseline: ${snapshotPath}`,
  ].join('\n');
}

function conf(e: SemanticEvent): string {
  return e.confidence < 1 ? `  (confidence ${e.confidence.toFixed(2)})` : '';
}
