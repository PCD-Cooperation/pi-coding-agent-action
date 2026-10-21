import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  ReviewWorkData,
  ReviewWorkEntry,
  ReviewWorkRecord,
  ReviewWorkState,
} from '@alexanderfortin/pi-orchestrator';
import { createReviewWorkStore } from '../src/review-work';
import type { GitHubModuleDeps } from '../src/types';

const PREFIX = '<!-- pi-stateful-review-work:v1 -->';
const BLOB = '<!-- pi-stateful-review-work-evidence:v1 -->';
const LABEL = 'pi-stateful-review:coverage-v1';
const API_CALLS = 2500;
function hash(text: string | number): string {
  return createHash('sha256').update(String(text)).digest('hex');
}
function unit(id = 1, assessment = 'Reviewed'): ReviewWorkEntry {
  return {
    id: hash(id),
    kind: 'unit',
    status: 'reviewed',
    attempts: 1,
    data: {
      kind: 'unit',
      result: {
        unitId: hash(id),
        status: 'reviewed',
        coveredSpanIds: [hash(`span-${id}`)],
        reconciledFindingIds: [],
        assessment,
        limitations: [],
        findings: [],
        followUps: [],
      },
    },
  };
}
function fullSizeUnit(
  id: number,
  attempt = 1,
  status: 'partial' | 'reviewed' = 'reviewed'
): ReviewWorkEntry {
  const entry = unit(id, '');
  entry.attempts = attempt;
  entry.status = status;
  const result = (entry.data as Extract<ReviewWorkData, { kind: 'unit' }>).result;
  result.status = status;
  result.coveredSpanIds = Array.from({ length: 24 }, (_, index) => hash(`span-${id}-${index}`));
  result.limitations =
    status === 'partial' ? ['First attempt needs additional pinned source evidence.'] : [];
  const available = 6 * 1024 - Buffer.byteLength(JSON.stringify(result));
  result.assessment = 'é'.repeat(Math.floor(available / 2)) + 'x'.repeat(available % 2);
  return entry;
}
function state(entries = [unit()], revision = 1): ReviewWorkState {
  return {
    version: 1,
    fingerprint: hash('generation'),
    revision,
    phase: 'collecting',
    reviewHash: null,
    entries,
  };
}
interface Comment {
  id: number;
  body: string;
  user: { login: string; type: string };
  issue_url: string;
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function payload(body: string) {
  const encoded = /pi-review-work-payload:([A-Za-z0-9+/=]+) -->$/.exec(body)![1]!;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}
function rewrite(comment: Comment, mutate: (value: ReturnType<typeof payload>) => void) {
  const value = payload(comment.body);
  mutate(value);
  comment.body = comment.body.replace(
    /pi-review-work-payload:[A-Za-z0-9+/=]+ -->$/,
    `pi-review-work-payload:${Buffer.from(JSON.stringify(value)).toString('base64')} -->`
  );
}
type RequestParams<T> = T & { request: { timeout: number; signal?: AbortSignal } };
function fixture() {
  const comments: Comment[] = [];
  const labels = new Set<string>();
  const registry = new Set<string>();
  const operations: string[] = [];
  let nextId = 1;
  function insert(body: string, login = 'github-actions[bot]', type = 'Bot'): Comment {
    const comment = {
      id: nextId++,
      body,
      user: { login, type },
      issue_url: 'https://api.github.com/repos/owner/repo/issues/1',
    };
    comments.push(comment);
    return comment;
  }
  const issues = {
    listComments: vi.fn(
      async ({ page, per_page }: RequestParams<{ page: number; per_page: number }>) => ({
        data: copy(comments.slice((page - 1) * per_page, page * per_page)),
      })
    ),
    getComment: vi.fn(async ({ comment_id }: RequestParams<{ comment_id: number }>) => {
      const item = comments.find(comment => comment.id === comment_id);
      if (!item) {
        throw Object.assign(new Error('missing comment'), { status: 404 });
      }
      return { data: copy(item) };
    }),
    createComment: vi.fn(async ({ body }: RequestParams<{ body: string }>) => {
      if (Buffer.byteLength(body) > 60000) {
        throw new Error('GitHub comment size exceeded');
      }
      operations.push(body.startsWith(PREFIX) ? 'manifest' : 'blob');
      return { data: copy(insert(body)) };
    }),
    updateComment: vi.fn(
      async ({ comment_id, body }: RequestParams<{ comment_id: number; body: string }>) => {
        const item = comments.find(comment => comment.id === comment_id);
        if (!item) {
          throw Object.assign(new Error('missing comment'), { status: 404 });
        }
        if (Buffer.byteLength(body) > 60000) {
          throw new Error('GitHub comment size exceeded');
        }
        operations.push('update');
        item.body = body;
        return { data: copy(item) };
      }
    ),
    listLabelsOnIssue: vi.fn(
      async ({ page, per_page }: RequestParams<{ page: number; per_page: number }>) => ({
        data: [...labels].slice((page - 1) * per_page, page * per_page).map(name => ({ name })),
      })
    ),
    getLabel: vi.fn(async ({ name }: RequestParams<{ name: string }>) => {
      if (![...registry].some(item => item.toLowerCase() === name.toLowerCase())) {
        throw Object.assign(new Error('missing label'), { status: 404 });
      }
      return { data: { name } };
    }),
    createLabel: vi.fn(async ({ name }: RequestParams<{ name: string }>) => {
      registry.add(name);
      return { data: { name } };
    }),
    addLabels: vi.fn(async ({ labels: added }: RequestParams<{ labels: string[] }>) => {
      operations.push('label');
      added.forEach(name => labels.add(name));
      return { data: [...labels].map(name => ({ name })) };
    }),
  };
  const deps = {
    context: { repo: { owner: 'owner', repo: 'repo' }, issue: { number: 1 } },
    octokit: { rest: { issues } },
  } as unknown as GitHubModuleDeps;
  const eligible = vi.fn(async (_signal?: AbortSignal) => {});
  const store = () => createReviewWorkStore(deps, eligible);
  const manifest = () =>
    comments.find(comment => comment.user.type === 'Bot' && comment.body.startsWith(PREFIX))!;
  const blobs = () => comments.filter(comment => comment.body.startsWith(BLOB));
  const apiCalls = () => Object.values(issues).reduce((sum, api) => sum + api.mock.calls.length, 0);
  return {
    comments,
    labels,
    registry,
    operations,
    insert,
    issues,
    deps,
    eligible,
    store,
    manifest,
    blobs,
    apiCalls,
  };
}

function assertRequestOptions(f: ReturnType<typeof fixture>, signal?: AbortSignal) {
  for (const endpoint of Object.values(f.issues)) {
    for (const [args] of endpoint.mock.calls) {
      expect(args.request).toEqual({ timeout: 15000, ...(signal ? { signal } : {}) });
      expect(args.request.signal).toBe(signal);
    }
  }
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}

describe('review work request cancellation', () => {
  it.each([false, true])(
    'sets a 15-second timeout on every endpoint and propagates eligibility/request signals (signal supplied: %s)',
    async supplied => {
      const f = fixture();
      const store = f.store();
      const signal = supplied ? new AbortController().signal : undefined;
      expect(await store.load(signal)).toBeNull();
      const first = await store.save(null, state([unit(1, 'x'.repeat(20000))]), signal);
      const second = await store.save(first, state([unit(1, 'x'.repeat(20000))], 2), signal);
      expect(await store.load(signal)).toEqual(second);
      expect(Object.values(f.issues).every(endpoint => endpoint.mock.calls.length > 0)).toBe(true);
      assertRequestOptions(f, signal);
      expect(f.eligible.mock.calls.every(([passed]) => passed === signal)).toBe(true);
      expect(Object.keys(f.deps.octokit)).toEqual(['rest']);
    }
  );

  it('does not multiply eligibility RPCs for every progress checkpoint but refreshes them on publication loads', async () => {
    const f = fixture();
    const store = f.store();
    await store.load();
    const first = await store.save(null, state([unit()]));
    const second = await store.save(first, state([unit()], 2));
    expect(f.eligible).toHaveBeenCalledOnce();
    expect(await store.load()).toEqual(second);
    expect(f.eligible).toHaveBeenCalledTimes(2);
    const calls = f.apiCalls();
    f.eligible.mockRejectedValue(new Error('PR is no longer eligible'));
    await expect(store.load()).rejects.toThrow('no longer eligible');
    await expect(store.save(second, state([unit()], 3))).rejects.toThrow('no longer eligible');
    expect(f.apiCalls()).toBe(calls);
    expect(f.manifest().body).toBe(second.body);
  });

  it('rejects already-aborted operations before eligibility or network calls', async () => {
    const f = fixture();
    const store = f.store();
    const controller = new AbortController();
    const reason = new Error('absolute review deadline');
    controller.abort(reason);
    await expect(store.load(controller.signal)).rejects.toBe(reason);
    await expect(store.save(null, state(), controller.signal)).rejects.toBe(reason);
    expect(f.eligible).not.toHaveBeenCalled();
    expect(f.apiCalls()).toBe(0);
  });

  it('checks cancellation again after eligibility settles, without starting discovery or writes', async () => {
    const f = fixture();
    const store = f.store();
    const controller = new AbortController();
    const reason = new Error('eligibility exceeded deadline');
    f.eligible.mockImplementationOnce(async signal => {
      expect(signal).toBe(controller.signal);
      controller.abort(reason);
    });
    await expect(store.save(null, state(), controller.signal)).rejects.toBe(reason);
    expect(f.apiCalls()).toBe(0);
    expect(f.comments).toEqual([]);
  });

  it.each([false, true])(
    'checks cancellation after a discovery request resolves or rejects, without continuing pagination (transport rejects: %s)',
    async rejects => {
      const f = fixture();
      const controller = new AbortController();
      const reason = new Error('discovery exceeded deadline');
      f.issues.listComments.mockImplementationOnce(async ({ request }) => {
        expect(request.signal).toBe(controller.signal);
        controller.abort(reason);
        if (rejects) {
          throw new Error('unrelated transport failure');
        }
        return { data: [], headers: { link: '<next>; rel="next"' } };
      });
      await expect(f.store().load(controller.signal)).rejects.toBe(reason);
      expect(f.apiCalls()).toBe(1);
      expect(f.issues.listLabelsOnIssue).not.toHaveBeenCalled();
      expect(f.issues.createComment).not.toHaveBeenCalled();
      assertRequestOptions(f, controller.signal);
    }
  );

  it('passes a live abort signal to a pending transport rather than only racing its result', async () => {
    const f = fixture();
    const controller = new AbortController();
    const entered = gate();
    const reason = new Error('deadline canceled the pending transport');
    f.issues.listComments.mockImplementationOnce(
      ({ request }) =>
        new Promise((_resolve, reject) => {
          request.signal!.addEventListener('abort', () => reject(request.signal!.reason), {
            once: true,
          });
          entered.release();
        })
    );
    const pending = f.store().load(controller.signal);
    await entered.promise;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(f.apiCalls()).toBe(1);
    assertRequestOptions(f, controller.signal);
  });

  it('does not skip remaining fresh evidence verification and return a record when its first blob read is aborted', async () => {
    const f = fixture();
    const first = await f.store().save(null, state([unit(1, 'x'.repeat(30000))]));
    const controller = new AbortController();
    const reason = new Error('fresh evidence read exceeded deadline');
    const before = f.apiCalls();
    const beforeReads = f.issues.getComment.mock.calls.length;
    f.issues.getComment.mockImplementationOnce(async ({ comment_id }) => {
      const comment = f.comments.find(comment => comment.id === comment_id)!;
      controller.abort(reason);
      return { data: copy(comment) };
    });
    await expect(f.store().load(controller.signal)).rejects.toBe(reason);
    expect(f.apiCalls()).toBe(before + 3);
    expect(f.issues.getComment).toHaveBeenCalledTimes(beforeReads + 1);
    expect(await f.store().load()).toEqual(first);
  });

  it('stops after an aborted blob write without requesting reconciliation, another chunk, or manifest CAS', async () => {
    const f = fixture();
    const store = f.store();
    const first = await store.save(null, state());
    const controller = new AbortController();
    const reason = new Error('blob write exceeded deadline');
    const before = f.apiCalls();
    f.issues.createComment.mockImplementationOnce(async ({ body, request }) => {
      expect(request.signal).toBe(controller.signal);
      const committed = f.insert(body);
      controller.abort(reason);
      return { data: copy(committed) };
    });
    await expect(
      store.save(first, state([unit(1, 'x'.repeat(30000))], 2), controller.signal)
    ).rejects.toBe(reason);
    expect(f.apiCalls()).toBe(before + 1);
    expect(f.blobs()).toHaveLength(1);
    expect(f.manifest().body).toBe(first.body);
    expect(f.issues.updateComment).not.toHaveBeenCalled();
    expect(await store.load(new AbortController().signal)).toEqual(first);
    const afterLoad = f.apiCalls();
    await expect(
      store.save(first, state([unit()], 2), new AbortController().signal)
    ).rejects.toThrow('history');
    expect(f.apiCalls()).toBe(afterLoad);
  });

  it('does not reconcile or attach a witness when initial manifest creation is aborted after commit', async () => {
    const f = fixture();
    const controller = new AbortController();
    const reason = new Error('manifest create exceeded deadline');
    f.issues.createComment.mockImplementationOnce(async ({ body }) => {
      const committed = f.insert(body);
      controller.abort(reason);
      throw new Error(`lost response for comment ${committed.id}`);
    });
    const store = f.store();
    await expect(store.save(null, state(), controller.signal)).rejects.toBe(reason);
    expect(f.comments).toHaveLength(1);
    expect(f.apiCalls()).toBe(3);
    expect(f.issues.getComment).not.toHaveBeenCalled();
    expect(f.issues.createLabel).not.toHaveBeenCalled();
    expect(f.issues.addLabels).not.toHaveBeenCalled();
    assertRequestOptions(f, controller.signal);
    await expect(store.save(null, state(), new AbortController().signal)).rejects.toThrow(
      'history'
    );
    expect(f.issues.createComment).toHaveBeenCalledOnce();
  });

  it('prevents readback and every later write after an aborted manifest update, without undoing committed history', async () => {
    const f = fixture();
    const store = f.store();
    const first = await store.save(null, state());
    const controller = new AbortController();
    const reason = new Error('manifest update exceeded deadline');
    const before = f.apiCalls();
    const next = state([unit(1, 'New durable evidence')], 2);
    f.issues.updateComment.mockImplementationOnce(async ({ body, comment_id, request }) => {
      expect(request.signal).toBe(controller.signal);
      f.comments.find(comment => comment.id === comment_id)!.body = body;
      controller.abort(reason);
      return { data: copy(f.manifest()) };
    });
    await expect(store.save(first, next, controller.signal)).rejects.toBe(reason);
    expect(f.apiCalls()).toBe(before + 2);
    expect(f.issues.updateComment).toHaveBeenCalledOnce();
    const committed = await f.store().load();
    expect(committed!.state).toEqual(next);
    const afterRead = f.apiCalls();
    await expect(
      store.save(committed, state([unit()], 3), new AbortController().signal)
    ).rejects.toThrow('history');
    expect(f.apiCalls()).toBe(afterRead);
  });

  it('does not reconcile label creation or attach a witness after its request is aborted', async () => {
    const f = fixture();
    const controller = new AbortController();
    const reason = new Error('label creation exceeded deadline');
    f.issues.createLabel.mockImplementationOnce(async ({ name }) => {
      f.registry.add(name);
      controller.abort(reason);
      throw new Error('lost label create response');
    });
    await expect(f.store().save(null, state(), controller.signal)).rejects.toBe(reason);
    expect(f.comments).toHaveLength(1);
    expect(f.labels.size).toBe(0);
    expect(f.issues.getLabel).toHaveBeenCalledOnce();
    expect(f.issues.createLabel).toHaveBeenCalledOnce();
    expect(f.issues.addLabels).not.toHaveBeenCalled();
    assertRequestOptions(f, controller.signal);
  });

  it('poisons a witness repair aborted during load instead of resetting a later save context', async () => {
    const f = fixture();
    const first = await f.store().save(null, state());
    f.labels.clear();
    const store = f.store();
    const controller = new AbortController();
    const reason = new Error('witness repair exceeded deadline');
    const labelReads = f.issues.listLabelsOnIssue.mock.calls.length;
    f.issues.addLabels.mockImplementationOnce(async ({ labels }) => {
      labels.forEach(name => f.labels.add(name));
      controller.abort(reason);
      return { data: [...f.labels].map(name => ({ name })) };
    });
    await expect(store.load(controller.signal)).rejects.toBe(reason);
    expect(f.issues.listLabelsOnIssue).toHaveBeenCalledTimes(labelReads + 1);
    expect(await store.load(new AbortController().signal)).toEqual(first);
    const afterRead = f.apiCalls();
    await expect(
      store.save(first, state([unit()], 2), new AbortController().signal)
    ).rejects.toThrow('history');
    expect(f.apiCalls()).toBe(afterRead);
  });

  it('does not let a new operation reset the context of an old aborted transport that has not settled', async () => {
    const f = fixture();
    const store = f.store();
    const first = await store.save(null, state());
    const controller = new AbortController();
    const entered = gate();
    const blocked = gate();
    const reason = new Error('absolute review deadline while transport ignored abort');
    f.issues.createComment.mockImplementationOnce(async ({ body, request }) => {
      expect(request.signal).toBe(controller.signal);
      entered.release();
      await blocked.promise;
      return { data: copy(f.insert(body)) };
    });
    const old = store
      .save(first, state([unit(1, 'x'.repeat(30000))], 2), controller.signal)
      .catch(error => error as unknown);
    try {
      await entered.promise;
      controller.abort(reason);
      const before = f.apiCalls();
      const eligibleCalls = f.eligible.mock.calls.length;
      await expect(store.load(new AbortController().signal)).rejects.toThrow('history');
      await expect(
        store.save(first, state([unit()], 2), new AbortController().signal)
      ).rejects.toThrow('history');
      expect(f.apiCalls()).toBe(before);
      expect(f.eligible).toHaveBeenCalledTimes(eligibleCalls);
    } finally {
      blocked.release();
    }
    expect(await old).toBe(reason);
    expect(f.blobs()).toHaveLength(1);
    expect(f.manifest().body).toBe(first.body);
    expect(f.issues.updateComment).not.toHaveBeenCalled();
    expect(await store.load(new AbortController().signal)).toEqual(first);
    const afterRead = f.apiCalls();
    await expect(
      store.save(first, state([unit()], 2), new AbortController().signal)
    ).rejects.toThrow('history');
    expect(f.apiCalls()).toBe(afterRead);
  });
});

describe('durable review work store', () => {
  it.each([
    ['sha256-raw-v1', 'changed', false],
    ['sha256-utf8-lf-v1', 'all', false],
    ['sha256-raw-v1', 'all', true],
    ['sha256-utf8-lf-v1', 'changed', true],
  ] as const)(
    'recovers digest recipes (%s, %s, blobs: %s) without changing the v1 envelope',
    async (normalization, selection, blobs) => {
      const f = fixture();
      const entry = unit(1, blobs ? 'x'.repeat(20000) : 'Reviewed');
      const result = (entry.data as Extract<ReviewWorkData, { kind: 'unit' }>).result;
      result.followUps = [
        {
          paths: ['inventory.json'],
          question: '<script>untrusted question</script>',
          digestCheck: {
            manifestPath: 'inventory.json',
            pointer: '/files',
            normalization,
            selection,
          },
        },
      ];
      const synthesis: ReviewWorkEntry = {
        id: hash('synthesis'),
        kind: 'synthesis',
        status: 'partial',
        attempts: 1,
        data: { kind: 'synthesis', result: { review: null, followUps: copy(result.followUps) } },
      };
      const saved = await f.store().save(null, state([entry, synthesis]));
      expect(saved.body.split('\n')[0]).toBe(PREFIX);
      expect(payload(saved.body).version).toBe(1);
      expect(saved.body).not.toContain(result.followUps[0]!.question);
      expect(f.blobs().length > 0).toBe(blobs);
      const recoveredStore = f.store();
      const recovered = await recoveredStore.load();
      expect(recovered).toEqual(saved);
      const next = await recoveredStore.save(recovered, state([entry, synthesis], 2));
      expect(next.commentId).toBe(saved.commentId);
      expect(await f.store().load()).toEqual(next);
      expect(f.comments.filter(comment => comment.body.startsWith(PREFIX))).toHaveLength(1);
    }
  );

  it.each([
    null,
    [],
    {},
    { manifestPath: '', pointer: '', normalization: 'sha256-raw-v1', selection: 'all' },
    {
      manifestPath: 'x'.repeat(513),
      pointer: '',
      normalization: 'sha256-raw-v1',
      selection: 'all',
    },
    {
      manifestPath: 'inventory.json',
      pointer: 'x'.repeat(1025),
      normalization: 'sha256-raw-v1',
      selection: 'all',
    },
    { manifestPath: 1, pointer: '', normalization: 'sha256-raw-v1', selection: 'all' },
    {
      manifestPath: 'inventory.json',
      pointer: null,
      normalization: 'sha256-raw-v1',
      selection: 'all',
    },
    { manifestPath: 'inventory.json', pointer: '', normalization: 'sha256', selection: 'all' },
    {
      manifestPath: 'inventory.json',
      pointer: '',
      normalization: 'sha256-raw-v1',
      selection: 'incremental',
    },
    {
      manifestPath: 'inventory.json',
      pointer: '',
      normalization: 'sha256-raw-v1',
      selection: 'all',
      extra: true,
    },
  ])('rejects malformed digest recipe %# on write and fresh decode', async recipe => {
    const f = fixture();
    const entry = unit();
    const malformed = [
      { paths: ['inventory.json'], question: 'Check inventory', digestCheck: recipe },
    ];
    const next = state([entry]);
    (entry.data as unknown as { result: { followUps: unknown } }).result.followUps = malformed;
    await expect(f.store().save(null, next)).rejects.toThrow();
    expect(f.comments).toHaveLength(0);
    await f.store().save(null, state());
    rewrite(f.manifest(), wire => {
      const descriptor = wire.state.entries[0].data;
      descriptor.inline.result.followUps = malformed;
      descriptor.hash = hash(JSON.stringify(descriptor.inline));
    });
    await expect(f.store().load()).rejects.toThrow();
  });

  it('updates persisted unit and synthesis status without implying an active job or completion', async () => {
    const f = fixture();
    const store = f.store();
    const entries = ['reviewed', 'partial', 'failed', 'running'].map((status, index) => ({
      ...unit(index),
      status: status as ReviewWorkEntry['status'],
      data: null,
    }));
    entries.push({ ...unit(99), kind: 'synthesis', status: 'running', data: null });
    const first = await store.save(null, state(entries));
    for (const status of ['reviewed', 'partial', 'failed', 'running']) {
      expect(first.body).toContain(`${status}: 1`);
    }
    expect(first.body).toContain('Synthesis: running');
    expect(first.body).toContain('not live job status');
    entries[4]!.status = 'failed';
    const second = await store.save(first, state(entries, 2));
    expect(second.body).toContain('Synthesis: failed');
    expect(second.body).toContain('not live job status or a canonical completion checkpoint');
    expect(second.commentId).toBe(first.commentId);
    expect(f.issues.createComment).toHaveBeenCalledOnce();
  });

  it('roundtrips inline work with readable counts, enrolls only after verified creation, and leaves canonical history untouched', async () => {
    const f = fixture();
    const canonical = f.insert('<!-- pi-stateful-review:v1 -->\ncanonical F0001 and cursor');
    const lifecycle = f.insert('<!-- pi-stateful-review-lifecycle:v1 -->\nexisting enrollment');
    const before = copy([canonical, lifecycle]);
    const store = f.store();
    expect(await store.load()).toBeNull();
    const first = await store.save(null, state());
    expect(first.state).toEqual(state());
    expect(first.body).toContain('reviewed: 1');
    expect(first.body).toContain('pending: 0');
    expect(first.body).toContain('<!-- pi-review-work-payload:');
    expect(f.operations).toEqual(['manifest', 'label']);
    expect(f.labels.has(LABEL)).toBe(true);
    expect(f.blobs()).toHaveLength(0);
    expect(payload(first.body).state.entries[0].data.hash).toBe(hash(JSON.stringify(unit().data)));
    expect(await f.store().load()).toEqual(first);
    const second = await store.save(first, {
      ...state(),
      revision: 2,
      phase: 'ready',
      reviewHash: hash('review'),
    });
    expect(second.commentId).toBe(first.commentId);
    expect(await f.store().load()).toEqual(second);
    expect([canonical, lifecycle]).toEqual(before);
  });

  it('spills old inline results together, reuses immutable references, and caches without quadratic reads/writes', async () => {
    const f = fixture();
    const store = f.store();
    const initial = [1, 2, 3].map(id => unit(id, 'x'.repeat(1800)));
    const first = await store.save(null, state(initial));
    expect(f.blobs()).toHaveLength(0);
    const entries = [...initial, ...[4, 5, 6].map(id => unit(id, 'y'.repeat(1800)))];
    const second = await store.save(first, state(entries, 2));
    expect(f.blobs()).toHaveLength(1);
    const evidence = copy(f.blobs());
    const descriptors = payload(second.body).state.entries;
    expect(descriptors[0].data.blobIds).toEqual([evidence[0]!.id]);
    expect(descriptors[1].data.blobIds).toEqual([evidence[0]!.id]);
    expect(descriptors[5].data.inline).toEqual(entries[5]!.data);
    const scanCalls = f.issues.listComments.mock.calls.length;
    const blobReads = f.issues.getComment.mock.calls.filter(
      ([args]) => args.comment_id === evidence[0]!.id
    ).length;
    let previous = second;
    for (let revision = 3; revision <= 20; revision++) {
      previous = await store.save(previous, state(entries, revision));
    }
    expect(f.issues.listComments).toHaveBeenCalledTimes(scanCalls);
    expect(
      f.issues.getComment.mock.calls.filter(([args]) => args.comment_id === evidence[0]!.id)
    ).toHaveLength(blobReads);
    expect(f.blobs()).toEqual(evidence);
    const final = await store.load();
    expect(final).toEqual(previous);
    expect(
      f.issues.getComment.mock.calls.filter(([args]) => args.comment_id === evidence[0]!.id)
    ).toHaveLength(blobReads + 1);
  });

  it('checkpoints all 96 unit starts/results with batched evidence within the explicit API budget', async () => {
    const f = fixture();
    const store = f.store();
    const entries = Array.from({ length: 96 }, (_, id) => ({
      ...unit(id),
      status: 'pending' as ReviewWorkEntry['status'],
      attempts: 0,
      data: null as ReviewWorkData | null,
    }));
    let saved = await store.save(null, state(entries));
    for (let index = 0; index < entries.length; index++) {
      entries[index]!.status = 'running';
      entries[index]!.attempts = 1;
      saved = await store.save(saved, state(entries, saved.state.revision + 1));
      entries[index] = unit(index, 'x'.repeat(1800));
      saved = await store.save(saved, state(entries, saved.state.revision + 1));
    }
    expect(await store.load()).toEqual(saved);
    expect(f.apiCalls()).toBeLessThanOrEqual(API_CALLS);
    expect(f.blobs().length).toBeLessThan(40);
    expect(f.blobs().some(blob => payload(blob.body).parts.length > 1)).toBe(true);
  });

  it.each([1, 2])(
    'persists 96 full-size worker results with %i attempt(s), three synthesis attempts and complete fresh verification in one invocation',
    async maxAttempts => {
      const f = fixture();
      const store = f.store();
      const entries: ReviewWorkEntry[] = Array.from({ length: 96 }, (_, id) => ({
        ...unit(id),
        status: 'pending',
        attempts: 0,
        data: null,
      }));
      expect(await store.load()).toBeNull();
      let saved = await store.save(null, state(entries));
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        for (let index = 0; index < entries.length; index++) {
          entries[index]!.status = 'running';
          entries[index]!.attempts = attempt;
          saved = await store.save(saved, state(entries, saved.state.revision + 1));
          entries[index] = fullSizeUnit(
            index,
            attempt,
            attempt === maxAttempts ? 'reviewed' : 'partial'
          );
          saved = await store.save(saved, state(entries, saved.state.revision + 1));
        }
      }
      const synthesis: ReviewWorkEntry = {
        id: hash('stress-synthesis'),
        kind: 'synthesis',
        status: 'pending',
        attempts: 0,
        data: null,
      };
      entries.push(synthesis);
      for (let attempt = 1; attempt <= 3; attempt++) {
        synthesis.status = 'running';
        synthesis.attempts = attempt;
        saved = await store.save(saved, state(entries, saved.state.revision + 1));
        const complete = attempt === 3;
        const review = {
          coverage: complete ? ('complete' as const) : ('incomplete' as const),
          coverageNotes:
            `Synthesis attempt ${attempt}. ` +
            'Pinned unit evidence and whole-file integration contracts were reconciled. '.repeat(
              160
            ),
          findings: [],
        };
        synthesis.status = complete ? 'reviewed' : 'partial';
        synthesis.data = { kind: 'synthesis', result: { review, followUps: [] } };
        const next = state(entries, saved.state.revision + 1);
        if (complete) {
          next.phase = 'ready';
          next.reviewHash = hash(JSON.stringify(review));
        }
        saved = await store.save(saved, next);
      }
      const referenced = new Set<number>();
      for (const entry of payload(saved.body).state.entries) {
        for (const id of entry.data?.blobIds ?? []) {
          referenced.add(id);
        }
      }
      const beforeReads = f.issues.getComment.mock.calls.length;
      const loaded = await store.load();
      const freshlyRead = f.issues.getComment.mock.calls
        .slice(beforeReads)
        .map(([args]) => args.comment_id);
      expect(new Set(freshlyRead)).toEqual(referenced);
      expect(freshlyRead).toHaveLength(referenced.size);
      expect(loaded).toEqual(saved);
      expect(loaded!.state.phase).toBe('ready');
      expect(loaded!.state.entries).toHaveLength(97);
      expect(loaded!.state.entries).toEqual(entries);
      expect(f.issues.updateComment).toHaveBeenCalledTimes(96 * maxAttempts * 2 + 3 * 2);
      for (const entry of loaded!.state.entries.filter(entry => entry.kind === 'unit')) {
        expect(entry.status).toBe('reviewed');
        expect(entry.attempts).toBe(maxAttempts);
        expect(Buffer.byteLength(JSON.stringify(entry.data!.result))).toBe(6 * 1024);
      }
      const manifestBodies = [
        ...f.issues.createComment.mock.calls
          .map(([args]) => args.body)
          .filter(body => body.startsWith(PREFIX)),
        ...f.issues.updateComment.mock.calls.map(([args]) => args.body),
      ];
      const maxManifestBytes = Math.max(...manifestBodies.map(body => Buffer.byteLength(body)));
      expect(f.apiCalls()).toBeGreaterThan(750);
      expect(f.apiCalls()).toBeLessThanOrEqual(API_CALLS);
      expect(maxManifestBytes).toBeLessThanOrEqual(60000);
      expect(f.comments.every(comment => Buffer.byteLength(comment.body) <= 60000)).toBe(true);
      expect(
        f.issues.updateComment.mock.calls.every(([args]) => args.comment_id === saved.commentId)
      ).toBe(true);
      console.info(
        JSON.stringify({
          workerAttempts: maxAttempts,
          synthesisAttempts: 3,
          apiCalls: f.apiCalls(),
          freshBlobReads: freshlyRead.length,
          maxManifestBytes,
        })
      );
    },
    20000
  );

  it('preserves enough admission budget to freshly verify all live blobs after refusing another checkpoint', async () => {
    const f = fixture();
    const store = f.store();
    let saved = await store.save(
      null,
      state(Array.from({ length: 96 }, (_, id) => fullSizeUnit(id)))
    );
    const beforeLoad = f.apiCalls();
    expect(await store.load()).toEqual(saved);
    const verificationCalls = f.apiCalls() - beforeLoad;
    while (f.apiCalls() + 2 * verificationCalls + 20 < API_CALLS) {
      expect(await store.load()).toEqual(saved);
    }
    let rejected = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        saved = await store.save(saved, { ...saved.state, revision: saved.state.revision + 1 });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('cannot safely admit');
        rejected = true;
        break;
      }
    }
    expect(rejected).toBe(true);
    const writes = f.issues.updateComment.mock.calls.length;
    expect(f.manifest().body).toBe(saved.body);
    const referenced = new Set<number>();
    for (const entry of payload(saved.body).state.entries) {
      for (const id of entry.data?.blobIds ?? []) {
        referenced.add(id);
      }
    }
    const beforeReads = f.issues.getComment.mock.calls.length;
    expect(await store.load()).toEqual(saved);
    expect(
      new Set(f.issues.getComment.mock.calls.slice(beforeReads).map(([args]) => args.comment_id))
    ).toEqual(referenced);
    expect(f.issues.updateComment).toHaveBeenCalledTimes(writes);
    expect(f.apiCalls()).toBeLessThanOrEqual(API_CALLS);
  }, 20000);

  it('measures the inline admission boundary in UTF-8 JSON bytes, not characters', async () => {
    const f = fixture();
    const store = f.store();
    const entry = unit(1, '');
    const result = (entry.data as Extract<ReviewWorkData, { kind: 'unit' }>).result;
    const remaining = 8 * 1024 - Buffer.byteLength(JSON.stringify(entry.data));
    result.assessment = 'é'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2);
    expect(Buffer.byteLength(JSON.stringify(entry.data))).toBe(8 * 1024);
    const first = await store.save(null, state([entry]));
    expect(f.blobs()).toHaveLength(0);
    result.assessment += 'é';
    const second = await store.save(first, state([entry], 2));
    expect(f.blobs()).toHaveLength(1);
    expect(await store.load()).toEqual(second);
  });

  it('splits large synthesis evidence into bounded UTF-8-safe immutable parts and returns transparent full data', async () => {
    const f = fixture();
    const entry: ReviewWorkEntry = {
      id: hash('synthesis'),
      kind: 'synthesis',
      status: 'partial',
      attempts: 2,
      data: {
        kind: 'synthesis',
        result: {
          review: { coverage: 'incomplete', coverageNotes: '🙂漢'.repeat(7000), findings: [] },
          followUps: [{ paths: ['src/ö.ts'], question: 'Verify boundary' }],
        },
      },
    };
    const saved = await f.store().save(null, state([entry]));
    expect(f.blobs()).toHaveLength(3);
    for (const blob of f.blobs()) {
      expect(Buffer.byteLength(blob.body)).toBeLessThanOrEqual(60000);
      const bytes = payload(blob.body).parts.reduce(
        (sum: number, part: { payload: string }) =>
          sum + Buffer.from(part.payload, 'base64').length,
        0
      );
      expect(bytes).toBeLessThanOrEqual(18 * 1024);
      expect(blob.body).toContain('Not a completion checkpoint');
    }
    expect(Buffer.byteLength(saved.body)).toBeLessThanOrEqual(60000);
    expect(await f.store().load()).toEqual(saved);
    expect(saved.state.entries[0]!.data).toEqual(entry.data);
  });

  it('preserves unchanged old chunks on later checkpoints and on a new fingerprint', async () => {
    const f = fixture();
    const store = f.store();
    const first = await store.save(null, state([unit(1, 'x'.repeat(20000))]));
    const original = copy(f.blobs());
    const next = state([unit(1, 'x'.repeat(20000))], 2);
    next.fingerprint = hash('new generation');
    next.entries[0]!.attempts = 0;
    const second = await store.save(first, next);
    expect(f.blobs()).toHaveLength(4);
    expect(f.blobs().slice(0, 2)).toEqual(original);
    expect(payload(second.body).state.entries[0].data.blobIds).not.toEqual(
      payload(first.body).state.entries[0].data.blobIds
    );
    expect(await f.store().load()).toEqual(second);
  });

  it.each(['manifest', 'blob', 'update'])(
    'reconciles a lost %s response only through exact durable readback',
    async kind => {
      const f = fixture();
      const store = f.store();
      let previous: ReviewWorkRecord | null = null;
      if (kind === 'update') {
        previous = await store.save(null, state());
        f.issues.updateComment.mockImplementationOnce(async ({ body, comment_id }) => {
          f.comments.find(comment => comment.id === comment_id)!.body = body;
          throw new Error('response lost after commit');
        });
      } else {
        f.issues.createComment.mockImplementationOnce(async ({ body }) => {
          f.insert(body);
          throw new Error('response lost after commit');
        });
      }
      const value = state(
        [unit(1, kind === 'blob' ? 'x'.repeat(10000) : 'Reviewed')],
        previous ? 2 : 1
      );
      const saved = await store.save(previous, value);
      expect(await f.store().load()).toEqual(saved);
      expect(f.comments.filter(comment => comment.body.startsWith(PREFIX))).toHaveLength(1);
      expect(f.blobs()).toHaveLength(kind === 'blob' ? 1 : 0);
    }
  );

  it('never allocates a replacement after ambiguous manifest creation or unreadable verification', async () => {
    const f = fixture();
    const store = f.store();
    f.issues.createComment.mockImplementationOnce(async ({ body }) => {
      f.insert(body);
      f.issues.listComments.mockRejectedValueOnce(new Error('readback unavailable'));
      throw new Error('timeout');
    });
    await expect(store.save(null, state())).rejects.toThrow('readback unavailable');
    f.comments.length = 0;
    await expect(store.save(null, state())).rejects.toThrow();
    await expect(store.load()).rejects.toThrow();
    expect(f.issues.createComment).toHaveBeenCalledOnce();
  });

  it('does not mistake orphan chunks for completion after a partial write', async () => {
    const f = fixture();
    const store = f.store();
    const first = await store.save(null, state());
    f.issues.updateComment.mockRejectedValueOnce(new Error('server rejected update'));
    await expect(store.save(first, state([unit(1, 'x'.repeat(30000))], 2))).rejects.toThrow();
    expect(f.blobs()).toHaveLength(2);
    expect(await f.store().load()).toEqual(first);
    expect(f.manifest().body).toBe(first.body);
    await expect(store.save(first, state([unit()], 2))).rejects.toThrow();
  });

  it('ignores initial orphan evidence, but never treats an API failure as absence', async () => {
    const f = fixture();
    f.issues.createComment.mockImplementationOnce(async ({ body }) => {
      const item = f.insert(body);
      f.issues.createComment.mockRejectedValueOnce(new Error('manifest failed'));
      return { data: copy(item) };
    });
    await expect(f.store().save(null, state([unit(1, 'x'.repeat(10000))]))).rejects.toThrow();
    expect(f.blobs()).toHaveLength(1);
    expect(f.labels.has(LABEL)).toBe(false);
    expect(await f.store().load()).toBeNull();
    f.issues.listComments.mockRejectedValueOnce(new Error('comments unavailable'));
    await expect(f.store().load()).rejects.toThrow('comments unavailable');
    f.issues.listLabelsOnIssue.mockRejectedValueOnce(new Error('labels unavailable'));
    await expect(f.store().load()).rejects.toThrow('labels unavailable');
  });

  it('refuses stale expected bodies/ids/state before overwriting the manifest', async () => {
    const f = fixture();
    const firstStore = f.store();
    const first = await firstStore.save(null, state());
    const second = await f.store().save(first, state([unit(1, 'Other result')], 2));
    await expect(firstStore.save(first, state([unit()], 2))).rejects.toThrow();
    expect(f.manifest().body).toBe(second.body);
    await expect(f.store().save(null, state())).rejects.toThrow();
    await expect(
      f.store().save({ ...second, commentId: 12345 }, state([unit()], 3))
    ).rejects.toThrow();
    const forged = copy(second);
    forged.state.entries[0]!.attempts = 0;
    await expect(f.store().save(forged, state([unit()], 3))).rejects.toThrow();
  });

  it('rechecks the manifest after staging chunks, leaving only harmless orphans on conflict', async () => {
    const f = fixture();
    const store = f.store();
    const first = await store.save(null, state());
    const create = f.issues.createComment.getMockImplementation()!;
    f.issues.createComment.mockImplementationOnce(async args => {
      const response = await create(args);
      f.manifest().body += '\nchanged externally';
      return response;
    });
    await expect(store.save(first, state([unit(1, 'x'.repeat(10000))], 2))).rejects.toThrow();
    expect(f.issues.updateComment).not.toHaveBeenCalled();
    expect(f.blobs()).toHaveLength(1);
    expect(f.manifest().body).toContain('changed externally');
  });

  it.each([
    'missing',
    'part hash',
    'data hash',
    'part identity',
    'part count',
    'fingerprint',
    'repository',
    'pull number',
    'author',
    'issue url',
    'duplicate reference',
    'unknown field',
  ])('fails closed on corrupt referenced evidence: %s', async kind => {
    const f = fixture();
    const saved = await f.store().save(null, state([unit(1, 'x'.repeat(30000))]));
    const blob = f.blobs()[0]!;
    if (kind === 'missing') {
      f.comments.splice(f.comments.indexOf(blob), 1);
    } else if (kind === 'author') {
      blob.user = { login: 'human', type: 'User' };
    } else if (kind === 'issue url') {
      blob.issue_url = 'https://api.github.com/repos/owner/repo/issues/2';
    } else if (kind === 'duplicate reference') {
      rewrite(f.manifest(), value => {
        value.state.entries[0].data.blobIds[1] = value.state.entries[0].data.blobIds[0];
      });
    } else {
      rewrite(blob, value => {
        if (kind === 'part hash') {
          value.parts[0].partHash = hash('wrong');
        }
        if (kind === 'data hash') {
          value.parts[0].hash = hash('wrong');
        }
        if (kind === 'part identity') {
          value.parts[0].id = hash('wrong');
        }
        if (kind === 'part count') {
          value.parts[0].count = 4;
        }
        if (kind === 'fingerprint') {
          value.fingerprint = hash('wrong');
        }
        if (kind === 'repository') {
          value.repository = 'other/repo';
        }
        if (kind === 'pull number') {
          value.pullNumber = 2;
        }
        if (kind === 'unknown field') {
          value.cursor = 99;
        }
      });
    }
    await expect(f.store().load()).rejects.toThrow();
    await expect(f.store().save(saved, state([unit()], 2))).rejects.toThrow();
    expect(f.comments.filter(comment => comment.body.startsWith(PREFIX))).toHaveLength(1);
  });

  it('verifies the complete result hash even when each modified part has a valid part hash', async () => {
    const f = fixture();
    await f.store().save(null, state([unit(1, 'x'.repeat(30000))]));
    rewrite(f.blobs()[0]!, value => {
      const part = value.parts[0];
      const bytes = Buffer.from(part.payload, 'base64');
      const index = bytes.indexOf('xxxxxxxx');
      bytes[index] = 'y'.charCodeAt(0);
      part.payload = bytes.toString('base64');
      part.partHash = createHash('sha256').update(bytes).digest('hex');
    });
    await expect(f.store().load()).rejects.toThrow();
  });

  it('validates fresh referenced data on every explicit load, even on a previously-cached store', async () => {
    const f = fixture();
    const store = f.store();
    await store.save(null, state([unit(1, 'x'.repeat(10000))]));
    await store.load();
    rewrite(f.blobs()[0]!, value => {
      value.parts[0].payload = Buffer.from('corrupt').toString('base64');
    });
    await expect(store.load()).rejects.toThrow();
  });

  it('ignores unknown human markers and quoted bot markers but rejects duplicate or corrupt trusted manifests', async () => {
    const f = fixture();
    f.insert(`${PREFIX}\nforged`, 'human', 'User');
    f.insert(`Quoted marker: ${PREFIX}`);
    f.insert(`${BLOB}\ncorrupt orphan`);
    const first = await f.store().save(null, state());
    expect(await f.store().load()).toEqual(first);
    f.insert(first.body);
    await expect(f.store().load()).rejects.toThrow();
    f.comments.pop();
    f.manifest().body = `${PREFIX}unknown-version-or-corruption`;
    await expect(f.store().load()).rejects.toThrow();
  });

  it('rejects duplicate manifests introduced during a create readback', async () => {
    const f = fixture();
    f.issues.createComment.mockImplementationOnce(async ({ body }) => {
      const first = f.insert(body);
      f.insert(body);
      return { data: copy(first) };
    });
    await expect(f.store().save(null, state())).rejects.toThrow();
    expect(f.labels.size).toBe(0);
  });

  it('repairs a missing witness, respects case-renamed labels, and fails closed when the manifest is lost', async () => {
    const f = fixture();
    const saved = await f.store().save(null, state());
    f.labels.clear();
    expect(await f.store().load()).toEqual(saved);
    expect(f.labels.has(LABEL)).toBe(true);
    f.labels.clear();
    f.labels.add(LABEL.toUpperCase());
    const adds = f.issues.addLabels.mock.calls.length;
    expect(await f.store().load()).toEqual(saved);
    expect(f.issues.addLabels).toHaveBeenCalledTimes(adds);
    f.comments.splice(f.comments.indexOf(f.manifest()), 1);
    await expect(f.store().load()).rejects.toThrow();
    await expect(f.store().save(null, state())).rejects.toThrow();
  });

  it('repairs failed label attachment without recreating already verified work', async () => {
    const f = fixture();
    f.issues.addLabels.mockRejectedValueOnce(
      Object.assign(new Error('permission denied'), { status: 403 })
    );
    await expect(f.store().save(null, state())).rejects.toThrow('permission denied');
    expect(f.comments).toHaveLength(1);
    expect(await f.store().load()).toMatchObject({ state: state() });
    expect(f.issues.createComment).toHaveBeenCalledOnce();
  });

  it('does not downgrade permissions/API errors into empty history or a replacement checkpoint', async () => {
    const f = fixture();
    f.eligible.mockRejectedValueOnce(new Error('not an eligible PR'));
    await expect(f.store().load()).rejects.toThrow('not an eligible PR');
    expect(f.apiCalls()).toBe(0);
    f.eligible.mockRejectedValueOnce(new Error('unauthorized'));
    await expect(f.store().save(null, state())).rejects.toThrow('unauthorized');
    expect(f.apiCalls()).toBe(0);
    f.issues.listLabelsOnIssue.mockRejectedValueOnce(new Error('permission denied'));
    await expect(f.store().save(null, state())).rejects.toThrow('permission denied');
    expect(f.comments).toHaveLength(0);
    f.issues.createComment.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { status: 403 })
    );
    await expect(f.store().save(null, state())).rejects.toThrow();
    expect(f.comments).toHaveLength(0);
    expect(f.labels.size).toBe(0);
  });

  it.each([
    (value: ReviewWorkState) => {
      value.version = 2 as 1;
    },
    (value: ReviewWorkState) => {
      value.fingerprint = 'not a hash';
    },
    (value: ReviewWorkState) => {
      value.reviewHash = 'abc';
    },
    (value: ReviewWorkState) => {
      value.revision = Number.MAX_SAFE_INTEGER + 1;
    },
    (value: ReviewWorkState) => {
      value.entries[0]!.attempts = -1;
    },
    (value: ReviewWorkState) => {
      value.entries[0]!.attempts = 0.5;
    },
    (value: ReviewWorkState) => {
      value.entries.push(copy(value.entries[0]!));
    },
    (value: ReviewWorkState) => {
      value.entries[0]!.id = 'bad';
    },
    (value: ReviewWorkState) => {
      value.entries[0]!.status = 'unknown' as 'pending';
    },
    (value: ReviewWorkState) => {
      (value as unknown as Record<string, unknown>).cursor = 1;
    },
    (value: ReviewWorkState) => {
      value.entries[0]!.data = { kind: 'unit', result: {} } as ReviewWorkData;
    },
    (value: ReviewWorkState) => {
      (value.entries[0]!.data as { result: { coveredSpanIds: string[] } }).result.coveredSpanIds = [
        'not a hash',
      ];
    },
    (value: ReviewWorkState) => {
      (value.entries[0]!.data as { result: { followUps: unknown } }).result.followUps = [
        { paths: [17], question: 'q' },
      ];
    },
  ])('rejects non-structural or unbounded states without writing data (%#)', async mutate => {
    const f = fixture();
    const value = state();
    mutate(value);
    await expect(f.store().save(null, value)).rejects.toThrow();
    expect(f.comments).toHaveLength(0);
    expect(f.eligible).toHaveBeenCalledOnce();
  });

  it('enforces monotonic revisions and attempts while allowing a valid generation replacement', async () => {
    const f = fixture();
    const store = f.store();
    await expect(store.save(null, state([unit()], 2))).rejects.toThrow();
    const first = await store.save(null, state());
    await expect(store.save(first, state())).rejects.toThrow();
    await expect(store.save(first, state([unit()], 3))).rejects.toThrow();
    const reset = state([unit()], 2);
    reset.entries[0]!.attempts = 0;
    await expect(store.save(first, reset)).rejects.toThrow();
    await expect(store.save(first, state([], 2))).rejects.toThrow();
    reset.fingerprint = hash('new generation');
    const second = await store.save(first, reset);
    expect(second.state.entries[0]!.attempts).toBe(0);
  });

  it('allows 96 units plus one synthesis, never a 97th unit or second synthesis', async () => {
    const f = fixture();
    const entries = Array.from({ length: 96 }, (_, id) => ({
      ...unit(id),
      status: 'pending' as const,
      attempts: 0,
      data: null,
    }));
    const synthesis: ReviewWorkEntry = {
      id: hash('synthesis'),
      kind: 'synthesis',
      status: 'pending',
      attempts: 0,
      data: null,
    };
    const saved = await f.store().save(null, state([...entries, synthesis]));
    expect(await f.store().load()).toEqual(saved);
    const other = fixture();
    await expect(other.store().save(null, state([...entries, unit(100)]))).rejects.toThrow();
    await expect(
      other.store().save(null, state([synthesis, { ...synthesis, id: hash('another') }]))
    ).rejects.toThrow();
    expect(other.comments).toHaveLength(0);
  });

  it('enforces the per-result JSON byte boundary before allocating chunks, including escaped strings', async () => {
    const f = fixture();
    const entry = unit(1, '');
    const result = (entry.data as Extract<ReviewWorkData, { kind: 'unit' }>).result;
    const overhead = Buffer.byteLength(JSON.stringify(entry.data));
    result.assessment = 'x'.repeat(64 * 1024 - overhead);
    expect(Buffer.byteLength(JSON.stringify(entry.data))).toBe(64 * 1024);
    const saved = await f.store().save(null, state([entry]));
    expect(f.blobs()).toHaveLength(4);
    expect(await f.store().load()).toEqual(saved);
    const rejected = fixture();
    result.assessment += 'x';
    await expect(rejected.store().save(null, state([entry]))).rejects.toThrow();
    expect(rejected.comments).toHaveLength(0);
    result.assessment = '\u0001'.repeat(12000);
    await expect(rejected.store().save(null, state([entry]))).rejects.toThrow();
  });

  it('estimates worst-case manifest IDs and all chunk envelopes before immutable writes', async () => {
    const f = fixture();
    const repo = f.deps.context.repo as { owner: string; repo: string };
    repo.owner = 'x'.repeat(46000);
    await expect(f.store().save(null, state([unit(1, 'x'.repeat(10000))]))).rejects.toThrow(
      'capacity'
    );
    expect(f.comments).toHaveLength(0);
  });

  it('does not expose mutable cache state or descriptors to callers', async () => {
    const f = fixture();
    const store = f.store();
    const first = await store.save(null, state());
    const original = copy(first);
    first.state.entries[0]!.attempts = 99;
    const loaded = await store.load();
    expect(loaded).toEqual(original);
    loaded!.state.entries[0]!.attempts = 50;
    expect(await store.load()).toEqual(original);
  });

  it.each(['comments', 'labels'])(
    'bounds streaming %s discovery at 100 pages rather than inferring absence',
    async kind => {
      const f = fixture();
      const request = kind === 'comments' ? f.issues.listComments : f.issues.listLabelsOnIssue;
      request.mockResolvedValue({ data: [], headers: { link: '<next>; rel="next"' } } as never);
      await expect(f.store().load()).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(100);
      expect(request.mock.calls.at(-1)?.[0].page).toBe(100);
      expect(f.issues.createComment).not.toHaveBeenCalled();
    }
  );

  it('scans beyond a found manifest and short linked pages to detect later duplicates', async () => {
    const f = fixture();
    const saved = await f.store().save(null, state());
    for (let index = 0; index < 100; index++) {
      f.insert('human prose', 'human', 'User');
    }
    f.insert(saved.body);
    await expect(f.store().load()).rejects.toThrow();
    f.comments.pop();
    f.issues.listComments.mockResolvedValueOnce({
      data: [],
      headers: { link: '<next>; rel="next"' },
    } as never);
    // A short linked page is not conclusive evidence of absence.
    await expect(f.store().load()).rejects.toThrow();
  });

  it('enforces an explicit per-run API budget without silently skipping data or changing the last committed state', async () => {
    const f = fixture();
    const store = f.store();
    let previous = await store.save(null, state([]));
    let rejected = false;
    for (let revision = 2; revision < 1000; revision++) {
      try {
        previous = await store.save(previous, state([], revision));
      } catch {
        rejected = true;
        break;
      }
    }
    expect(rejected).toBe(true);
    expect(f.apiCalls()).toBeLessThanOrEqual(API_CALLS);
    expect(f.manifest().body).toBe(previous.body);
    expect(await f.store().load()).toEqual(previous);
  });
});
