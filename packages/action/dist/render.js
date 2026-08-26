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
/** Render a diff as a Markdown PR comment body (semantic events only). */
export function renderMarkdown(label, result) {
    if (!result.changed) {
        return [COMMENT_MARKER, `### 📄 pdf-testkit — \`${label}\``, '', '✅ No semantic changes detected.'].join('\n');
    }
    const rows = result.events.map((e) => {
        const conf = e.confidence < 1 ? e.confidence.toFixed(2) : '';
        return `| ${EMOJI[e.severity]} | \`${e.type}\` | ${escapePipes(e.message)} | ${conf} |`;
    });
    return [
        COMMENT_MARKER,
        `### 📄 pdf-testkit — \`${label}\``,
        '',
        `**${result.events.length}** semantic change${result.events.length === 1 ? '' : 's'} detected:`,
        '',
        '| | Event | Detail | Confidence |',
        '| :-: | --- | --- | :-: |',
        ...rows,
        '',
        '_Run `pdf-testkit` locally with `-u` (or `PDF_TESTKIT_UPDATE=1`) to accept these changes._',
    ].join('\n');
}
function escapePipes(s) {
    return s.replace(/\|/g, '\\|');
}
//# sourceMappingURL=render.js.map