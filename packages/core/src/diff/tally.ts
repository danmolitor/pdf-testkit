import type { Severity } from '../events.js';
import type { EventGroup } from './group.js';

/**
 * A tally by CAUSE. One table that grew and pushed twenty cells sideways is one
 * warning, not twenty-one: a cascade never contributes severity of its own.
 * Counting events instead trains a reviewer to click through, which is the
 * failure this tool exists to prevent. `events` is still reported, as a size.
 */
export interface CauseTally {
  errors: number;
  warnings: number;
  info: number;
  causes: number;
  events: number;
}

export function causeTally(groups: EventGroup[]): CauseTally {
  const t: CauseTally = { errors: 0, warnings: 0, info: 0, causes: groups.length, events: 0 };
  for (const g of groups) {
    t.events += g.events.length;
    if (g.severity === 'error') t.errors++;
    else if (g.severity === 'warn') t.warnings++;
    else t.info++;
  }
  return t;
}

const word: Record<Severity, [string, string]> = { error: ['error', 'errors'], warn: ['warning', 'warnings'], info: ['info', 'info'] };

/** "1 error, 5 warnings" — zero counts omitted; "no changes" when everything is zero. */
export function formatTally(t: Pick<CauseTally, 'errors' | 'warnings' | 'info'>): string {
  const parts: string[] = [];
  if (t.errors) parts.push(`${t.errors} ${word.error[t.errors === 1 ? 0 : 1]}`);
  if (t.warnings) parts.push(`${t.warnings} ${word.warn[t.warnings === 1 ? 0 : 1]}`);
  if (t.info) parts.push(`${t.info} info`);
  return parts.length ? parts.join(', ') : 'no changes';
}
