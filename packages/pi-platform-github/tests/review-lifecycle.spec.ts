import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseReviewComment, renderReviewComment } from '@alexanderfortin/pi-orchestrator';
import type { ReviewInitializationPermit, ReviewState } from '@alexanderfortin/pi-orchestrator';
import type { GitHubModuleDeps } from '../src/types';
import { createReviewLifecycle } from '../src/review-lifecycle';
import { createStatefulReviewPlatform } from '../src/review-state';

const PREFIX = '<!-- pi-stateful-review-lifecycle:v1 -->';
const LABEL = 'pi-stateful-review:tracked-v1';
const permit: ReviewInitializationPermit = { kind: 'opened', actor: 'maintainer', reason: null };
function state(revision = 1): ReviewState {
  return {
    schemaVersion: 1,
    revision,
    snapshot: {
      repository: 'owner/repo',
      pullNumber: 1,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      mergeBaseSha: 'c'.repeat(40),
      baseRef: 'main',
      intentHash: 'd'.repeat(64),
    },
    configurationHash: 'e'.repeat(64),
    operationKey: String(revision).repeat(64),
    completedReviews: revision,
    reviewMode: 'full',
    fallbackReason: null,
    coverageNotes: 'Reviewed',
    actionableRounds: 0,
    needsHuman: false,
    nextFindingId: 1,
    findings: [],
    intervention: null,
  };
}
function comment(id: number, body: string, login = 'github-actions[bot]', type = 'Bot') {
  return { id, body, user: { login, type } };
}
function fixture() {
  const comments: ReturnType<typeof comment>[] = [];
  const labels = new Set<string>(['unrelated']);
  const registry = new Set<string>();
  const operations: string[] = [];
  let nextId = 1;
  function insert(body: string) {
    const item = comment(nextId++, body);
    comments.push(item);
    return item;
  }
  const issues = {
    listComments: vi.fn(async ({ page, per_page }: { page: number; per_page: number }) => ({
      data: comments.slice((page - 1) * per_page, page * per_page),
    })),
    createComment: vi.fn(async ({ body }: { body: string }) => {
      operations.push('receipt');
      return { data: insert(body) };
    }),
    updateComment: vi.fn(async ({ comment_id, body }: { comment_id: number; body: string }) => {
      const item = comments.find(item => item.id === comment_id);
      if (!item) {
        throw { status: 404 };
      }
      item.body = body;
      return { data: item };
    }),
    listLabelsOnIssue: vi.fn(async ({ page, per_page }: { page: number; per_page: number }) => ({
      data: [...labels].slice((page - 1) * per_page, page * per_page).map(name => ({ name })),
    })),
    getLabel: vi.fn(async ({ name }: { name: string }) => {
      if (!registry.has(name)) {
        throw { status: 404 };
      }
      return { data: { name } };
    }),
    createLabel: vi.fn(async ({ name }: { name: string }) => {
      if (registry.has(name)) {
        throw { status: 422 };
      }
      registry.add(name);
      return { data: { name } };
    }),
    addLabels: vi.fn(async ({ labels: added }: { labels: string[] }) => {
      operations.push('label');
      added.forEach(name => labels.add(name));
      return { data: [...labels].map(name => ({ name })) };
    }),
  };
  const deps = {
    context: { repo: { owner: 'owner', repo: 'repo' }, issue: { number: 1 } },
    octokit: { rest: { issues } },
  } as unknown as GitHubModuleDeps;
  const load = createStatefulReviewPlatform(deps).loadState;
  const lifecycle = () => createReviewLifecycle(deps, load);
  function receiptComment() {
    return comments.find(item => item.body.startsWith(PREFIX))!;
  }
  function receipt() {
    return JSON.parse(
      Buffer.from(receiptComment().body.slice(PREFIX.length + 1), 'base64').toString('utf8')
    );
  }
  function changeReceipt(change: (value: ReturnType<typeof receipt>) => void) {
    const value = receipt();
    change(value);
    receiptComment().body = `${PREFIX}\n${Buffer.from(JSON.stringify(value)).toString('base64')}`;
  }
  function publish(value = state()) {
    const existing = comments
      .filter(item => item.body.startsWith('<!-- pi-stateful-review:v1 -->'))
      .at(-1);
    const previous = existing
      ? { commentId: existing.id, body: existing.body, state: parseReviewComment(existing.body) }
      : null;
    const body = renderReviewComment(value, previous);
    insert(body);
  }
  return {
    comments,
    labels,
    registry,
    operations,
    issues,
    insert,
    load,
    lifecycle,
    receiptComment,
    receipt,
    changeReceipt,
    publish,
  };
}

