const RANK = { info: 0, warn: 1, error: 2 };
const EMOJI = { error: '🔴', warn: '🟡', info: '🔵' };
/** Marker so the Action can find and update its own comment instead of spamming. */
export const COMMENT_MARKER = '<!-- pdf-testkit -->';
export function shouldFail(result, failOn) {
    if (failOn === 'any')
        return result.events.length > 0;
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
export function renderMarkdown(label, result, groups = null) {
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
    const headline = collapsed > 0
        ? `**${n}** semantic change${n === 1 ? '' : 's'} detected, grouped into **${groups.length}**:`
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
        ...(collapsed > 0 ? [details(groups, cols), ''] : []),
        '_Run `pdf-testkit` locally with `-u` (or `PDF_TESTKIT_UPDATE=1`) to accept these changes._',
    ].join('\n');
}
function details(groups, cols) {
    const blocks = groups
        .filter((g) => g.events.length > 1)
        .map((g) => [
        '<details>',
        `<summary>${escapeHtml(g.summary)} — ${g.events.length} events</summary>`,
        '',
        ...header(cols),
        ...g.events.map((e) => row(e, cols)),
        '',
        '</details>',
    ].join('\n'));
    return blocks.join('\n\n');
}
function header(cols) {
    return cols
        ? ['| | Event | Detail | Confidence |', '| :-: | --- | --- | :-: |']
        : ['| | Event | Detail |', '| :-: | --- | --- |'];
}
function row(e, cols) {
    return cell(e.severity, e.type, escapePipes(e.message), e, cols);
}
function cell(severity, type, detail, e, cols) {
    const head = `| ${EMOJI[severity]} | \`${type}\` | ${detail} |`;
    return cols ? `${head} ${confidence(e)} |` : head;
}
function confidence(e) {
    return e.confidence < 1 ? e.confidence.toFixed(2) : '';
}
function escapePipes(s) {
    return s.replace(/\|/g, '\\|');
}
function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
//# sourceMappingURL=render.js.map