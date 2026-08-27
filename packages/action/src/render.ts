import type { DiffResult, EventGroup, SemanticEvent, Severity } from '@pdf-testkit/core';

export type FailOn = 'error' | 'warn' | 'any';

const RANK: Record<Severity, number> = { info: 0, warn: 1, error: 2 };
const EMOJI: Record<Severity, string> = { error: '🔴', warn: '🟡', info: '🔵' };

/** Marker so the Action can find and update its own comment instead of spamming. */
export const COMMENT_MARKER = '<!-- pdf-testkit -->';

export function shouldFail(result: DiffResult, failOn: FailOn): boolean {
  if (failOn === 'any') return result.events.length > 0;
  const gate = failOn === 'warn' ? RANK.warn : RANK.error;
  return result.events.some((e) => RANK[e.severity] >= gate);
}

/**
 * Render a diff as a Markdown PR comment body (semantic events only).
 *
 * With `groups`, each causally-related run becomes one row and its members go
 * into a collapsed `<details>` block beneath the table — GitHub renders those
 * natively in comments, so the full per-element list stays in the PR, one click
 * away. The grouped view is a view, never a filter: nothing is discarded.
 */
export function renderMarkdown(
  label: string,
  result: DiffResult,
  groups: EventGroup[] | null = null,
): string {
  if (!result.changed) {
    return [COMMENT_MARKER, `### 📄 pdf-testkit — \`${label}\``, '', '✅ No semantic changes detected.'].join('\n');
  }
  const n = result.events.length;
  const rows = groups
    ? groups.map((g) => {
        const count = g.events.length > 1 ? ` _(${g.events.length} events)_` : '';
        return `| ${EMOJI[g.severity]} | \`${g.root.type}\` | ${escapePipes(g.summary)}${count} | ${confidence(g.root)} |`;
      })
    : result.events.map(row);
  const collapsed = groups ? n - groups.length : 0;
  const headline =
    collapsed > 0
      ? `**${n}** semantic change${n === 1 ? '' : 's'} detected, grouped into **${groups!.length}**:`
      : `**${n}** semantic change${n === 1 ? '' : 's'} detected:`;

  return [
    COMMENT_MARKER,
    `### 📄 pdf-testkit — \`${label}\``,
    '',
    headline,
    '',
    '| | Event | Detail | Confidence |',
    '| :-: | --- | --- | :-: |',
    ...rows,
    '',
    ...(collapsed > 0 ? [details(groups!), ''] : []),
    '_Run `pdf-testkit` locally with `-u` (or `PDF_TESTKIT_UPDATE=1`) to accept these changes._',
  ].join('\n');
}

function details(groups: EventGroup[]): string {
  const blocks = groups
    .filter((g) => g.events.length > 1)
    .map((g) =>
      [
        '<details>',
        `<summary>${escapeHtml(g.summary)} — ${g.events.length} events</summary>`,
        '',
        '| | Event | Detail | Confidence |',
        '| :-: | --- | --- | :-: |',
        ...g.events.map(row),
        '',
        '</details>',
      ].join('\n'),
    );
  return blocks.join('\n\n');
}

function row(e: SemanticEvent): string {
  return `| ${EMOJI[e.severity]} | \`${e.type}\` | ${escapePipes(e.message)} | ${confidence(e)} |`;
}

function confidence(e: SemanticEvent): string {
  return e.confidence < 1 ? e.confidence.toFixed(2) : '';
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