describe('persistent review enrollment', () => {
  it('writes pending before the label, stores no cursor/model text, and retries ordinary incomplete runs', async () => {
    const f = fixture();
    const authorize = vi.fn(async () => permit);
    await f.lifecycle().ensure(null, authorize);
    expect(f.operations).toEqual(['receipt', 'label']);
    expect(f.receipt()).toEqual({
      version: 2,
      repository: 'owner/repo',
      pullNumber: 1,
      enrollment: permit,
      phase: 'pending',
      checkpoint: null,
      candidate: null,
    });
    expect(await f.load()).toBeNull();
    const ordinary = vi.fn(async () => null);
    await f.lifecycle().ensure(null, ordinary);
    await f.lifecycle().ensure(null, ordinary);
    expect(ordinary).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledOnce();
    expect(f.issues.createComment).toHaveBeenCalledOnce();
    expect(f.labels).toEqual(new Set(['unrelated', LABEL]));
  });
  it.each([false, true])(
    'recovers an exact legacy in-place publication before append migration (previous=%s)',
    async existing => {
      const f = fixture();
      if (existing) {
        f.insert(renderReviewComment(state()));
      }
      const before = await f.load();
      await f.lifecycle().ensure(before, async () => permit);
      const next = state(existing ? 2 : 1);
      const legacyBody = renderReviewComment(next);
      f.changeReceipt(value => {
        value.version = 1;
        value.phase = 'publishing';
        value.candidate = {
          bodyHash: createHash('sha256').update(legacyBody).digest('hex'),
          revision: next.revision,
          operationKey: next.operationKey,
        };
      });
      if (before) {
        f.comments.find(item => item.id === before.commentId)!.body = legacyBody;
      } else {
        f.insert(legacyBody);
      }
      const recovered = await f.load();
      const authorize = vi.fn(async () => null);
      await f.lifecycle().ensure(recovered, authorize);
      expect(f.receipt().version).toBe(2);
      expect(f.receipt().phase).toBe('committed');
      expect(f.receipt().checkpoint.commentId).toBe(recovered!.commentId);
      expect(authorize).not.toHaveBeenCalled();
      expect(
        f.comments.filter(item => item.body.startsWith('<!-- pi-stateful-review:v1 -->'))
      ).toHaveLength(1);
      expect(recovered!.body).toBe(legacyBody);
    }
  );

  it('does not recover append metadata as an unguarded legacy publishing receipt', async () => {
    const f = fixture();
    const lifecycle = f.lifecycle();
    await lifecycle.ensure(null, async () => permit);
    await lifecycle.begin(null, state(), renderReviewComment(state(), null));
    f.changeReceipt(value => {
      value.version = 1;
    });
    f.publish();
    await expect(f.lifecycle().ensure(await f.load(), async () => null)).rejects.toThrow(
      'refusing reset'
    );
  });

  it('repairs a failed label on an ordinary retry, but cannot begin before initialization completes', async () => {
    const f = fixture();
    const first = f.lifecycle();
    f.issues.addLabels.mockRejectedValueOnce(new Error('label unavailable'));
    await expect(first.ensure(null, async () => permit)).rejects.toThrow('label unavailable');
    expect(f.receipt().phase).toBe('pending');
    await expect(first.begin(null, state(), renderReviewComment(state(), null))).rejects.toThrow();
    const ordinary = vi.fn(async () => null);
    await f.lifecycle().ensure(null, ordinary);
    expect(ordinary).not.toHaveBeenCalled();
    expect(f.labels.has(LABEL)).toBe(true);
    expect(f.issues.createComment).toHaveBeenCalledOnce();
  });
  it('rejects enrollment that fits pending but cannot fit its publication intent', async () => {
    const f = fixture();
    await expect(
      f.lifecycle().ensure(null, async () => ({
        kind: 'bootstrap',
        actor: 'writer',
        reason: 'r'.repeat(11913),
      }))
    ).rejects.toThrow('publication capacity');
    expect(f.comments).toEqual([]);
    expect(f.labels).toEqual(new Set(['unrelated']));
  });

  it('reserves publication space using encoded bytes without changing enrollment', async () => {
    const f = fixture();
    const lifecycle = f.lifecycle();
    const enrollment = {
      kind: 'bootstrap' as const,
      actor: 'writer',
      reason: '\u0001'.repeat(1000),
    };
    await lifecycle.ensure(null, async () => enrollment);
    expect(Buffer.byteLength(f.receiptComment().body)).toBeLessThanOrEqual(16 * 1024);
    const next = state();
    await lifecycle.begin(null, next, renderReviewComment(next, null));
    expect(Buffer.byteLength(f.receiptComment().body)).toBeLessThanOrEqual(16 * 1024);
    f.publish(next);
    await lifecycle.finish((await f.load())!);
    expect(Buffer.byteLength(f.receiptComment().body)).toBeLessThanOrEqual(16 * 1024);
    expect(f.receipt().enrollment).toEqual(enrollment);
    expect(f.receipt().phase).toBe('committed');
  });

  it('requires one explicit bootstrap for untracked legacy PRs, never blind absence enrollment', async () => {
    const f = fixture();
    await expect(f.lifecycle().ensure(null, async () => null)).rejects.toThrow('bootstrap');
    expect(f.comments).toEqual([]);
    await f
      .lifecycle()
      .ensure(null, async () => ({ kind: 'bootstrap', actor: 'writer', reason: 'enroll legacy' }));
    expect(f.receipt().enrollment.kind).toBe('bootstrap');
    await f.lifecycle().ensure(null, async () => {
      throw new Error('must be lazy');
    });
  });
  it('adopts exact existing state including pause/counters without needing a permit even with a marker label', async () => {
    const f = fixture();
    const paused = state(9);
    paused.needsHuman = true;
    paused.actionableRounds = 3;
    paused.nextFindingId = 12;
    f.insert(renderReviewComment(paused));
    const previous = await f.load();
    f.labels.add(LABEL);
    const authorize = vi.fn(async () => null);
    await f.lifecycle().ensure(previous, authorize);
    expect(authorize).not.toHaveBeenCalled();
    expect(await f.load()).toEqual(previous);
    expect(f.receipt()).toMatchObject({
      phase: 'committed',
      enrollment: { kind: 'adopted' },
      checkpoint: { commentId: previous!.commentId, revision: 9 },
    });
    f.labels.delete(LABEL);
    await f.lifecycle().ensure(previous, authorize);
    expect(f.labels.has(LABEL)).toBe(true);
  });
  it.each([
    { kind: ['opened'], actor: 'writer', reason: null },
    { kind: 'bootstrap', actor: null, reason: 'enroll' },
    { kind: 'bootstrap', actor: 'writer', reason: null },
    { kind: 'bootstrap', actor: 'writer', reason: '  ' },
    { kind: 'adopted', actor: null, reason: null },
    { kind: 'opened', actor: 'writer', reason: 'unexpected override' },
  ])('rejects impossible pending enrollment provenance: %j', async enrollment => {
    const f = fixture();
    await f.lifecycle().ensure(null, async () => permit);
    f.changeReceipt(value => {
      value.enrollment = enrollment;
    });
    const authorize = vi.fn(async () => permit);
    await expect(f.lifecycle().ensure(null, authorize)).rejects.toThrow('history');
    expect(authorize).not.toHaveBeenCalled();
    expect(await f.load()).toBeNull();
  });

  it('refuses stale callers before any enrollment write', async () => {
    const f = fixture();
    f.publish();
    await expect(f.lifecycle().ensure(null, async () => permit)).rejects.toThrow();
    expect(f.issues.createComment).not.toHaveBeenCalled();
  });
  it('ignores quoted lifecycle markers in canonical bot evidence and bot prose', async () => {
    const f = fixture();
    f.publish();
    f.comments[0]!.body = f.comments[0]!.body.replace(
      '## Notes',
      `## Notes\nHuman evidence quoted: \`${PREFIX}\``
    );
    f.insert(`Earlier bot prose quoted: ${PREFIX}`);
    const previous = await f.load();
    await f.lifecycle().ensure(previous, async () => null);
    const stored = f.receiptComment().body;
    await f.lifecycle().ensure(previous, async () => null);
    expect(f.receiptComment().body).toBe(stored);
    expect(f.receipt().phase).toBe('committed');
    expect(await f.load()).toEqual(previous);
    expect(f.issues.createComment).toHaveBeenCalledOnce();
  });
  it('recognizes an uppercase label-only history witness and refuses even bootstrap enrollment', async () => {
    const f = fixture();
    f.labels.add(LABEL.toUpperCase());
    const authorize = vi.fn(async () => ({ ...permit, kind: 'bootstrap' as const }));
    await expect(f.lifecycle().ensure(null, authorize)).rejects.toThrow();
    expect(authorize).not.toHaveBeenCalled();
    expect(f.comments).toEqual([]);
    expect(f.issues.createComment).not.toHaveBeenCalled();
  });
  it.each([null, {}, { name: null }, { name: 17 }, { name: '' }])(
    'fails closed on malformed label data %j rather than enrolling',
    async label => {
      const f = fixture();
      f.issues.listLabelsOnIssue.mockResolvedValueOnce({ data: [label] } as never);
      const authorize = vi.fn(async () => permit);
      await expect(f.lifecycle().ensure(null, authorize)).rejects.toThrow();
      expect(authorize).not.toHaveBeenCalled();
      expect(f.issues.createComment).not.toHaveBeenCalled();
    }
  );
  it('ignores human spoof receipts but refuses duplicate trusted receipts', async () => {
    const f = fixture();
    f.comments.push(comment(900, `${PREFIX}\nbroken`, 'human', 'User'));
    await f.lifecycle().ensure(null, async () => permit);
    const trusted = f.comments.find(item => item.user.type === 'Bot')!;
    f.comments.push({ ...trusted, id: 901 });
    await expect(f.lifecycle().ensure(null, async () => permit)).rejects.toThrow();
  });
  it.each([
    'deleted receipt',
    'corrupt',
    'association',
    'unknown version',
    'extra keys',
    'oversized',
  ])('fails closed on %s even for bootstrap', async change => {
    const f = fixture();
    await f.lifecycle().ensure(null, async () => permit);
    if (change === 'deleted receipt') {
      f.comments.length = 0;
    }
    if (change === 'corrupt') {
      f.receiptComment().body = `${PREFIX}\nnot base64`;
    }
    if (change === 'association') {
      f.changeReceipt(value => {
        value.pullNumber = 2;
      });
    }
    if (change === 'unknown version') {
      f.changeReceipt(value => {
        value.version = 3;
      });
    }
    if (change === 'extra keys') {
      f.changeReceipt(value => {
        value.cursor = 'must not exist';
      });
    }
    if (change === 'oversized') {
      f.receiptComment().body = `${PREFIX}\n${'a'.repeat(17000)}`;
    }
    const authorize = vi.fn(async () => ({ ...permit, kind: 'bootstrap' as const }));
    await expect(f.lifecycle().ensure(null, authorize)).rejects.toThrow();
    expect(authorize).not.toHaveBeenCalled();
  });
  it('never recreates a receipt lost after this instance observed enrollment, even with a canonical', async () => {
    const f = fixture();
    const lifecycle = f.lifecycle();
    await lifecycle.ensure(null, async () => permit);
    f.comments.length = 0;
    f.labels.delete(LABEL);
    f.publish();
    await expect(lifecycle.ensure(await f.load(), async () => permit)).rejects.toThrow();
  });
  it('paginates both comments and labels including a short page with a next link', async () => {
    const f = fixture();
    await f.lifecycle().ensure(null, async () => permit);
    const saved = f.comments.splice(0);
    for (let i = 0; i < 200; i++) {
      f.comments.push(comment(1000 + i, 'ordinary', 'human', 'User'));
    }
    f.comments.push(...saved);
    for (let i = 0; i < 200; i++) {
      f.labels.add(`label-${i}`);
    }
    f.labels.delete(LABEL);
    f.labels.add(LABEL);
    f.issues.listLabelsOnIssue.mockResolvedValueOnce({
      data: [],
      headers: { link: '<next>; rel="next"' },
    } as never);
    await f.lifecycle().ensure(null, async () => {
      throw new Error('not new');
    });
    expect(f.issues.listComments.mock.calls.at(-1)?.[0].page).toBe(3);
    expect(f.issues.listLabelsOnIssue.mock.calls.at(-1)?.[0].page).toBe(3);
  });
  it.each(['comments', 'labels'])(
    'fails closed at the 100-page %s discovery bound without automatic enrollment',
    async kind => {
      const f = fixture();
      for (let i = 0; i < 10000; i++) {
        if (kind === 'comments') {
          f.comments.push(comment(1000 + i, 'ordinary', 'human', 'User'));
        } else {
          f.labels.add(`label-${i}`);
        }
      }
      const authorize = vi.fn(async () => permit);
      await expect(f.lifecycle().ensure(null, authorize)).rejects.toThrow();
      const requests = kind === 'comments' ? f.issues.listComments : f.issues.listLabelsOnIssue;
      expect(requests).toHaveBeenCalledTimes(100);
      expect(requests.mock.calls.at(-1)?.[0].page).toBe(100);
      expect(authorize).not.toHaveBeenCalled();
      expect(f.issues.createComment).not.toHaveBeenCalled();
    }
  );
  it('scans beyond a found receipt to reject a duplicate on a later page', async () => {
    const f = fixture();
    await f.lifecycle().ensure(null, async () => permit);
    const original = f.receiptComment();
    for (let i = 0; i < 100; i++) {
      f.comments.push(comment(1000 + i, 'ordinary', 'human', 'User'));
    }
    f.comments.push({ ...original, id: 2000 });
    f.issues.listComments.mockClear();
    await expect(f.lifecycle().ensure(null, async () => permit)).rejects.toThrow();
    expect(f.issues.listComments).toHaveBeenCalledTimes(4);
    expect(f.issues.createComment).toHaveBeenCalledOnce();
  });
  it.each(['comments', 'labels'])(
    'rejects malformed %s pages without automatic enrollment',
    async kind => {
      const f = fixture();
      const requests = kind === 'comments' ? f.issues.listComments : f.issues.listLabelsOnIssue;
      requests.mockResolvedValueOnce({ data: null } as never);
      const authorize = vi.fn(async () => permit);
      await expect(f.lifecycle().ensure(null, authorize)).rejects.toThrow();
      expect(authorize).not.toHaveBeenCalled();
      expect(f.issues.createComment).not.toHaveBeenCalled();
    }
  );
  it.each(['comments', 'labels', 'later-page'])(
    'does not interpret failed %s discovery as absence',
    async failure => {
      const f = fixture();
      const unavailable = new Error('read unavailable');
      if (failure === 'comments') {
        f.issues.listComments.mockRejectedValueOnce(unavailable);
      }
      if (failure === 'labels') {
        f.issues.listLabelsOnIssue.mockRejectedValueOnce(unavailable);
      }
      if (failure === 'later-page') {
        f.issues.listComments
          .mockResolvedValueOnce({
            data: Array.from({ length: 100 }, (_, id) => comment(id, 'ordinary')),
          })
          .mockRejectedValueOnce(unavailable);
      }
      const authorize = vi.fn(async () => permit);
      await expect(f.lifecycle().ensure(null, authorize)).rejects.toThrow('read unavailable');
      expect(authorize).not.toHaveBeenCalled();
      expect(f.comments).toEqual([]);
    }
  );
});

