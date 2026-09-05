import * as core from '@actions/core';
import * as github from '@actions/github';
import { diffSnapshots, groupEvents, loadSnapshotFromFile } from '@pdf-testkit/core';
import { spawn } from 'node:child_process';
import { COMMENT_MARKER, renderMarkdown, shouldFail, type FailOn } from './render.js';
import { buildUploadArgs, describeExit } from './service.js';

/**
 * Comment-only GitHub Action: diff a baseline against the current run and post
 * (or update) a single PR comment with the semantic events. No hosted storage —
 * baselines are just files the consumer commits to their own repo.
 */
export async function run(): Promise<void> {
  try {
    // Service mode: the hosted review layer stores the baseline, posts the
    // check and the comment. This Action only hands the documents to the CLI.
    if (core.getInput('service-token')) {
      await runServiceMode();
      return;
    }

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

async function runServiceMode(): Promise<void> {
  const args = buildUploadArgs({
    documents: core.getInput('documents'),
    serviceUrl: core.getInput('service-url'),
    serviceToken: core.getInput('service-token'),
    dpi: core.getInput('dpi'),
    images: core.getInput('images'),
    failOn: core.getInput('fail-on'),
    requireService: core.getInput('require-service'),
  });
  core.info(`pdf-testkit ${args.filter((a) => a !== core.getInput('service-token')).join(' ')}`);
  const code = await new Promise<number>((resolve, reject) => {
    // `npx --no-install` uses the CLI the repository installed; the runner's
    // GITHUB_* environment supplies commit, branch, PR and run identity.
    const child = spawn('npx', ['--no-install', 'pdf-testkit', ...args], { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('close', (c) => resolve(c ?? 1));
  });
  const problem = describeExit(code);
  if (problem) core.setFailed(problem);
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
  // Comment mode keeps its historical default of `error` when the input is unset.
  return value === 'warn' || value === 'any' ? value : 'error';
}

void run();
