import { readFileSync } from 'node:fs';

/** Where a run came from — everything PROTOCOL.md §2 needs to open a batch. */
export interface CiContext {
  repository: { owner: string; name: string };
  headCommit: string;
  branch: string;
  pr: { number: number; baseBranch: string; headBranch: string } | null;
  ci: {
    provider: 'github-actions' | 'other';
    runId: string;
    runAttempt: number;
    runUrl: string | null;
    actor: string | null;
  };
}

export interface ContextOverrides {
  repo?: string;
  commit?: string;
  branch?: string;
  pr?: number;
  prBase?: string;
  runId?: string;
  runAttempt?: number;
  actor?: string;
}

const HEX40 = /^[0-9a-f]{40}$/;

/**
 * Resolve the run's provenance from the environment, with flags overriding.
 * On GitHub Actions everything is derivable — with one trap: on pull_request
 * events GITHUB_SHA is the synthetic MERGE commit, and the commit the service
 * must key on is the PR's head, which only the event payload knows.
 */
export function resolveContext(env: Record<string, string | undefined>, over: ContextOverrides): CiContext {
  const onGitHub = env.GITHUB_ACTIONS === 'true';
  let repo = over.repo ?? (onGitHub ? env.GITHUB_REPOSITORY : undefined);
  let commit = over.commit;
  let branch = over.branch;
  let pr: CiContext['pr'] = null;
  let runId = over.runId;
  let runAttempt = over.runAttempt;
  let actor = over.actor ?? null;
  let runUrl: string | null = null;

  if (onGitHub) {
    const eventName = env.GITHUB_EVENT_NAME ?? '';
    const payload = readEvent(env.GITHUB_EVENT_PATH);
    const prPayload = eventName.startsWith('pull_request') ? payload?.pull_request : undefined;
    if (prPayload) {
      commit ??= prPayload.head?.sha;
      branch ??= prPayload.head?.ref ?? env.GITHUB_HEAD_REF;
      pr = {
        number: over.pr ?? prPayload.number,
        baseBranch: over.prBase ?? prPayload.base?.ref ?? 'main',
        headBranch: prPayload.head?.ref ?? env.GITHUB_HEAD_REF ?? branch ?? '',
      };
    } else {
      commit ??= env.GITHUB_SHA;
      branch ??= env.GITHUB_REF_NAME;
    }
    runId ??= env.GITHUB_RUN_ID;
    runAttempt ??= env.GITHUB_RUN_ATTEMPT ? parseInt(env.GITHUB_RUN_ATTEMPT, 10) : undefined;
    actor ??= env.GITHUB_ACTOR ?? null;
    if (env.GITHUB_SERVER_URL && repo && runId) runUrl = `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${runId}`;
  } else {
    // Generic CI: PDF_TESTKIT_* env vars stand in for flags.
    repo ??= env.PDF_TESTKIT_REPO;
    commit ??= env.PDF_TESTKIT_COMMIT;
    branch ??= env.PDF_TESTKIT_BRANCH;
    runId ??= env.PDF_TESTKIT_RUN_ID;
    if (over.pr != null) pr = { number: over.pr, baseBranch: over.prBase ?? 'main', headBranch: branch ?? '' };
  }
  if (over.pr != null && pr) pr.number = over.pr;

  const missing: string[] = [];
  if (!repo) missing.push('--repo owner/name');
  if (!commit) missing.push('--commit <sha>');
  if (!branch) missing.push('--branch <name>');
  if (!runId) missing.push('--run-id <id>');
  if (missing.length) {
    throw new Error(
      `cannot tell where this run came from; outside GitHub Actions pass ${missing.join(', ')} ` +
        '(or PDF_TESTKIT_REPO / _COMMIT / _BRANCH / _RUN_ID)',
    );
  }
  const [owner, name, ...rest] = repo!.split('/');
  if (!owner || !name || rest.length) throw new Error(`--repo must be owner/name (got "${repo}")`);
  if (!HEX40.test(commit!)) throw new Error(`commit must be a full 40-char lowercase hex sha (got "${commit}")`);

  return {
    repository: { owner, name },
    headCommit: commit!,
    branch: branch!,
    pr,
    ci: {
      provider: onGitHub ? 'github-actions' : 'other',
      runId: runId!,
      runAttempt: runAttempt ?? 1,
      runUrl,
      actor,
    },
  };
}

interface EventPayload {
  pull_request?: { number: number; head?: { sha?: string; ref?: string }; base?: { ref?: string } };
}

function readEvent(path: string | undefined): EventPayload | null {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as EventPayload;
  } catch {
    return null;
  }
}
