import type { DiffResult, EventGroup, SemanticEvent, Severity } from '@pdf-testkit/core';

const SYMBOL: Record<Severity, string> = { error: '✗', warn: '⚠', info: 'ℹ' };
const RANK: Record<Severity, number> = { info: 0, warn: 1, error: 2 };

export type FailOn = 'error' | 'warn' | 'any';

/** Whether a diff result should fail the process at the given gate. */
export function shouldFail(result: DiffResult, failOn: FailOn): boolean {
  if (failOn === 'any') return result.events.length > 0;
  const gate = failOn === 'warn' ? RANK.warn : RANK.error;
  return result.events.some((e) => RANK[e.severity] >= gate);
}

/**
 * Human output. Pass `groups` to collapse causally-related events into one line
 * each; omit it for the full flat list, which is what `--verbose` prints. The
 * fail gate never reads this — grouping changes what a person reads, not what
 * the exit code says.
 */
export function formatHuman(
  result: DiffResult,
  a: string,
  b: string,
  groups: EventGroup[] | null = null,
): string {
  if (!result.changed) return `✓ no semantic changes (${a} → ${b})`;
  const n = result.events.length;
  const plural = n === 1 ? '' : 's';

  if (!groups) return [`✗ ${n} semantic change${plural} (${a} → ${b}):`, ...result.events.map(line)].join('\n');

  const collapsed = n - groups.length;
  const header =
    collapsed > 0
      ? `✗ ${n} semantic change${plural} in ${groups.length} group${groups.length === 1 ? '' : 's'} (${a} → ${b}):`
      : `✗ ${n} semantic change${plural} (${a} → ${b}):`;
  const lines = groups.map((g) => {
    const count = g.events.length > 1 ? `  [${g.events.length} events]` : '';
    return `  ${SYMBOL[g.severity]} ${g.root.type}  ${g.summary}${conf(g.root)}${count}`;
  });
  const footer =
    collapsed > 0
      ? ['', `  → ${collapsed} related event${collapsed === 1 ? '' : 's'} collapsed; re-run with --verbose for the full list.`]
      : [];
  return [header, ...lines, ...footer].join('\n');
}

function line(e: SemanticEvent): string {
  return `  ${SYMBOL[e.severity]} ${e.type}  ${e.message}${conf(e)}`;
}

function conf(e: SemanticEvent): string {
  return e.confidence < 1 ? `  (confidence ${e.confidence.toFixed(2)})` : '';
}