describe('publication intent and recovery', () => {
  it('repairs a failed child seal using its predecessor checkpoint, never the old comment ID', async () => {
    const f = fixture();
    f.publish();
    const previous = (await f.load())!;
    const lifecycle = f.lifecycle();
    await lifecycle.ensure(previous, async () => null);
    const next = state(2);
    await lifecycle.begin(previous, next, renderReviewComment(next, previous));
    f.publish(next);
    const written = (await f.load())!;
    expect(written.commentId).not.toBe(previous.commentId);
    f.issues.updateComment.mockRejectedValueOnce(new Error('seal unavailable'));
    await expect(lifecycle.finish(written)).rejects.toThrow('seal unavailable');
    expect(f.receipt().checkpoint.commentId).toBe(previous.commentId);
    expect(f.receipt().phase).toBe('publishing');
    await f.lifecycle().ensure(written, async () => null);
    expect(f.receipt().checkpoint.commentId).toBe(written.commentId);
    expect(f.receipt().phase).toBe('committed');
    expect(f.comments.find(item => item.id === previous.commentId)?.body).toBe(previous.body);
  });
  it.each([false, true])(
    'seals exact candidate after a crash (existing checkpoint: %s)',
    async existing => {
      const f = fixture();
      if (existing) {
        f.publish();
      }
      const previous = await f.load();
      const lifecycle = f.lifecycle();
      await lifecycle.ensure(previous, async () => permit);
      const enrollment = f.receipt().enrollment;
      const next = state(existing ? 2 : 1);
      await lifecycle.begin(previous, next, renderReviewComment(next, previous));
      expect(f.receipt().phase).toBe('publishing');
      expect(await f.load()).toEqual(previous);
      f.publish(next);
      await f.lifecycle().ensure(await f.load(), async () => {
        throw new Error('not new');
      });
      expect(f.receipt()).toMatchObject({
        phase: 'committed',
        candidate: null,
        enrollment,
        checkpoint: { revision: next.revision, commentId: (await f.load())!.commentId },
      });
      expect((await f.load())!.state.completedReviews).toBe(next.completedReviews);
    }
  );
  it('requires initialization and detects canonical/receipt changes before beginning', async () => {
    const f = fixture();
    const lifecycle = f.lifecycle();
    await expect(
      lifecycle.begin(null, state(), renderReviewComment(state(), null))
    ).rejects.toThrow();
    await lifecycle.ensure(null, async () => permit);
    f.changeReceipt(value => {
      value.enrollment.actor = 'changed';
    });
    await expect(
      lifecycle.begin(null, state(), renderReviewComment(state(), null))
    ).rejects.toThrow();
    expect(f.receipt().phase).toBe('pending');
    await f.lifecycle().ensure(null, async () => permit);
    f.publish();
    await expect(
      lifecycle.begin(null, state(), renderReviewComment(state(), null))
    ).rejects.toThrow();
  });
  it('rejects a forged finish readback and a mismatched committed checkpoint', async () => {
    const f = fixture();
    const lifecycle = f.lifecycle();
    await lifecycle.ensure(null, async () => permit);
    await lifecycle.begin(null, state(), renderReviewComment(state(), null));
    const forged = state();
    forged.coverageNotes = 'Unexpected candidate body';
    f.publish(forged);
    await expect(lifecycle.finish((await f.load())!)).rejects.toThrow();
    expect(f.receipt().phase).toBe('publishing');
    f.comments.pop();
    f.publish();
    await lifecycle.finish((await f.load())!);
    f.publish(state(2));
    await expect(f.lifecycle().ensure(await f.load(), async () => permit)).rejects.toThrow();
  });
  it('verifies canonical readback and its own committed receipt', async () => {
    const f = fixture();
    const lifecycle = f.lifecycle();
    await lifecycle.ensure(null, async () => permit);
    await lifecycle.begin(null, state(), renderReviewComment(state(), null));
    f.publish();
    await lifecycle.finish((await f.load())!);
    expect(f.receipt()).toMatchObject({ phase: 'committed', candidate: null });
    f.comments.splice(
      f.comments.findIndex(item => item.body.startsWith('<!-- pi-stateful-review:v1 -->')),
      1
    );
    await expect(f.lifecycle().ensure(null, async () => permit)).rejects.toThrow();
  });
  it.each(['missing', 'different body', 'different id'])(
    'never accepts %s canonical for a publishing intent',
    async mismatch => {
      const f = fixture();
      f.publish();
      const previous = await f.load();
      const lifecycle = f.lifecycle();
      await lifecycle.ensure(previous, async () => permit);
      const next = state(2);
      await lifecycle.begin(previous, next, renderReviewComment(next, previous));
      if (mismatch === 'missing') {
        f.comments.splice(
          f.comments.findIndex(item => item.id === previous!.commentId),
          1
        );
      } else {
        f.publish(mismatch === 'different body' ? state(3) : next);
        if (mismatch === 'different id') {
          f.comments.find(item => item.id === previous!.commentId)!.id = 999;
        }
      }
      await expect(
        (async () => f.lifecycle().ensure(await f.load(), async () => permit))()
      ).rejects.toThrow();
      expect(f.receipt().phase).toBe('publishing');
    }
  );
  it.each([400, 401, 403, 404, 409, 422, 429])(
    'rolls back authoritative %s to pending and permits an ordinary retry',
    async status => {
      const f = fixture();
      const lifecycle = f.lifecycle();
      await lifecycle.ensure(null, async () => permit);
      await lifecycle.begin(null, state(), renderReviewComment(state(), null));
      await lifecycle.rollbackRejected(null, { status });
      expect(f.receipt()).toMatchObject({ phase: 'pending', candidate: null, checkpoint: null });
      const retry = f.lifecycle();
      await retry.ensure(null, async () => {
        throw new Error('not new');
      });
      await retry.begin(null, state(), renderReviewComment(state(), null));
      f.publish();
      await retry.finish((await f.load())!);
      expect(f.receipt().phase).toBe('committed');
    }
  );
  it('rolls back to the exact previous committed checkpoint without changing enrollment or state', async () => {
    const f = fixture();
    f.publish();
    const previous = await f.load();
    const lifecycle = f.lifecycle();
    await lifecycle.ensure(previous, async () => permit);
    const before = f.receipt();
    await lifecycle.begin(previous, state(2), renderReviewComment(state(2), previous));
    await lifecycle.rollbackRejected(previous, { status: 422 });
    expect(f.receipt()).toEqual(before);
    expect(await f.load()).toEqual(previous);
  });
  it.each([undefined, 500, 502, 503, '403'])(
    'leaves ambiguous status %s publishing, blocking ordinary and bootstrap resets',
    async status => {
      const f = fixture();
      const lifecycle = f.lifecycle();
      await lifecycle.ensure(null, async () => permit);
      await lifecycle.begin(null, state(), renderReviewComment(state(), null));
      await lifecycle.rollbackRejected(null, { status, message: 'timeout' });
      expect(f.receipt().phase).toBe('publishing');
      expect(await f.load()).toBeNull();
      await expect(f.lifecycle().ensure(null, async () => permit)).rejects.toThrow();
    }
  );
  it('cannot rollback if canonical changed or another receipt intent replaced its own', async () => {
    const f = fixture();
    const lifecycle = f.lifecycle();
    await lifecycle.ensure(null, async () => permit);
    await lifecycle.begin(null, state(), renderReviewComment(state(), null));
    f.publish();
    await expect(lifecycle.rollbackRejected(null, { status: 403 })).rejects.toThrow();
    f.comments.splice(
      f.comments.findIndex(item => item.body.startsWith('<!-- pi-stateful-review:v1 -->')),
      1
    );
    f.changeReceipt(value => {
      value.candidate.operationKey = 'a'.repeat(64);
    });
    await expect(lifecycle.rollbackRejected(null, { status: 403 })).rejects.toThrow();
    expect(f.receipt().phase).toBe('publishing');
  });
  it('reconciles a receipt create timeout only through exact trusted persistent readback', async () => {
    const f = fixture();
    f.issues.createComment.mockImplementationOnce(async ({ body }) => {
      f.insert(body);
      throw new Error('timeout after commit');
    });
    await f.lifecycle().ensure(null, async () => permit);
    expect(f.receipt().phase).toBe('pending');
    expect(f.issues.createComment).toHaveBeenCalledOnce();
  });
  it('does not recreate enrollment after an ambiguous initial receipt write and subsequent deletion', async () => {
    const f = fixture();
    const lifecycle = f.lifecycle();
    f.issues.createComment.mockImplementationOnce(async ({ body }) => {
      f.insert(body);
      f.issues.listComments.mockRejectedValueOnce(new Error('readback unavailable'));
      throw new Error('timeout');
    });
    await expect(lifecycle.ensure(null, async () => permit)).rejects.toThrow(
      'readback unavailable'
    );
    f.comments.length = 0;
    await expect(lifecycle.ensure(null, async () => permit)).rejects.toThrow();
    expect(f.issues.createComment).toHaveBeenCalledOnce();
  });
  it('leaves applied publishing intent ambiguous when receipt readback fails, never resets it', async () => {
    const f = fixture();
    const lifecycle = f.lifecycle();
    await lifecycle.ensure(null, async () => permit);
    f.issues.updateComment.mockImplementationOnce(async ({ body, comment_id }) => {
      f.comments.find(item => item.id === comment_id)!.body = body;
      f.issues.listComments.mockRejectedValueOnce(new Error('readback unavailable'));
      throw new Error('timeout');
    });
    await expect(
      lifecycle.begin(null, state(), renderReviewComment(state(), null))
    ).rejects.toThrow('readback unavailable');
    await lifecycle.rollbackRejected(null, { status: 403 });
    expect(f.receipt().phase).toBe('publishing');
    await expect(f.lifecycle().ensure(null, async () => permit)).rejects.toThrow();
  });
});
