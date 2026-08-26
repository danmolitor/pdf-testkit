import type { DiffResult } from '@pdf-testkit/core';
export type FailOn = 'error' | 'warn' | 'any';
/** Marker so the Action can find and update its own comment instead of spamming. */
export declare const COMMENT_MARKER = "<!-- pdf-testkit -->";
export declare function shouldFail(result: DiffResult, failOn: FailOn): boolean;
/** Render a diff as a Markdown PR comment body (semantic events only). */
export declare function renderMarkdown(label: string, result: DiffResult): string;
