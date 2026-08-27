import * as core from '@actions/core';
import * as github from '@actions/github';
import { diffSnapshots, groupEvents, loadSnapshotFromFile } from '@pdf-testkit/core';
import { COMMENT_MARKER, renderMarkdown, shouldFail, type FailOn } from './render.js';

/**
 * Comment-only GitHub Action: diff a baseline against the current run and post
 * (or update) a single PR comment with the semantic events. No hosted storage —
 * baselines are just files the consumer commits to their own repo.
 */
export async function run(): Promise<void> {
  try {
    const baseline = core.getInput('baseline', { required: true });
    const current = core.getInput('current', { required: true });
    const failOn = normalizeFailOn(core.getInput('fail-on'));
    const wantComment = core.getInput('comment') !== 'false';

    const [base, next] = await Promise.all([
      loadSnapshotFromFile(baseline),
      loadSnapshotFromFile(current),
    ]);
    const result = diffSnapshots(base, next);

    core.setOutput('changed', String(result.changed));
    core.setOutput('event-count', String(result.events.length));

    // The outputs and the fail gate above read the full event list; grouping
    // only shapes the comment, and every event still ships inside a <details>.
    const body = renderMarkdown(current, result, groupEvents(base, next, result.events));
    core.summary.addRaw(body).write().catch(() => undefined);

    if (wantComment) await upsertComment(body);

    if (shouldFail(result, failOn)) {
      core.setFailed(`pdf-testkit: ${result.events.length} semantic change(s) (fail-on=${failOn}).`);
    }
  } catch (err) {
    core.setFailed(`pdf-testkit action failed: ${(err as Error)?.message ?? err}`);
  }
}

async function upsertComment(body: string): Promise<void> {
  const token = core.getInput('token') || process.env.GITHUB_TOKEN || '';
  const pr = github.context.payload.pull_request;
  if (!token || !pr) {
    core.info('No PR context or token; skipping comment (summary still written).');
    return;
  }
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const issue_number = pr.number;

  const existing = await octokit.rest.issues.listComments({ owner, repo, issue_number });
  const mine = existing.data.find((c) => c.body?.includes(COMMENT_MARKER));
  if (mine) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
  }
}

function normalizeFailOn(value: string): FailOn {
  return value === 'warn' || value === 'any' ? value : 'error';
}

void run();
