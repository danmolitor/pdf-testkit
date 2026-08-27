import type { DiffResult, EventGroup } from '@pdf-testkit/core';
export type FailOn = 'error' | 'warn' | 'any';
/** Marker so the Action can find and update its own comment instead of spamming. */
export declare const COMMENT_MARKER = "<!-- pdf-testkit -->";
export declare function shouldFail(result: DiffResult, failOn: FailOn): boolean;
/**
 * Render a diff as a Markdown PR comment body (semantic events only).
 *
 * With `groups`, each causally-related run becomes one row and its members go
 * into a collapsed `<details>` block beneath the table — GitHub renders those
 * natively in comments, so the full per-element list stays in the PR, one click
 * away. The grouped view is a view, never a filter: nothing is discarded.
 */
export declare function renderMarkdown(label: string, result: DiffResult, groups?: EventGroup[] | null): string;
