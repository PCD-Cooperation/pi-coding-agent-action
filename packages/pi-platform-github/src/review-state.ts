import { createHash } from 'node:crypto';
import { parseReviewComment } from '@alexanderfortin/pi-orchestrator';
import type {
  ReviewIdentity,
  ReviewSnapshot,
  ReviewState,
  ReviewStateRecord,
  StatefulReviewPlatform,
} from '@alexanderfortin/pi-orchestrator';
import type { GitHubModuleDeps } from './types';
import { prepareReviewSnapshot } from './review-snapshot';

const MARKER = '<!-- pi-stateful-review:v1 -->';
const BOT = 'github-actions[bot]';
type Prepare = (
  identity: Omit<ReviewIdentity, 'mergeBaseSha'>,
  previous: ReviewState | null,
  remote: string,
  token?: string
) => Promise<ReviewSnapshot>;

/** GitHub has no comment CAS. Callers MUST serialize cooperating writers per PR.
 * Only GITHUB_TOKEN is supported: read-back ownership checks reject PAT/App authors.
 * A non-cooperating writer can still race the final check and update.
 */
export function createStatefulReviewPlatform(
  deps: GitHubModuleDeps,
  prepare: Prepare = prepareReviewSnapshot
): StatefulReviewPlatform {
  const { octokit, context } = deps;
  const repo = context.repo;
  const pullNumber = context.issue.number;
  const repository = `${repo.owner}/${repo.repo}`;
  function associated(state: ReviewState): void {
    if (state.snapshot.repository !== repository || state.snapshot.pullNumber !== pullNumber) {
      throw new Error('Review state repository/PR mismatch');
    }
  }
  async function requireInstallationToken(): Promise<void> {
    try {
      // Octokit's tokenType is inferred from legacy token syntax, not server identity.
      await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 1 });
    } catch {
      throw new Error(
        'Unable to verify installation authentication; stateful review requires GITHUB_TOKEN.'
      );
    }
  }
  async function live() {
    const { data: pr } = await octokit.rest.pulls.get({ ...repo, pull_number: pullNumber });
    if (pr.state !== 'open' || pr.draft || pr.merged) {
      throw new Error('Stateful review requires an open, non-draft PR');
    }
    if (pr.head.repo?.full_name !== repository || pr.base.repo.full_name !== repository) {
      throw new Error('Fork PRs are not supported');
    }
    if (!/^[a-f0-9]{40}$/.test(pr.head.sha) || !/^[a-f0-9]{40}$/.test(pr.base.sha)) {
      throw new Error('Invalid live commit SHA');
    }
    return {
      repository,
      pullNumber,
      cloneUrl: pr.base.repo.clone_url,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      baseRef: pr.base.ref,
      intentHash: createHash('sha256')
        .update(JSON.stringify([pr.title, pr.body ?? '']))
        .digest('hex'),
    };
  }
  async function loadState(): Promise<ReviewStateRecord | null> {
    let record: ReviewStateRecord | null = null;
    for (let page = 1; ; page++) {
      const { data } = await octokit.rest.issues.listComments({
        ...repo,
        issue_number: pullNumber,
        per_page: 100,
        page,
      });
      for (const comment of data) {
        if (!comment.body?.includes(MARKER)) {
          continue;
        }
        if (comment.user?.login !== BOT || comment.user.type !== 'Bot') {
          deps.logger.warning(
            'Ignoring an untrusted stateful review marker; only github-actions[bot] state is authoritative.'
          );
          continue;
        }
        if (!comment.body.startsWith(MARKER)) {
          continue;
        }
        if (record) {
          throw new Error('Duplicate canonical review comments');
        }
        const state = parseReviewComment(comment.body);
        associated(state);
        record = { commentId: comment.id, body: comment.body, state };
      }
      if (data.length < 100) {
        return record;
      }
    }
  }
  return {
    loadState,
    async snapshot(previous) {
      await requireInstallationToken();
      if (previous) {
        associated(previous);
      }
      const { cloneUrl, ...identity } = await live();
      // server_url is a permalink override, never an authenticated transport destination.
      const remote = new URL(cloneUrl);
      if (
        remote.protocol !== 'https:' ||
        remote.username ||
        remote.password ||
        remote.pathname !== `/${repository}.git` ||
        remote.search ||
        remote.hash
      ) {
        throw new Error('Unsafe repository clone URL');
      }
      const auth = (await octokit.auth()) as { token?: string };
      return prepare(identity, previous, remote.href, auth.token);
    },
    async authorizeControl() {
      if (!context.actor) {
        throw new Error('Review control requires an authenticated actor');
      }
      const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
        ...repo,
        username: context.actor,
      });
      if (!['write', 'maintain', 'admin'].includes(data.permission)) {
        throw new Error('Review control requires repository write permission');
      }
    },
    async publish(expected, snapshot, state, body) {
      await requireInstallationToken();
      associated(state);
      const parsed = parseReviewComment(body);
      if (JSON.stringify(parsed) !== JSON.stringify(state)) {
        throw new Error('Published body does not match review state');
      }
      for (const key of [
        'repository',
        'pullNumber',
        'headSha',
        'baseSha',
        'mergeBaseSha',
        'baseRef',
        'intentHash',
      ] as const) {
        if (state.snapshot[key] !== snapshot[key]) {
          throw new Error('Published state does not match pinned snapshot');
        }
      }
      const current = await live();
      for (const key of [
        'repository',
        'pullNumber',
        'headSha',
        'baseSha',
        'baseRef',
        'intentHash',
      ] as const) {
        if (current[key] !== snapshot[key]) {
          throw new Error('Stale review snapshot');
        }
      }
      const actual = await loadState();
      if (actual?.commentId !== expected?.commentId || actual?.body !== expected?.body) {
        throw new Error('Canonical review state changed');
      }
      try {
        if (expected) {
          await octokit.rest.issues.updateComment({
            ...repo,
            comment_id: expected.commentId,
            body,
          });
        } else {
          await octokit.rest.issues.createComment({ ...repo, issue_number: pullNumber, body });
        }
      } catch (error) {
        // A timeout may have committed. Reconcile, but never retry/create a replacement.
        const recovered = await loadState();
        if (
          recovered?.state.operationKey === state.operationKey &&
          recovered.body === body &&
          (!expected || recovered.commentId === expected.commentId)
        ) {
          return;
        }
        throw error;
      }
      const written = await loadState();
      if (
        written?.body !== body ||
        written.state.operationKey !== state.operationKey ||
        (expected && written.commentId !== expected.commentId)
      ) {
        throw new Error('Canonical review write could not be verified (GITHUB_TOKEN required)');
      }
    },
  };
}
