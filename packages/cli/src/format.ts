import type { DiffResult, SemanticEvent, Severity } from '@pdf-testkit/core';

const SYMBOL: Record<Severity, string> = { error: '✗', warn: '⚠', info: 'ℹ' };
const RANK: Record<Severity, number> = { info: 0, warn: 1, error: 2 };

export type FailOn = 'error' | 'warn' | 'any';

/** Whether a diff result should fail the process at the given gate. */
export function shouldFail(result: DiffResult, failOn: FailOn): boolean {
  if (failOn === 'any') return result.events.length > 0;
  const gate = failOn === 'warn' ? RANK.warn : RANK.error;
  return result.events.some((e) => RANK[e.severity] >= gate);
}

export function formatHuman(result: DiffResult, a: string, b: string): string {
  if (!result.changed) return `✓ no semantic changes (${a} → ${b})`;
  const header = `✗ ${result.events.length} semantic change${result.events.length === 1 ? '' : 's'} (${a} → ${b}):`;
  const lines = result.events.map((e: SemanticEvent) => {
    const conf = e.confidence < 1 ? `  (confidence ${e.confidence.toFixed(2)})` : '';
    return `  ${SYMBOL[e.severity]} ${e.type}  ${e.message}${conf}`;
  });
  return [header, ...lines].join('\n');
}
