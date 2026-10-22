import { createHash } from 'node:crypto';
import {
  parseReviewComment,
  reviewHistoryParent,
  reviewParentDescriptor,
} from '@alexanderfortin/pi-orchestrator';
import type {
  ReviewIdentity,
  ReviewSnapshot,
  ReviewSnapshotOptions,
  ReviewState,
  ReviewStateRecord,
  StatefulReviewPlatform,
} from '@alexanderfortin/pi-orchestrator';
import type { GitHubModuleDeps } from './types';
import { prepareReviewSnapshot } from './review-snapshot';
import { createReviewLifecycle } from './review-lifecycle';
import { createReviewWorkStore } from './review-work';

const MARKER = '<!-- pi-stateful-review:v1 -->';
const BOT = 'github-actions[bot]';
const TIMELINE_EVENTS = new Set(
  (
    'assigned unassigned labeled unlabeled commented committed reviewed review_requested ' +
    'review_request_removed review_dismissed closed reopened merged renamed locked unlocked ' +
    'milestoned demilestoned referenced cross-referenced mentioned subscribed unsubscribed ' +
    'head_ref_deleted head_ref_restored head_ref_force_pushed base_ref_changed base_ref_force_pushed ' +
    'base_ref_deleted connected disconnected converted_note_to_issue added_to_project ' +
    'moved_columns_in_project removed_from_project marked_as_duplicate unmarked_as_duplicate ' +
    'automatic_base_change_failed automatic_base_change_succeeded auto_merge_enabled ' +
    'auto_merge_disabled auto_rebase_enabled auto_squash_enabled added_to_merge_queue ' +
    'removed_from_merge_queue added_to_stack removed_from_stack ready_for_review ' +
    'converted_to_draft pinned unpinned transferred parent_issue_added parent_issue_removed ' +
    'sub_issue_added sub_issue_removed sub_issue_parent_changed blocked_by_added blocked_by_removed ' +
    'blocking_added blocking_removed'
  ).split(' ')
);
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
type Prepare = (
  identity: Omit<ReviewIdentity, 'mergeBaseSha'>,
  previous: ReviewState | null,
  remote: string,
  token?: string,
  options?: ReviewSnapshotOptions
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
  async function requireInstallationToken(signal?: AbortSignal): Promise<void> {
    try {
      // Octokit's tokenType is inferred from legacy token syntax, not server identity.
      await octokit.rest.apps.listReposAccessibleToInstallation({
        per_page: 1,
        ...(signal ? { request: { signal, timeout: 15_000 } } : {}),
      });
    } catch {
      throw new Error(
        'Unable to verify installation authentication; stateful review requires GITHUB_TOKEN.'
      );
    }
  }
  async function live(includeIntent = false, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const request = signal ? { request: { signal, timeout: 15_000 } } : {};
    const { data: pr } = await octokit.rest.pulls.get({
      ...repo,
      pull_number: pullNumber,
      ...request,
    });
    if (pr.state !== 'open' || pr.draft || pr.merged) {
      throw new Error('Stateful review requires an open, non-draft PR');
    }
    if (pr.head.repo?.full_name !== repository || pr.base.repo.full_name !== repository) {
      throw new Error('Fork PRs are not supported');
    }
    if (pr.head.sha.length !== 40 || !/^[a-f0-9]{40}$/.test(pr.head.sha)) {
      throw new Error('Invalid live commit SHA');
    }
    const baseRef = pr.base.ref;
    if (
      typeof baseRef !== 'string' ||
      !baseRef ||
      baseRef === '@' ||
      /[\x00-\x20\x7f~^:?*\[\\]/.test(baseRef) ||
      baseRef.includes('..') ||
      baseRef.includes('@{') ||
      baseRef.endsWith('.') ||
      baseRef.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))
    ) {
      throw new Error('Invalid live base ref');
    }
    // PR base.sha may lag behind the named branch's current tip.
    const { data: ref } = await octokit.rest.git.getRef({
      ...repo,
      ref: `heads/${baseRef}`,
      ...request,
    });
    if (
      ref.object?.type !== 'commit' ||
      typeof ref.object.sha !== 'string' ||
      ref.object.sha.length !== 40 ||
      !/^[a-f0-9]{40}$/.test(ref.object.sha)
    ) {
      throw new Error('Invalid live base ref commit');
    }
    return {
      repository,
      pullNumber,
      cloneUrl: pr.base.repo.clone_url,
      headSha: pr.head.sha,
      baseSha: ref.object.sha,
      baseRef,
      ...(includeIntent ? { intent: { title: pr.title, body: pr.body ?? '' } } : {}),
      intentHash: createHash('sha256')
        .update(JSON.stringify([pr.title, pr.body ?? '']))
        .digest('hex'),
    };
  }
  async function loadState(): Promise<ReviewStateRecord | null> {
    const records = new Map<number, ReviewStateRecord>();
    for (let page = 1; ; page++) {
      if (page > 100) {
        throw new Error('Canonical review history discovery limit exceeded');
      }
      const { data, headers } = await octokit.rest.issues.listComments({
        ...repo,
        issue_number: pullNumber,
        per_page: 100,
        page,
      });
      if (!Array.isArray(data) || data.length > 100) {
        throw new Error('Invalid canonical review comments page');
      }
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
        if (!Number.isSafeInteger(comment.id) || comment.id <= 0 || records.has(comment.id)) {
          throw new Error('Duplicate or invalid canonical review comment ID');
        }
        const state = parseReviewComment(comment.body);
        associated(state);
        records.set(comment.id, { commentId: comment.id, body: comment.body, state });
      }
      if (data.length < 100 && !headers?.link?.includes('rel="next"')) {
        break;
      }
    }
    if (!records.size) {
      return null;
    }
    const revisions = new Set<number>();
    const children = new Map<number, ReviewStateRecord>();
    let root: ReviewStateRecord | null = null;
    for (const record of records.values()) {
      const parent = reviewHistoryParent(record.body);
      if (revisions.has(record.state.revision)) {
        throw new Error('Duplicate canonical review revision');
      }
      revisions.add(record.state.revision);
      if (parent === undefined || parent === null) {
        if (root || (parent === null && record.state.revision !== 1)) {
          throw new Error('Invalid canonical review history root');
        }
        root = record;
      } else {
        const predecessor = records.get(parent.commentId);
        if (
          !predecessor ||
          children.has(parent.commentId) ||
          parent.bodyHash !== createHash('sha256').update(predecessor.body).digest('hex') ||
          parent.revision !== predecessor.state.revision ||
          parent.operationKey !== predecessor.state.operationKey ||
          record.state.revision !== parent.revision + 1
        ) {
          throw new Error('Invalid canonical review history chain');
        }
        children.set(parent.commentId, record);
      }
    }
    if (!root) {
      throw new Error('Missing canonical review history root');
    }
    let head = root;
    let visited = 1;
    while (children.has(head.commentId)) {
      head = children.get(head.commentId)!;
      if (++visited > records.size) {
        throw new Error('Cyclic canonical review history');
      }
    }
    if (visited !== records.size) {
      throw new Error('Orphaned canonical review history');
    }
    return head;
  }
  const lifecycle = createReviewLifecycle(deps, loadState);
  return {
    loadState,
    workStore: createReviewWorkStore(deps, async signal => {
      await requireInstallationToken(signal);
      await live(false, signal);
    }),
    async ensureInitialized(previous, authorizeNew) {
      await requireInstallationToken();
      await live();
      await lifecycle.ensure(previous, authorizeNew);
    },
    async canInitializeFromDraft() {
      if (
        context.eventName !== 'pull_request_target' ||
        context.payload.action !== 'ready_for_review' ||
        context.runAttempt !== 1
      ) {
        return false;
      }
      try {
        const payloadPr = object(context.payload.pull_request);
        const sender = object(context.payload.sender);
        if (
          context.payload.number !== pullNumber ||
          payloadPr.number !== pullNumber ||
          payloadPr.draft !== false ||
          payloadPr.state !== 'open' ||
          object(context.payload.repository).full_name !== repository ||
          !context.actor ||
          sender.login !== context.actor ||
          !Number.isSafeInteger(sender.id) ||
          typeof payloadPr.updated_at !== 'string' ||
          !Number.isFinite(Date.parse(payloadPr.updated_at))
        ) {
          return false;
        }
        await live();
        let readyCount = 0;
        // Initial draft creation emits no conversion event; any conversion proves prior ready history.
        for (let page = 1; page <= 100; page++) {
          const { data, headers } = await octokit.rest.issues.listEventsForTimeline({
            ...repo,
            issue_number: pullNumber,
            per_page: 100,
            page,
          });
          if (!Array.isArray(data)) {
            return false;
          }
          for (const item of data) {
            const event = object(item);
            if (typeof event.event !== 'string' || !TIMELINE_EVENTS.has(event.event)) {
              return false;
            }
            if (event.event === 'converted_to_draft') {
              return false;
            }
            if (event.event === 'ready_for_review') {
              const actor = object(event.actor);
              if (
                ++readyCount !== 1 ||
                !Number.isSafeInteger(event.id) ||
                actor.id !== sender.id ||
                actor.login !== sender.login ||
                event.created_at !== payloadPr.updated_at
              ) {
                return false;
              }
            }
          }
          if (data.length < 100 && !headers?.link?.includes('rel="next"')) {
            return readyCount === 1;
          }
        }
      } catch {
        // Missing, unsupported or incomplete history cannot establish a first ready transition.
        return false;
      }
      return false;
    },
    async snapshot(previous, options) {
      await requireInstallationToken();
      if (previous) {
        associated(previous);
      }
      const { cloneUrl, ...identity } = await live(Boolean(options?.coverage));
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
      return options?.coverage
        ? prepare(identity, previous, remote.href, auth.token, options)
        : prepare(identity, previous, remote.href, auth.token);
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
      const parent = reviewHistoryParent(body);
      const expectedParent = expected ? reviewParentDescriptor(expected) : null;
      if (
        state.revision !== (expected?.state.revision ?? 0) + 1 ||
        (expectedParent
          ? parent?.commentId !== expectedParent.commentId ||
            parent.bodyHash !== expectedParent.bodyHash ||
            parent.revision !== expectedParent.revision ||
            parent.operationKey !== expectedParent.operationKey
          : parent !== null)
      ) {
        throw new Error('Published review history does not match expected predecessor');
      }
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
      await lifecycle.begin(expected, state, body);
      try {
        await octokit.rest.issues.createComment({ ...repo, issue_number: pullNumber, body });
      } catch (error) {
        // A timeout may have committed. Reconcile, but never retry/create a replacement.
        const recovered = await loadState();
        if (recovered?.state.operationKey === state.operationKey && recovered.body === body) {
          await lifecycle.finish(recovered);
          return;
        }
        await lifecycle.rollbackRejected(expected, error);
        throw error;
      }
      const written = await loadState();
      if (written?.body !== body || written.state.operationKey !== state.operationKey) {
        throw new Error('Canonical review write could not be verified (GITHUB_TOKEN required)');
      }
      await lifecycle.finish(written);
    },
  };
}
