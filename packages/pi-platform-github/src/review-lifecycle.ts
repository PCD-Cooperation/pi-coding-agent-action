import { createHash } from 'node:crypto';
import { parseReviewComment } from '@alexanderfortin/pi-orchestrator';
import type {
  ReviewInitializationPermit,
  ReviewState,
  ReviewStateRecord,
} from '@alexanderfortin/pi-orchestrator';
import type { GitHubModuleDeps } from './types';

const PREFIX = '<!-- pi-stateful-review-lifecycle:v1 -->';
const LABEL = 'pi-stateful-review:tracked-v1';
const LIMIT = 16 * 1024;
type Enrollment = Omit<ReviewInitializationPermit, 'kind'> & {
  kind: ReviewInitializationPermit['kind'] | 'adopted';
};
interface Candidate {
  bodyHash: string;
  revision: number;
  operationKey: string;
}
type Checkpoint = Candidate & { commentId: number };
interface Receipt {
  version: 1;
  repository: string;
  pullNumber: number;
  enrollment: Enrollment;
  phase: 'pending' | 'publishing' | 'committed';
  checkpoint: Checkpoint | null;
  candidate: Candidate | null;
}
interface Stored {
  commentId: number;
  body: string;
  receipt: Receipt;
}
function fail(): never {
  throw new Error(
    'Review lifecycle history missing, corrupt, changed, or ambiguous; refusing reset'
  );
}
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
  );
}
function candidate(value: unknown, checkpoint = false): boolean {
  return (
    shape(value, [...(checkpoint ? ['commentId'] : []), 'bodyHash', 'revision', 'operationKey']) &&
    typeof value.bodyHash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.bodyHash) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) > 0 &&
    typeof value.operationKey === 'string' &&
    /^[a-f0-9]{64}$/.test(value.operationKey) &&
    (!checkpoint || (Number.isSafeInteger(value.commentId) && (value.commentId as number) > 0))
  );
}
function status(error: unknown): unknown {
  return error && typeof error === 'object' && 'status' in error ? error.status : undefined;
}
function descriptor(state: ReviewState, body: string): Candidate {
  return {
    bodyHash: createHash('sha256').update(body).digest('hex'),
    revision: state.revision,
    operationKey: state.operationKey,
  };
}
function checkpoint(record: ReviewStateRecord): Checkpoint {
  return { ...descriptor(record.state, record.body), commentId: record.commentId };
}
function same(a: ReviewStateRecord | null, b: ReviewStateRecord | null): boolean {
  return a?.commentId === b?.commentId && a?.body === b?.body;
}

