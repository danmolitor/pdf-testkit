/**
 * Comment-only GitHub Action: diff a baseline against the current run and post
 * (or update) a single PR comment with the semantic events. No hosted storage —
 * baselines are just files the consumer commits to their own repo.
 */
export declare function run(): Promise<void>;
