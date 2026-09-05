import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveContext } from '../src/service/context.js';

const SHA_MERGE = 'a'.repeat(40);
const SHA_HEAD = 'b'.repeat(40);

function githubEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'meridian/billing-service',
    GITHUB_SHA: SHA_MERGE,
    GITHUB_REF_NAME: 'main',
    GITHUB_RUN_ID: '11223344',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_ACTOR: 'priya-raman',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_EVENT_NAME: 'push',
    ...extra,
  };
}

describe('resolveContext — where a run came from', () => {
  it('reads a push on GitHub Actions from the environment', () => {
    const ctx = resolveContext(githubEnv(), {});
    expect(ctx).toEqual({
      repository: { owner: 'meridian', name: 'billing-service' },
      headCommit: SHA_MERGE,
      branch: 'main',
      pr: null,
      ci: {
        provider: 'github-actions',
        runId: '11223344',
        runAttempt: 2,
        runUrl: 'https://github.com/meridian/billing-service/actions/runs/11223344',
        actor: 'priya-raman',
      },
    });
  });

  it('on pull_request events takes the HEAD sha from the event payload, never the merge sha', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptk-ctx-'));
    const eventPath = join(dir, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: { number: 482, head: { sha: SHA_HEAD, ref: 'feat/tax-lines' }, base: { ref: 'main' } },
      }),
    );
    const ctx = resolveContext(githubEnv({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_REF_NAME: '482/merge', GITHUB_HEAD_REF: 'feat/tax-lines' }), {});
    expect(ctx.headCommit).toBe(SHA_HEAD);
    expect(ctx.branch).toBe('feat/tax-lines');
    expect(ctx.pr).toEqual({ number: 482, baseBranch: 'main', headBranch: 'feat/tax-lines' });
  });

  it('lets flags override anything the environment says', () => {
    const ctx = resolveContext(githubEnv(), { commit: SHA_HEAD, branch: 'release/1', runAttempt: 5 });
    expect(ctx.headCommit).toBe(SHA_HEAD);
    expect(ctx.branch).toBe('release/1');
    expect(ctx.ci.runAttempt).toBe(5);
  });

  it('outside GitHub Actions requires repo, commit, branch and run id explicitly', () => {
    expect(() => resolveContext({}, {})).toThrow(/--repo/);
    const ctx = resolveContext({}, { repo: 'acme/docs', commit: SHA_HEAD, branch: 'main', runId: 'build-77' });
    expect(ctx.ci.provider).toBe('other');
    expect(ctx.ci.runAttempt).toBe(1);
    expect(ctx.repository).toEqual({ owner: 'acme', name: 'docs' });
  });

  it('rejects a commit that is not 40 hex chars', () => {
    expect(() => resolveContext({}, { repo: 'a/b', commit: 'abc', branch: 'main', runId: '1' })).toThrow(/commit/);
  });
});