// GitHub has no comment CAS: cooperating callers must serialize all writers per PR.
export function createReviewLifecycle(
  deps: GitHubModuleDeps,
  loadCanonical: () => Promise<ReviewStateRecord | null>
) {
  const { octokit, context } = deps;
  const repo = context.repo;
  const issue_number = context.issue.number;
  const repository = `${repo.owner}/${repo.repo}`;
  let cached: Stored | null = null;
  let known = false;
  let initialized = false;
  let ownedPublishing: Stored | null = null;
  function encode(receipt: Receipt): string {
    const body = `${PREFIX}\n${Buffer.from(JSON.stringify(receipt)).toString('base64')}`;
    if (Buffer.byteLength(body) > LIMIT) {
      fail();
    }
    return body;
  }
  function decode(body: string): Receipt {
    if (Buffer.byteLength(body) > LIMIT || !body.startsWith(`${PREFIX}\n`)) {
      fail();
    }
    const encoded = body.slice(PREFIX.length + 1);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      fail();
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) {
      fail();
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      return fail();
    }
    if (JSON.stringify(value) !== bytes.toString('utf8')) {
      fail();
    }
    if (
      !shape(value, [
        'version',
        'repository',
        'pullNumber',
        'enrollment',
        'phase',
        'checkpoint',
        'candidate',
      ]) ||
      value.version !== 1 ||
      value.repository !== repository ||
      value.pullNumber !== issue_number ||
      !shape(value.enrollment, ['kind', 'actor', 'reason']) ||
      typeof value.enrollment.kind !== 'string' ||
      !['opened', 'first-ready', 'bootstrap', 'adopted'].includes(value.enrollment.kind) ||
      ![value.enrollment.actor, value.enrollment.reason].every(
        item => item === null || typeof item === 'string'
      ) ||
      (value.enrollment.kind === 'bootstrap' &&
        (typeof value.enrollment.actor !== 'string' ||
          !value.enrollment.actor.trim() ||
          typeof value.enrollment.reason !== 'string' ||
          !value.enrollment.reason.trim())) ||
      (value.enrollment.kind !== 'bootstrap' && value.enrollment.reason !== null) ||
      (value.enrollment.kind === 'adopted' &&
        (value.enrollment.actor !== null || value.checkpoint === null)) ||
      (value.checkpoint !== null && !candidate(value.checkpoint, true)) ||
      (value.candidate !== null && !candidate(value.candidate)) ||
      !(value.phase === 'pending'
        ? value.checkpoint === null && value.candidate === null
        : value.phase === 'committed'
          ? value.checkpoint !== null && value.candidate === null
          : value.phase === 'publishing' && value.candidate !== null)
    ) {
      fail();
    }
    return value as unknown as Receipt;
  }
  async function* discover<T>(
    read: (page: number) => Promise<{ data: T[]; headers?: { link?: string } }>
  ): AsyncGenerator<T> {
    for (let page = 1; page <= 100; page++) {
      const { data, headers } = await read(page);
      if (!Array.isArray(data) || data.length > 100) {
        fail();
      }
      yield* data;
      if (data.length < 100 && !headers?.link?.includes('rel="next"')) {
        return;
      }
    }
    fail();
  }
  async function readReceipt(): Promise<Stored | null> {
    let found: Stored | null = null;
    for await (const comment of discover(page =>
      octokit.rest.issues.listComments({ ...repo, issue_number, per_page: 100, page })
    )) {
      if (
        comment.user?.login !== 'github-actions[bot]' ||
        comment.user.type !== 'Bot' ||
        !comment.body?.startsWith(PREFIX)
      ) {
        continue;
      }
      if (found || !Number.isSafeInteger(comment.id) || comment.id <= 0) {
        fail();
      }
      found = { commentId: comment.id, body: comment.body, receipt: decode(comment.body) };
    }
    if (found) {
      known = true;
    } else if (known) {
      fail();
    }
    return found;
  }
  async function tracked(): Promise<boolean> {
    let found = false;
    for await (const label of discover(page =>
      octokit.rest.issues.listLabelsOnIssue({ ...repo, issue_number, per_page: 100, page })
    )) {
      if (!label || typeof label !== 'object' || typeof label.name !== 'string' || !label.name) {
        fail();
      }
      if (label.name.toLowerCase() === LABEL) {
        found = true;
      }
    }
    return found;
  }
  async function repairLabel(present: boolean): Promise<void> {
    if (present) {
      return;
    }
    try {
      await octokit.rest.issues.getLabel({ ...repo, name: LABEL });
    } catch (error) {
      if (status(error) !== 404) {
        throw error;
      }
      try {
        await octokit.rest.issues.createLabel({
          ...repo,
          name: LABEL,
          color: '808080',
          description: 'Persistent review enrollment; do not delete to reset history.',
        });
      } catch {
        // Label creation is idempotent; a competing create or lost response is safe to reconcile.
        await octokit.rest.issues.getLabel({ ...repo, name: LABEL });
      }
    }
    await octokit.rest.issues.addLabels({ ...repo, issue_number, labels: [LABEL] });
    if (!(await tracked())) {
      fail();
    }
  }
  function unchanged(actual: Stored | null, expected: Stored): void {
    if (actual?.commentId !== expected.commentId || actual?.body !== expected.body) {
      fail();
    }
  }
  async function write(receipt: Receipt, previous: Stored | null): Promise<Stored> {
    const body = encode(receipt);
    decode(body);
    let error: unknown;
    try {
      if (previous) {
        await octokit.rest.issues.updateComment({ ...repo, comment_id: previous.commentId, body });
      } else {
        await octokit.rest.issues.createComment({ ...repo, issue_number, body });
      }
    } catch (caught) {
      error = caught;
    }
    // An unreadable create response must never allow this instance to enroll twice.
    known = true;
    const actual = await readReceipt();
    if (actual?.body !== body || (previous && actual.commentId !== previous.commentId)) {
      if (error) {
        throw error;
      }
      return fail();
    }
    cached = actual;
    return actual;
  }
  function matches(
    record: ReviewStateRecord | null,
    target: Candidate | null,
    id?: number
  ): record is ReviewStateRecord {
    if (!record || !target || (id !== undefined && record.commentId !== id)) {
      return false;
    }
    const actual = descriptor(record.state, record.body);
    return (
      actual.bodyHash === target.bodyHash &&
      actual.revision === target.revision &&
      actual.operationKey === target.operationKey
    );
  }
  async function canonical(expected: ReviewStateRecord | null): Promise<void> {
    if (!same(await loadCanonical(), expected)) {
      fail();
    }
    if (
      expected &&
      (expected.state.snapshot.repository !== repository ||
        expected.state.snapshot.pullNumber !== issue_number)
    ) {
      fail();
    }
  }
  return {
    async ensure(
      previous: ReviewStateRecord | null,
      authorizeNew: () => Promise<ReviewInitializationPermit | null>
    ): Promise<void> {
      initialized = false;
      await canonical(previous);
      let stored = await readReceipt();
      const present = await tracked();
      if (!stored) {
        if (previous) {
          stored = await write(
            {
              version: 1,
              repository,
              pullNumber: issue_number,
              enrollment: { kind: 'adopted', actor: null, reason: null },
              phase: 'committed',
              checkpoint: checkpoint(previous),
              candidate: null,
            },
            null
          );
        } else {
          if (present) {
            fail();
          }
          const permit = await authorizeNew();
          if (!permit || !['opened', 'first-ready', 'bootstrap'].includes(permit.kind)) {
            throw new Error('Untracked legacy PR requires explicit bootstrap authorization');
          }
          stored = await write(
            {
              version: 1,
              repository,
              pullNumber: issue_number,
              enrollment: { kind: permit.kind, actor: permit.actor, reason: permit.reason },
              phase: 'pending',
              checkpoint: null,
              candidate: null,
            },
            null
          );
        }
      } else {
        const receipt = stored.receipt;
        if (receipt.phase === 'pending') {
          if (previous) {
            fail();
          }
        } else if (receipt.phase === 'committed') {
          if (!matches(previous, receipt.checkpoint, receipt.checkpoint!.commentId)) {
            fail();
          }
        } else {
          if (!matches(previous, receipt.candidate, receipt.checkpoint?.commentId)) {
            fail();
          }
          stored = await write(
            { ...receipt, phase: 'committed', checkpoint: checkpoint(previous), candidate: null },
            stored
          );
        }
      }
      await repairLabel(present);
      unchanged(await readReceipt(), stored);
      cached = stored;
      initialized = true;
    },
    async begin(
      previous: ReviewStateRecord | null,
      state: ReviewState,
      body: string
    ): Promise<void> {
      if (!initialized || !cached || cached.receipt.phase === 'publishing') {
        fail();
      }
      await canonical(previous);
      unchanged(await readReceipt(), cached);
      if (
        cached.receipt.phase === 'pending'
          ? previous !== null
          : !matches(previous, cached.receipt.checkpoint, cached.receipt.checkpoint!.commentId)
      ) {
        fail();
      }
      if (
        JSON.stringify(parseReviewComment(body)) !== JSON.stringify(state) ||
        state.snapshot.repository !== repository ||
        state.snapshot.pullNumber !== issue_number
      ) {
        fail();
      }
      ownedPublishing = await write(
        { ...cached.receipt, phase: 'publishing', candidate: descriptor(state, body) },
        cached
      );
    },
    async finish(written: ReviewStateRecord): Promise<void> {
      if (!ownedPublishing) {
        fail();
      }
      unchanged(await readReceipt(), ownedPublishing);
      await canonical(written);
      if (
        !matches(
          written,
          ownedPublishing.receipt.candidate,
          ownedPublishing.receipt.checkpoint?.commentId
        )
      ) {
        fail();
      }
      await write(
        {
          ...ownedPublishing.receipt,
          phase: 'committed',
          checkpoint: checkpoint(written),
          candidate: null,
        },
        ownedPublishing
      );
      ownedPublishing = null;
    },
    async rollbackRejected(previous: ReviewStateRecord | null, error: unknown): Promise<void> {
      if (
        !ownedPublishing ||
        ![400, 401, 403, 404, 409, 422, 429].includes(status(error) as number)
      ) {
        return;
      }
      await canonical(previous);
      unchanged(await readReceipt(), ownedPublishing);
      const receipt = ownedPublishing.receipt;
      if (
        receipt.checkpoint
          ? !matches(previous, receipt.checkpoint, receipt.checkpoint.commentId)
          : previous !== null
      ) {
        fail();
      }
      await write(
        { ...receipt, phase: receipt.checkpoint ? 'committed' : 'pending', candidate: null },
        ownedPublishing
      );
      ownedPublishing = null;
    },
  };
}
