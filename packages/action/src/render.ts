import { causeTally, formatTally, type DiffResult, type EventGroup, type SemanticEvent, type Severity } from '@pdf-testkit/core';

export type FailOn = 'error' | 'warn' | 'any';

const RANK: Record<Severity, number> = { info: 0, warn: 1, error: 2 };
const EMOJI: Record<Severity, string> = { error: '🔴', warn: '🟡', info: '🔵' };

/** Marker so the Action can find and update its own comment instead of spamming. */
export const COMMENT_MARKER = '<!-- pdf-testkit -->';
/** Demand measurement for a hosted review layer: reactions on this issue are the count. */
export const INTEREST_URL = 'https://github.com/danmolitor/pdf-testkit/issues/1';

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
  // Confidence only means something when structure was *inferred*. A FormePDF
  // run is authoritative end to end, so the column would be blank on every row;
  // decided once from the whole event list so the summary table and the
  // <details> tables never disagree about their shape.
  const cols = result.events.some((e) => e.confidence < 1);
  const rows = groups
    ? groups.map((g) => {
        const count = g.events.length > 1 ? ` _(${g.events.length} events)_` : '';
        return cell(g.severity, g.root.type, escapePipes(g.summary) + count, g.root, cols);
      })
    : result.events.map((e) => row(e, cols));
  const collapsed = groups ? n - groups.length : 0;
  // Causes first, events second: a cascade is one row and one count, never a pile of warnings.
  const t = groups ? causeTally(groups) : null;
  const headline = t
    ? `**${formatTally(t)}** · **${t.causes}** cause${t.causes === 1 ? '' : 's'}, ${n} event${n === 1 ? '' : 's'}:`
    : `**${n}** semantic change${n === 1 ? '' : 's'} detected:`;

  return [
    COMMENT_MARKER,
    `### 📄 pdf-testkit — \`${label}\``,
    '',
    headline,
    '',
    ...header(cols),
    ...rows,
    '',
    ...(collapsed > 0 ? [details(groups!, cols), ''] : []),
    '_Run `pdf-testkit` locally with `-u` (or `PDF_TESTKIT_UPDATE=1`) to accept these changes._',
    '',
    `<sub>Want to review this with page images side by side, and approve it as a team? [Say so](${INTEREST_URL}).</sub>`,
  ].join('\n');
}

function details(groups: EventGroup[], cols: boolean): string {
  const blocks = groups
    .filter((g) => g.events.length > 1)
    .map((g) =>
      [
        '<details>',
        `<summary>${escapeHtml(g.summary)} — ${g.events.length} events</summary>`,
        '',
        ...header(cols),
        ...g.events.map((e) => row(e, cols)),
        '',
        '</details>',
      ].join('\n'),
    );
  return blocks.join('\n\n');
}

function header(cols: boolean): string[] {
  return cols
    ? ['| | Event | Detail | Confidence |', '| :-: | --- | --- | :-: |']
    : ['| | Event | Detail |', '| :-: | --- | --- |'];
}

function row(e: SemanticEvent, cols: boolean): string {
  return cell(e.severity, e.type, escapePipes(e.message), e, cols);
}

function cell(severity: Severity, type: string, detail: string, e: SemanticEvent, cols: boolean): string {
  const head = `| ${EMOJI[severity]} | \`${type}\` | ${detail} |`;
  return cols ? `${head} ${confidence(e)} |` : head;
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
