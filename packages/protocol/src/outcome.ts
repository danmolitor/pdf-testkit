import type { FailOn, Outcome, ReviewState, Severity } from './schema.js';

const RANK: Record<Severity, number> = { info: 0, warn: 1, error: 2 };
const GATE: Record<FailOn, number> = { any: 0, warn: 1, error: 2 };

/**
 * The two axes of storage spec §4, computed from the reported events and the
 * customer's gate. `outcome` is what the GitHub check conclusion derives from;
 * `review_state` is owed whenever anything at all was reported, so a
 * warnings-only run is green in CI and still waiting for a person.
 */
export function computeOutcome(
  events: ReadonlyArray<{ severity: Severity }>,
  failOn: FailOn,
): { outcome: Outcome; review_state: Extract<ReviewState, 'not_required' | 'awaiting_review'> } {
  const blocked = events.some((e) => RANK[e.severity] >= GATE[failOn]);
  return {
    outcome: blocked ? 'blocked' : 'passed',
    review_state: events.length > 0 ? 'awaiting_review' : 'not_required',
  };
}
