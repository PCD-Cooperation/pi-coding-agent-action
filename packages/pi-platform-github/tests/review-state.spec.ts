import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { rm, readFile, mkdtemp, writeFile, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareReviewSnapshot } from '../src/review-snapshot';

const gitExec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async () => {
  const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  const mocked = Object.assign(vi.fn(), { [promisify.custom]: gitExec });
  return { ...original, execFile: mocked };
});
import { renderReviewComment } from '@alexanderfortin/pi-orchestrator';
import type { ReviewIdentity, ReviewState, ReviewSnapshot } from '@alexanderfortin/pi-orchestrator';
import type { GitHubModuleDeps } from '../src/types';
import { createStatefulReviewPlatform } from '../src/review-state';

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const M = 'c'.repeat(40);
const MARKER = '<!-- pi-stateful-review:v1 -->';
const snapshot: ReviewSnapshot = {
  repository: 'owner/repo',
  pullNumber: 1,
  headSha: H,
  baseSha: B,
  mergeBaseSha: M,
  baseRef: 'main',
  intentHash: createHash('sha256')
    .update(JSON.stringify(['Title', 'Body']))
    .digest('hex'),
  mode: 'full',
  fallbackReason: null,
  headPath: '/head',
  basePath: '/base',
  previousPath: null,
  fullDiffPath: '/diff',
  incrementalDiffPath: null,
};
function state(): ReviewState {
  const { repository, pullNumber, headSha, baseSha, mergeBaseSha, baseRef, intentHash } = snapshot;
  return {
    schemaVersion: 1,
    revision: 1,
    snapshot: { repository, pullNumber, headSha, baseSha, mergeBaseSha, baseRef, intentHash },
    reviewMode: 'full',
    fallbackReason: null,
    coverageNotes: 'All files reviewed',
    configurationHash: 'd'.repeat(64),
    operationKey: 'e'.repeat(64),
    completedReviews: 1,
    actionableRounds: 0,
    needsHuman: false,
    nextFindingId: 1,
    findings: [],
    intervention: null,
  };
}
function fixture() {
  let comments: ReturnType<typeof comment>[] = [];
  let nextCommentId = 1000;
  const labels = new Map<string, { name: string; color: string; description?: string }>();
  const issueLabels = new Set<string>();
  const pr = {
    state: 'open',
    draft: false,
    merged: false,
    title: 'Title',
    body: 'Body',
    head: { sha: H, repo: { full_name: 'owner/repo' } },
    base: {
      sha: '7'.repeat(40),
      ref: 'main',
      repo: { full_name: 'owner/repo', clone_url: 'https://github.com/owner/repo.git' },
    },
  };
  let timeline: unknown[] = [];
  const issues = {
    listEventsForTimeline: vi.fn(
      async ({ page, per_page }: { page: number; per_page: number }) => ({
        data: timeline.slice((page - 1) * per_page, page * per_page),
      })
    ),
    listComments: vi.fn(async ({ page, per_page }: { page: number; per_page: number }) => ({
      data: comments.slice((page - 1) * per_page, page * per_page),
    })),
    createComment: vi.fn(async ({ body }: { body: string }) => {
      const created = comment(body, undefined, nextCommentId++);
      comments.push(created);
      return { data: created };
    }),
    updateComment: vi.fn(async ({ comment_id, body }: { comment_id: number; body: string }) => {
      const existing = comments.find(item => item.id === comment_id);
      if (!existing) {
        throw Object.assign(new Error('Comment not found'), { status: 404 });
      }
      existing.body = body;
      return { data: existing };
    }),
    getLabel: vi.fn(async ({ name }: { name: string }) => {
      const label = labels.get(name);
      if (!label) {
        throw Object.assign(new Error('Label not found'), { status: 404 });
      }
      return { data: label };
    }),
    createLabel: vi.fn(async (label: { name: string; color: string; description?: string }) => {
      labels.set(label.name, label);
      return { data: label };
    }),
    addLabels: vi.fn(async ({ labels: names }: { labels: string[] }) => {
      names.forEach(name => issueLabels.add(name));
      return { data: [...issueLabels].map(name => labels.get(name) ?? { name }) };
    }),
    listLabelsOnIssue: vi.fn(async () => ({
      data: [...issueLabels].map(name => labels.get(name) ?? { name }),
    })),
  };
  const permission = vi.fn(async () => ({ data: { permission: 'write' } }));
  const prepare = vi.fn(async (identity: Omit<ReviewIdentity, 'mergeBaseSha'>) => ({
    ...snapshot,
    ...identity,
  }));
  const refObject = { type: 'commit', sha: B };
  const getRef = vi.fn(async () => ({ data: { object: refObject } }));
  const auth = vi.fn(async () => ({ token: 'token', tokenType: 'installation' }));
  const installationRepos = vi.fn(async () => ({ data: { total_count: 1, repositories: [] } }));
  const warning = vi.fn();
  const deps = {
    logger: { warning },
    context: {
      repo: { owner: 'owner', repo: 'repo' },
      issue: { number: 1 },
      actor: 'actor',
      serverUrl: 'https://github.com',
    },
    octokit: {
      auth,
      rest: {
        issues,
        apps: { listReposAccessibleToInstallation: installationRepos },
        pulls: { get: vi.fn(async () => ({ data: pr })) },
        git: { getRef },
        repos: { getCollaboratorPermissionLevel: permission },
      },
    },
  } as unknown as GitHubModuleDeps;
  const newPlatform = () => createStatefulReviewPlatform(deps, prepare);
  const provider = newPlatform();
  return {
    provider,
    newPlatform,
    initialize: async () =>
      provider.ensureInitialized!(await provider.loadState(), async () => ({
        kind: 'bootstrap',
        actor: 'actor',
        reason: 'Initialize provider test',
      })),
    comments: () => comments,
    canonicalCreates: () =>
      issues.createComment.mock.calls.filter(([{ body }]) => body.startsWith(MARKER)),
    canonicalUpdates: () =>
      issues.updateComment.mock.calls.filter(([{ body }]) => body.startsWith(MARKER)),
    issues,
    pr,
    refObject,
    getRef,
    permission,
    auth,
    installationRepos,
    warning,
    prepare,
    context: deps.context,
    setTimeline: (value: unknown[]) => {
      timeline = value;
    },
    setComments: (value: typeof comments) => {
      comments = value;
    },
  };
}
function comment(body: string, login = 'github-actions[bot]', id = 42) {
  return { id, body, user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' } };
}

describe('real local Git snapshots', () => {
  it('uses divergent endpoint commits, raw blobs and base fallback, rejecting symlinks', async () => {
    const { execFile } =
      await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const { promisify } = await import('node:util');
    const actualExec = promisify(execFile);
    const fixturePath = await mkdtemp(join(tmpdir(), 'pi-review-fixture-'));
    const snapshots: string[] = [];
    const git = async (...args: string[]) => {
      const { stdout } = await actualExec(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-C', fixturePath, ...args],
        {
          env: {
            PATH: process.env.PATH,
            HOME: fixturePath,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
          },
        }
      );
      return stdout.trim();
    };
    try {
      await git('init', '--initial-branch=main', '--template=');
      await git('config', 'user.email', 'fixture@example.invalid');
      await git('config', 'user.name', 'Fixture');
      await writeFile(join(fixturePath, 'base.txt'), 'base\n');
      await writeFile(join(fixturePath, 'runbook.md'), 'Historical default: legacy\n');
      await writeFile(join(fixturePath, 'config.json'), '{"default":"legacy"}\n');
      await writeFile(join(fixturePath, '.gitattributes'), '*.txt text eol=crlf filter=evil\n');
      await git('add', '.');
      await git('commit', '-m', 'base');
      const baseSha = await git('rev-parse', 'HEAD');
      await writeFile(join(fixturePath, 'obsolete.txt'), 'previous only\n');
      await git('add', '.');
      await git('commit', '-m', 'previous');
      const previousSha = await git('rev-parse', 'HEAD');
      await git('checkout', '--detach', baseSha);
      await writeFile(join(fixturePath, 'new.txt'), 'new only\n');
      await git('add', '.');
      await git('commit', '-m', 'divergent head');
      const headSha = await git('rev-parse', 'HEAD');
      await git('checkout', 'main');
      await writeFile(join(fixturePath, 'runbook.md'), 'Current default: modern\n');
      await writeFile(join(fixturePath, 'config.json'), '{"default":"modern"}\n');
      await git('add', '.');
      await git('commit', '-m', 'update target contracts');
      const targetSha = await git('rev-parse', 'HEAD');
      await writeFile(join(fixturePath, 'runbook.md'), 'Later unreviewed default\n');
      await git('add', '.');
      await git('commit', '-m', 'advance named target after pinning');
      await git('checkout', '--detach', headSha);
      const executed = join(fixturePath, 'filter-executed');
      await git('config', 'filter.evil.smudge', `touch ${executed}`);
      // Only the trusted process adapter changes transport for this local fixture.
      // All snapshot Git commands, object lookup, ancestry and diffs are real Git.
      gitExec.mockReset();
      gitExec.mockImplementation((command, args, options) =>
        actualExec(
          command,
          args.map((arg: string) =>
            arg === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : arg
          ),
          { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file' } }
        )
      );
      const identity = { ...snapshot, headSha, baseSha: targetSha };
      const previous = state();
      previous.snapshot.headSha = previousSha;
      previous.snapshot.mergeBaseSha = baseSha;
      const result = await prepareReviewSnapshot(identity, previous, fixturePath);
      snapshots.push(dirname(result.headPath));
      expect(result.mode).toBe('incremental');
      expect(result.mergeBaseSha).toBe(baseSha);
      expect(result.baseSha).toBe(targetSha);
      expect(new Set([result.headPath, result.basePath, result.targetPath]).size).toBe(3);
      for (const path of [result.headPath, result.basePath]) {
        expect(await readFile(join(path, 'runbook.md'), 'utf8')).toBe(
          'Historical default: legacy\n'
        );
        expect(await readFile(join(path, 'config.json'), 'utf8')).toBe('{"default":"legacy"}\n');
      }
      expect(await readFile(join(result.targetPath!, 'runbook.md'), 'utf8')).toBe(
        'Current default: modern\n'
      );
      expect(await readFile(join(result.targetPath!, 'config.json'), 'utf8')).toBe(
        '{"default":"modern"}\n'
      );
      await expect(access(join(result.basePath, 'new.txt'))).rejects.toThrow();
      await expect(access(join(result.targetPath!, 'new.txt'))).rejects.toThrow();
      const attributionDiff = await readFile(result.fullDiffPath, 'utf8');
      expect(attributionDiff).toContain('new.txt');
      expect(attributionDiff).not.toContain('runbook.md');
      expect(attributionDiff).not.toContain('config.json');
      expect(await readFile(result.incrementalDiffPath!, 'utf8')).toContain('deleted file mode');
      expect(await readFile(result.incrementalDiffPath!, 'utf8')).toContain('obsolete.txt');
      expect(await readFile(result.fullDiffPath, 'utf8')).not.toContain('obsolete.txt');
      expect(await readFile(join(result.headPath, 'new.txt'), 'utf8')).toBe('new only\n');
      expect(await readFile(join(result.previousPath!, 'obsolete.txt'), 'utf8')).toBe(
        'previous only\n'
      );
      expect(await readFile(join(result.basePath, 'base.txt'), 'utf8')).toBe('base\n');
      await expect(access(executed)).rejects.toThrow();
      previous.snapshot.baseRef = 'another-base';
      const fallback = await prepareReviewSnapshot(identity, previous, fixturePath);
      snapshots.push(dirname(fallback.headPath));
      expect(fallback.mode).toBe('full');
      expect(fallback.fallbackReason).toBe('Base ref changed');
      await symlink(executed, join(fixturePath, 'unsafe-link'));
      await git('add', 'unsafe-link');
      await git('commit', '-m', 'symlink');
      const symlinkHead = await git('rev-parse', 'HEAD');
      await expect(
        prepareReviewSnapshot({ ...identity, headSha: symlinkHead }, null, fixturePath)
      ).rejects.toThrow('symlink');
      await expect(access(executed)).rejects.toThrow();
    } finally {
      await Promise.all(
        [fixturePath, ...snapshots].map(path => rm(path, { recursive: true, force: true }))
      );
    }
  }, 30_000);
});

describe('host git snapshot preparation', () => {
  function mockGit(unavailable = false, symlink = false, entryPath = 'file.txt') {
    gitExec.mockReset();
    gitExec.mockImplementation(async (_command: string, args: string[]) => {
      if (unavailable && args.includes('fetch') && args.at(-1) === 'd'.repeat(40)) {
        throw new Error('missing commit');
      }
      let output = '';
      if (args.includes('rev-parse')) {
        output = args.at(-1)!.split('^')[0]!;
      }
      if (args.includes('merge-base')) {
        output = M;
      }
      if (args.includes('ls-tree')) {
        output = `${symlink ? '120000' : '100644'} blob ${'e'.repeat(40)} 3\t${entryPath}\0`;
      }
      if (args.includes('cat-file')) {
        output = 'raw';
      }
      if (args.includes('diff')) {
        output = 'endpoint diff';
      }
      return { stdout: Buffer.from(output), stderr: Buffer.alloc(0) };
    });
  }
  it('materializes raw pinned blobs and compares P to H (never triple-dot)', async () => {
    mockGit();
    const previous = state();
    previous.snapshot.headSha = 'd'.repeat(40);
    const result = await prepareReviewSnapshot(
      snapshot,
      previous,
      'https://github.com/owner/repo.git',
      'secret'
    );
    try {
      expect(result.mode).toBe('incremental');
      expect(await readFile(`${result.headPath}/file.txt`, 'utf8')).toBe('raw');
      expect(await readFile(`${result.targetPath}/file.txt`, 'utf8')).toBe('raw');
      expect(result.targetPath).not.toBe(result.basePath);
      const calls = gitExec.mock.calls.map(call => call[1] as string[]);
      expect(
        calls.some(
          args =>
            args.includes('diff') && args.at(-3) === previous.snapshot.headSha && args.at(-2) === H
        )
      ).toBe(true);
      expect(
        calls.some(args => args.includes('diff') && args.at(-3) === M && args.at(-2) === H)
      ).toBe(true);
      expect(calls.flat().some(arg => arg.includes('...') || arg === '--depth')).toBe(false);
      expect(
        calls.every(
          args => args.includes('core.hooksPath=/dev/null') && args.includes('core.symlinks=false')
        )
      ).toBe(true);
      expect(gitExec.mock.calls[0]![2].env).toEqual(
        expect.objectContaining({
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_ALLOW_PROTOCOL: 'https',
        })
      );
    } finally {
      await rm(dirname(result.headPath), { recursive: true, force: true });
    }
  });
  it.each([
    { head: H, base: M, merge: M, reuse: 'base' },
    { head: H, base: H, merge: M, reuse: 'head' },
    { head: H, base: B, merge: H, reuse: 'distinct' },
    { head: H, base: H, merge: H, reuse: 'head' },
  ])('reuses equal SHA trees safely: $reuse ($base, $merge)', async ({ head, base, merge }) => {
    mockGit();
    const implementation = gitExec.getMockImplementation()!;
    gitExec.mockImplementation(async (command, args, options) =>
      args.includes('merge-base')
        ? { stdout: Buffer.from(merge), stderr: Buffer.alloc(0) }
        : implementation(command, args, options)
    );
    const result = await prepareReviewSnapshot(
      { ...snapshot, headSha: head, baseSha: base },
      null,
      'https://github.com/owner/repo.git'
    );
    try {
      expect(result.targetPath).toBe(
        base === head
          ? result.headPath
          : base === merge
            ? result.basePath
            : join(dirname(result.headPath), 'target')
      );
      if (head === merge) {
        expect(result.basePath).toBe(result.headPath);
      }
      const extracted = gitExec.mock.calls
        .map(call => call[1] as string[])
        .filter(args => args.includes('ls-tree'))
        .map(args => args.at(-1));
      expect(extracted).toEqual([...new Set([head, merge, base])]);
      expect(await readFile(join(result.targetPath!, 'file.txt'), 'utf8')).toBe('raw');
    } finally {
      await rm(dirname(result.headPath), { recursive: true, force: true });
    }
  });
  it.each([
    ['symlink', `120000 blob ${'f'.repeat(40)} 3\tlink\0`, 'symlink'],
    ['submodule', `160000 commit ${'f'.repeat(40)} -\tmodule\0`, 'submodule'],
    ['bytes', `100644 blob ${'f'.repeat(40)} ${128 * 1024 * 1024 + 1}\tlarge\0`, 'byte limit'],
    ['files', `100644 blob ${'f'.repeat(40)} 0\tfile\0`.repeat(10_001), 'file limit'],
    ['blob failure', `100644 blob ${'f'.repeat(40)} 3\tfile\0`, 'target blob unavailable'],
  ])('cleans the entire snapshot on target %s', async (kind, tree, error) => {
    mockGit();
    const implementation = gitExec.getMockImplementation()!;
    gitExec.mockImplementation(async (command, args, options) => {
      if (args.includes('ls-tree') && args.at(-1) === B) {
        return { stdout: Buffer.from(tree), stderr: Buffer.alloc(0) };
      }
      if (kind === 'blob failure' && args.includes('cat-file') && args.at(-1) === 'f'.repeat(40)) {
        throw new Error('target blob unavailable');
      }
      return implementation(command, args, options);
    });
    await expect(
      prepareReviewSnapshot(snapshot, null, 'https://github.com/owner/repo.git')
    ).rejects.toThrow(error);
    const calls = gitExec.mock.calls.map(call => call[1] as string[]);
    expect(calls.some(args => args.includes('ls-tree') && args.at(-1) === M)).toBe(true);
    const gitDir = calls[0]!.find(arg => arg.startsWith('--git-dir='))!.slice('--git-dir='.length);
    await expect(access(dirname(gitDir))).rejects.toThrow();
  });
  it.each(['unavailable', 'base', 'merge'])(
    'falls back fully for %s without mutating the ledger',
    async reason => {
      mockGit(reason === 'unavailable');
      const previous = state();
      previous.snapshot.headSha = 'd'.repeat(40);
      if (reason === 'base') {
        previous.snapshot.baseRef = 'other';
      }
      if (reason === 'merge') {
        previous.snapshot.mergeBaseSha = 'f'.repeat(40);
      }
      const before = JSON.stringify(previous);
      const result = await prepareReviewSnapshot(
        snapshot,
        previous,
        'https://github.com/owner/repo.git'
      );
      try {
        expect(result.mode).toBe('full');
        expect(result.fallbackReason).toBeTruthy();
        expect(result.previousPath).toBeNull();
        expect(result.incrementalDiffPath).toBeNull();
        expect(JSON.stringify(previous)).toBe(before);
      } finally {
        await rm(dirname(result.headPath), { recursive: true, force: true });
      }
    }
  );
  it.each(['/absolute', '../escape', './ambiguous', 'empty//component', '.git/config'])(
    'rejects unsafe tree path %s',
    async path => {
      mockGit(false, false, path);
      await expect(
        prepareReviewSnapshot(snapshot, null, 'https://github.com/owner/repo.git')
      ).rejects.toThrow('Unsafe');
    }
  );
  it('rejects symlinks rather than following or executing PR contents', async () => {
    mockGit(false, true);
    await expect(
      prepareReviewSnapshot(snapshot, null, 'https://github.com/owner/repo.git')
    ).rejects.toThrow('symlink');
  });
});

function readyFixture() {
  const f = fixture();
  Object.assign(f.context, {
    eventName: 'pull_request_target',
    runAttempt: 1,
    payload: {
      action: 'ready_for_review',
      number: 1,
      repository: { full_name: 'owner/repo' },
      sender: { id: 17, login: 'actor' },
      pull_request: {
        number: 1,
        state: 'open',
        draft: false,
        updated_at: '2026-10-17T16:21:03Z',
        head: { sha: H },
      },
    },
  });
  const ready = {
    id: 33529023542,
    event: 'ready_for_review',
    created_at: '2026-10-17T16:21:03Z',
    actor: { id: 17, login: 'actor' },
  };
  f.setTimeline([ready]);
  return { ...f, ready };
}

describe('first draft readiness proof', () => {
  it('accepts exactly the first ready transition, including fully paginated history', async () => {
    const f = readyFixture();
    expect(await f.provider.canInitializeFromDraft!()).toBe(true);
    f.issues.listEventsForTimeline.mockClear();
    f.setTimeline([...Array.from({ length: 200 }, () => ({ event: 'committed' })), f.ready]);
    expect(await f.provider.canInitializeFromDraft!()).toBe(true);
    expect(f.issues.listEventsForTimeline).toHaveBeenCalledTimes(3);
    expect(f.issues.listEventsForTimeline).toHaveBeenLastCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 1,
      per_page: 100,
      page: 3,
    });
    expect(f.issues.createComment).not.toHaveBeenCalled();
  });
  it.each([
    { history: [] },
    { history: [{ event: 'converted_to_draft' }] },
    { history: [{ event: 'future_unknown_transition' }] },
    { history: [{}] },
    { history: [null] },
  ])('rejects absent or uncertain history $history', async ({ history }) => {
    const f = readyFixture();
    f.setTimeline(history);
    expect(await f.provider.canInitializeFromDraft!()).toBe(false);
  });
  it('follows a next-page link even when the current page is short', async () => {
    const f = readyFixture();
    f.issues.listEventsForTimeline.mockResolvedValueOnce({
      data: [f.ready],
      headers: { link: '<https://api.github.com/next>; rel="next"' },
    } as { data: unknown[] });
    f.setTimeline([
      ...Array.from({ length: 100 }, () => ({ event: 'committed' })),
      { event: 'converted_to_draft' },
    ]);
    expect(await f.provider.canInitializeFromDraft!()).toBe(false);
    expect(f.issues.listEventsForTimeline).toHaveBeenCalledTimes(2);
  });
  it.each([{ id: 18, login: 'actor' }, { id: 17, login: 'forged' }, null])(
    'rejects a forged or missing timeline actor %j',
    async actor => {
      const f = readyFixture();
      f.setTimeline([{ ...f.ready, actor }]);
      expect(await f.provider.canInitializeFromDraft!()).toBe(false);
    }
  );
  it('rejects converted/re-ready history even when the checkpoint was deleted', async () => {
    const f = readyFixture();
    f.setComments([]);
    f.setTimeline([{ event: 'converted_to_draft' }, f.ready]);
    expect(await f.provider.loadState()).toBeNull();
    expect(await f.provider.canInitializeFromDraft!()).toBe(false);
    f.setTimeline([f.ready, { ...f.ready, id: 2 }]);
    expect(await f.provider.canInitializeFromDraft!()).toBe(false);
    f.setTimeline([
      f.ready,
      ...Array.from({ length: 99 }, () => ({ event: 'committed' })),
      { event: 'converted_to_draft' },
    ]);
    expect(await f.provider.canInitializeFromDraft!()).toBe(false);
  });
  it('allows a newer head while the first ready event was queued', async () => {
    const f = readyFixture();
    f.pr.head.sha = 'f'.repeat(40);
    expect(await f.provider.canInitializeFromDraft!()).toBe(true);
  });
  it.each(['event', 'attempt', 'action', 'actor', 'sender', 'timestamp', 'repository'])(
    'rejects wrong or forged %s',
    async change => {
      const f = readyFixture();
      const payload = f.context.payload;
      if (change === 'event') {
        f.context.eventName = 'workflow_dispatch';
      }
      if (change === 'attempt') {
        f.context.runAttempt = 2;
      }
      if (change === 'action') {
        payload.action = 'synchronize';
      }
      if (change === 'actor') {
        f.context.actor = 'forged';
      }
      if (change === 'sender') {
        payload.sender = { id: 19, login: 'actor' };
      }
      if (change === 'timestamp') {
        f.ready.created_at = '2026-10-17T16:21:04Z';
      }
      if (change === 'repository') {
        payload.repository = { full_name: 'wrong/repo' };
      }
      expect(await f.provider.canInitializeFromDraft!()).toBe(false);
    }
  );
  it.each(['closed', 'draft', 'fork'])('rejects ineligible live PR %s', async change => {
    const f = readyFixture();
    if (change === 'closed') {
      f.pr.state = 'closed';
    }
    if (change === 'draft') {
      f.pr.draft = true;
    }
    if (change === 'fork') {
      f.pr.head.repo.full_name = 'fork/repo';
    }
    expect(await f.provider.canInitializeFromDraft!()).toBe(false);
  });
  it('fails closed on missing/failed history and later pagination errors', async () => {
    const f = readyFixture();
    f.issues.listEventsForTimeline.mockResolvedValueOnce({ data: null as unknown as unknown[] });
    expect(await f.provider.canInitializeFromDraft!()).toBe(false);
    f.issues.listEventsForTimeline.mockRejectedValueOnce(new Error('unavailable'));
    expect(await f.provider.canInitializeFromDraft!()).toBe(false);
    f.setTimeline([f.ready, ...Array.from({ length: 99 }, () => ({ event: 'committed' }))]);
    f.issues.listEventsForTimeline
      .mockImplementationOnce(async () => ({
        data: [f.ready, ...Array.from({ length: 99 }, () => ({ event: 'committed' }))],
      }))
      .mockRejectedValueOnce(new Error('page two unavailable'));
    expect(await f.provider.canInitializeFromDraft!()).toBe(false);
  });
});

describe('GitHub review initialization receipts', () => {
  it('requires a permit for a completely untracked PR before any receipt or snapshot work', async () => {
    const f = fixture();
    const authorizeNew = vi.fn(async () => null);
    await expect(f.provider.ensureInitialized!(null, authorizeNew)).rejects.toThrow();
    expect(authorizeNew).toHaveBeenCalledOnce();
    expect(f.issues.createComment).not.toHaveBeenCalled();
    expect(f.issues.addLabels).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('adopts legacy state and appends without editing its canonical ID', async () => {
    const f = fixture();
    f.setComments([comment(renderReviewComment(state()))]);
    const previous = await f.provider.loadState();
    const authorizeNew = vi.fn(async () => null);
    await f.provider.ensureInitialized!(previous, authorizeNew);
    expect(authorizeNew).not.toHaveBeenCalled();
    const next = state();
    next.revision++;
    next.completedReviews++;
    next.operationKey = 'f'.repeat(64);
    await f.provider.publish(previous, snapshot, next, renderReviewComment(next, previous));
    expect(await f.provider.loadState()).toEqual({
      commentId: expect.any(Number),
      body: renderReviewComment(next, previous),
      state: next,
    });
    expect(f.canonicalCreates()).toHaveLength(1);
    expect(f.canonicalUpdates()).toHaveLength(0);
    expect(f.comments()).toHaveLength(3);
    expect(f.comments().find(item => item.id === previous!.commentId)?.body).toBe(previous!.body);
    await f.newPlatform().ensureInitialized!(await f.provider.loadState(), authorizeNew);
    expect(authorizeNew).not.toHaveBeenCalled();
  });

  it('retries a definitive initial rejection on a fresh provider without a new permit', async () => {
    const f = fixture();
    await f.initialize();
    const rejected = Object.assign(new Error('Validation failed'), { status: 422 });
    f.issues.createComment.mockRejectedValueOnce(rejected);
    await expect(
      f.provider.publish(null, snapshot, state(), renderReviewComment(state(), null))
    ).rejects.toBe(rejected);
    expect(await f.provider.loadState()).toBeNull();
    expect(f.canonicalCreates()).toHaveLength(1);

    const retry = f.newPlatform();
    const authorizeNew = vi.fn(async () => null);
    await retry.ensureInitialized!(null, authorizeNew);
    expect(authorizeNew).not.toHaveBeenCalled();
    await retry.publish(null, snapshot, state(), renderReviewComment(state(), null));
    expect(f.canonicalCreates()).toHaveLength(2);
    expect((await retry.loadState())?.state).toEqual(state());
  });

  it('repairs a failed seal against the exact committed canonical cursor on a fresh provider', async () => {
    const f = fixture();
    await f.initialize();
    const next = state();
    next.revision = 1;
    next.completedReviews = 1;
    next.actionableRounds = 1;
    next.nextFindingId = 12;
    const body = renderReviewComment(next, null);
    const sealError = new Error('Receipt seal unavailable');
    const update = f.issues.updateComment.getMockImplementation()!;
    f.issues.updateComment.mockImplementation(async args => {
      if (f.comments().some(item => item.body === body) && !args.body.startsWith(MARKER)) {
        throw sealError;
      }
      return update(args);
    });
    await expect(f.provider.publish(null, snapshot, next, body)).rejects.toBe(sealError);
    const written = await f.provider.loadState();
    expect(written?.state).toEqual(next);
    expect(f.canonicalCreates()).toHaveLength(1);
    expect(f.comments()).toHaveLength(2);

    f.issues.updateComment.mockImplementation(update);
    const repair = f.newPlatform();
    const authorizeNew = vi.fn(async () => null);
    await repair.ensureInitialized!(written, authorizeNew);
    expect(authorizeNew).not.toHaveBeenCalled();
    expect(await repair.loadState()).toEqual(written);
    expect(f.canonicalCreates()).toHaveLength(1);
    expect(f.canonicalUpdates()).toHaveLength(0);
    expect(f.prepare).not.toHaveBeenCalled();
    const sealed = f.comments().find(item => !item.body.startsWith(MARKER))!.body;
    await f.newPlatform().ensureInitialized!(written, authorizeNew);
    expect(f.comments().find(item => !item.body.startsWith(MARKER))!.body).toBe(sealed);
  });

  it('rejects a missing committed canonical even with a bootstrap permit', async () => {
    const f = fixture();
    await f.initialize();
    await f.provider.publish(null, snapshot, state(), renderReviewComment(state(), null));
    f.setComments(f.comments().filter(item => !item.body.startsWith(MARKER)));
    const authorizeNew = vi.fn(async () => ({
      kind: 'bootstrap' as const,
      actor: 'actor',
      reason: 'Explicit retry',
    }));
    await expect(f.newPlatform().ensureInitialized!(null, authorizeNew)).rejects.toThrow();
    expect(authorizeNew).not.toHaveBeenCalled();
    expect(f.canonicalCreates()).toHaveLength(1);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('rejects a stale snapshot before advancing the pending publishing receipt', async () => {
    const f = fixture();
    await f.initialize();
    const receipts = structuredClone(f.comments());
    const updates = f.issues.updateComment.mock.calls.length;
    f.refObject.sha = 'f'.repeat(40);
    await expect(
      f.provider.publish(null, snapshot, state(), renderReviewComment(state(), null))
    ).rejects.toThrow('Stale');
    expect(f.comments()).toEqual(receipts);
    expect(f.issues.updateComment).toHaveBeenCalledTimes(updates);
    expect(f.canonicalCreates()).toHaveLength(0);
    await f.newPlatform().ensureInitialized!(null, async () => null);
  });

  it.each(['authentication', 'closed', 'draft', 'fork'])(
    'rejects ineligible initialization %s before authorizing or writing a receipt',
    async change => {
      const f = fixture();
      if (change === 'authentication') {
        f.installationRepos.mockRejectedValue(new Error('Not an installation token'));
      } else if (change === 'closed') {
        f.pr.state = 'closed';
      } else if (change === 'draft') {
        f.pr.draft = true;
      } else {
        f.pr.head.repo.full_name = 'fork/repo';
      }
      const authorizeNew = vi.fn(async () => null);
      await expect(f.provider.ensureInitialized!(null, authorizeNew)).rejects.toThrow();
      expect(authorizeNew).not.toHaveBeenCalled();
      expect(f.issues.createComment).not.toHaveBeenCalled();
      expect(f.issues.addLabels).not.toHaveBeenCalled();
      expect(f.prepare).not.toHaveBeenCalled();
    }
  );

  it('does not allow direct publication to bypass initialization', async () => {
    const f = fixture();
    await expect(
      f.provider.publish(null, snapshot, state(), renderReviewComment(state(), null))
    ).rejects.toThrow();
    expect(f.canonicalCreates()).toHaveLength(0);
  });
});

describe('append-only review history', () => {
  function history() {
    const rootState = state();
    const root = { commentId: 42, body: renderReviewComment(rootState), state: rootState };
    const secondState = {
      ...state(),
      revision: 2,
      completedReviews: 2,
      operationKey: 'f'.repeat(64),
    };
    const second = {
      commentId: 43,
      body: renderReviewComment(secondState, root),
      state: secondState,
    };
    const thirdState = { ...state(), revision: 3, completedReviews: 3 };
    const third = {
      commentId: 44,
      body: renderReviewComment(thirdState, second),
      state: thirdState,
    };
    return [root, second, third];
  }
  it('loads the unique head independently of ID/order, allowing repeated operation keys', async () => {
    const f = fixture();
    const records = history();
    f.setComments(
      records.toReversed().map(record => comment(record.body, undefined, record.commentId))
    );
    expect(await f.provider.loadState()).toEqual(records[2]);
  });
  it.each([
    'tamper',
    'deleted root',
    'deleted middle',
    'fork',
    'duplicate revision',
    'multiple roots',
    'orphan',
  ])('rejects %s without selecting a newer comment', async change => {
    const f = fixture();
    const [root, second, third] = history();
    const comments = [root!, second!, third!].map(record =>
      comment(record.body, undefined, record.commentId)
    );
    if (change === 'tamper') {
      comments[0]!.body = comments[0]!.body.replace('All files reviewed', 'Tampered notes');
    }
    if (change === 'deleted root') {
      comments.shift();
    }
    if (change === 'deleted middle') {
      comments.splice(1, 1);
    }
    if (change === 'fork') {
      comments.push(comment(renderReviewComment(third!.state, second!), undefined, 45));
    }
    if (change === 'duplicate revision') {
      comments.push(comment(renderReviewComment(second!.state, root!), undefined, 45));
    }
    if (change === 'multiple roots') {
      comments.push(
        comment(
          renderReviewComment({ ...state(), revision: 4, completedReviews: 4 }),
          undefined,
          45
        )
      );
    }
    if (change === 'orphan') {
      comments.push(
        comment(
          renderReviewComment(
            { ...state(), revision: 4, completedReviews: 4 },
            { ...third!, commentId: 999 }
          ),
          undefined,
          45
        )
      );
    }
    f.setComments(comments);
    await expect(f.provider.loadState()).rejects.toThrow();
  });
  it('migrates a historical in-place root and recovers a timed-out append exactly once', async () => {
    const f = fixture();
    const legacyState = { ...state(), revision: 8, completedReviews: 8, nextFindingId: 12 };
    const legacyBody = renderReviewComment(legacyState);
    f.setComments([comment(legacyBody)]);
    await f.initialize();
    let previous = (await f.provider.loadState())!;
    const next = { ...legacyState, revision: 9, completedReviews: 9 };
    const body = renderReviewComment(next, previous);
    const create = f.issues.createComment.getMockImplementation()!;
    f.issues.createComment.mockImplementationOnce(async args => {
      await create(args);
      throw new Error('timeout after POST');
    });
    await f.provider.publish(previous, snapshot, next, body);
    const head = (await f.provider.loadState())!;
    expect(head.commentId).not.toBe(previous.commentId);
    expect(f.comments().find(item => item.id === previous.commentId)?.body).toBe(legacyBody);
    expect(head.state.nextFindingId).toBe(12);
    await f.newPlatform().ensureInitialized!(head, async () => null);
    await expect(f.provider.publish(previous, snapshot, next, body)).rejects.toThrow('changed');
    expect(f.canonicalCreates()).toHaveLength(1);
    expect(f.canonicalUpdates()).toHaveLength(0);
    f.setComments(f.comments().filter(item => item.id !== head.commentId));
    previous = (await f.provider.loadState())!;
    await expect(f.newPlatform().ensureInitialized!(previous, async () => null)).rejects.toThrow(
      'history'
    );
  });
  it('appends revisions 2 and 3 while preserving every preceding canonical body', async () => {
    const f = fixture();
    const legacy = renderReviewComment(state());
    f.setComments([comment(legacy)]);
    await f.initialize();
    for (const revision of [2, 3]) {
      const previous = (await f.provider.loadState())!;
      await f.provider.ensureInitialized!(previous, async () => null);
      const next = { ...state(), revision, completedReviews: revision };
      await f.provider.publish(previous, snapshot, next, renderReviewComment(next, previous));
      expect(f.comments().find(item => item.id === previous.commentId)?.body).toBe(previous.body);
      expect((await f.provider.loadState())?.state.revision).toBe(revision);
    }
    expect(f.comments().filter(item => item.body.startsWith(MARKER))).toHaveLength(3);
    expect(f.canonicalUpdates()).toHaveLength(0);
  });
  it.each(['legacy', 'wrong parent', 'skipped revision'])(
    'rejects new publication with %s before any write',
    async kind => {
      const f = fixture();
      await f.initialize();
      const next =
        kind === 'skipped revision' ? { ...state(), revision: 2, completedReviews: 2 } : state();
      const body =
        kind === 'legacy'
          ? renderReviewComment(next)
          : kind === 'wrong parent'
            ? renderReviewComment(next, history()[0]!)
            : renderReviewComment(next, null);
      await expect(f.provider.publish(null, snapshot, next, body)).rejects.toThrow('history');
      expect(f.canonicalCreates()).toHaveLength(0);
    }
  );
});

describe('GitHub canonical state', () => {
  it('pins the actual named base tip despite stale PR metadata without resetting state', async () => {
    const f = fixture();
    const previous = state();
    previous.revision = 8;
    previous.completedReviews = 7;
    previous.actionableRounds = 3;
    previous.nextFindingId = 12;
    const before = structuredClone(previous);
    await f.initialize();
    f.getRef.mockClear();
    const pinned = await f.provider.snapshot(previous);
    expect(pinned).toEqual(snapshot);
    expect(pinned.baseSha).not.toBe(f.pr.base.sha);
    expect(pinned.headSha).toBe(H);
    expect(pinned.mergeBaseSha).toBe(M);
    expect(f.getRef).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', ref: 'heads/main' });
    expect(f.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ baseSha: B, baseRef: 'main', headSha: H }),
      previous,
      'https://github.com/owner/repo.git',
      'token'
    );
    expect(previous).toEqual(before);
    await f.provider.publish(null, pinned, state(), renderReviewComment(state(), null));
    expect(f.getRef).toHaveBeenCalledTimes(2);
    expect(f.canonicalCreates()).toHaveLength(1);
  });
  it.each(['movement', 'retarget'])(
    'rejects base %s after snapshot before any comment mutation',
    async change => {
      const f = fixture();
      const body = renderReviewComment(state(), null);
      f.setComments([comment(body)]);
      const expected = await f.provider.loadState();
      const pinned = await f.provider.snapshot(expected!.state);
      if (change === 'movement') {
        f.refObject.sha = 'f'.repeat(40);
      } else {
        // Retargeting must be rejected even when both branches point at the same commit.
        f.pr.base.ref = 'release/stable';
      }
      const next = { ...state(), revision: 2, completedReviews: 2 };
      await expect(
        f.provider.publish(expected, pinned, next, renderReviewComment(next, expected))
      ).rejects.toThrow('Stale');
      expect(f.pr.base.sha).toBe('7'.repeat(40));
      expect(f.getRef).toHaveBeenLastCalledWith({
        owner: 'owner',
        repo: 'repo',
        ref: change === 'retarget' ? 'heads/release/stable' : 'heads/main',
      });
      expect(f.issues.createComment).not.toHaveBeenCalled();
      expect(f.issues.updateComment).not.toHaveBeenCalled();
      expect(await f.provider.loadState()).toEqual(expected);
    }
  );
  it('snapshots a retargeted PR using its new named branch', async () => {
    const f = fixture();
    f.pr.base.ref = 'release/stable';
    f.refObject.sha = 'f'.repeat(40);
    const pinned = await f.provider.snapshot(state());
    expect(pinned.baseRef).toBe('release/stable');
    expect(pinned.baseSha).toBe('f'.repeat(40));
    expect(f.getRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'heads/release/stable',
    });
  });
  it.each(['snapshot', 'publish'])('fails closed on a missing base ref during %s', async phase => {
    const f = fixture();
    const pinned = await f.provider.snapshot(null);
    f.getRef.mockRejectedValue(new Error('404: Reference does not exist'));
    f.prepare.mockClear();
    await expect(
      phase === 'snapshot'
        ? f.provider.snapshot(null)
        : f.provider.publish(null, pinned, state(), renderReviewComment(state(), null))
    ).rejects.toThrow('404');
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.issues.createComment).not.toHaveBeenCalled();
    expect(f.issues.updateComment).not.toHaveBeenCalled();
  });
  it.each([
    { type: 'tag', sha: B },
    { type: 'tree', sha: B },
    { type: 'commit', sha: '' },
    { type: 'commit', sha: 'b'.repeat(39) },
    { type: 'commit', sha: 'b'.repeat(41) },
    { type: 'commit', sha: 'B'.repeat(40) },
    { type: 'commit', sha: 'g'.repeat(40) },
    { type: 'commit', sha: `${B}\n` },
    {},
    null,
  ])('fails closed on invalid ref object %j', async object => {
    const f = fixture();
    f.getRef.mockResolvedValue({ data: { object: object as typeof f.refObject } });
    await expect(f.provider.snapshot(null)).rejects.toThrow('Invalid live base ref commit');
    await expect(
      f.provider.publish(null, snapshot, state(), renderReviewComment(state(), null))
    ).rejects.toThrow('Invalid live base ref commit');
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.issues.createComment).not.toHaveBeenCalled();
    expect(f.issues.updateComment).not.toHaveBeenCalled();
  });
  it.each([
    '',
    '/',
    '/main',
    'main/',
    'a//b',
    '../main',
    'a/../main',
    '.hidden',
    'a/.hidden',
    'main.lock',
    'a.lock/b',
    'main.',
    'main..old',
    'main@{1}',
    '@',
    'main\n',
    'main branch',
    'main:other',
    'main?other',
    'main*',
    'main[0]',
    'main\\other',
    'main~1',
    'main^',
  ])('rejects malformed base ref %j before resolving it', async ref => {
    const f = fixture();
    f.pr.base.ref = ref;
    await expect(f.provider.snapshot(null)).rejects.toThrow('Invalid live base ref');
    await expect(
      f.provider.publish(null, snapshot, state(), renderReviewComment(state(), null))
    ).rejects.toThrow('Invalid live base ref');
    expect(f.getRef).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.issues.createComment).not.toHaveBeenCalled();
    expect(f.issues.updateComment).not.toHaveBeenCalled();
  });
  it('ignores untrusted prose quoting a marker instead of treating it as canonical state', async () => {
    const f = fixture();
    f.setComments([
      comment('The bot wrote:\n> <!-- pi-stateful-review:v1 -->', 'user'),
      comment(renderReviewComment(state(), null)),
    ]);
    expect((await f.provider.loadState())?.commentId).toBe(42);
  });
  it('loads all pages beyond 500 comments', async () => {
    const f = fixture();
    f.setComments([
      ...Array.from({ length: 601 }, (_, i) => comment('ordinary', 'user', i)),
      comment(renderReviewComment(state(), null)),
    ]);
    expect((await f.provider.loadState())?.state.operationKey).toBe(state().operationKey);
    expect(f.issues.listComments).toHaveBeenCalledTimes(7);
  });
  it('ignores wrong authors but rejects genuine duplicates, malformed records and association mismatches', async () => {
    const f = fixture();
    const body = renderReviewComment(state(), null);
    f.setComments([comment(body, 'attacker')]);
    expect(await f.provider.loadState()).toBeNull();
    expect(f.warning).toHaveBeenCalledOnce();
    f.setComments([comment(body, 'attacker'), comment(body)]);
    expect((await f.provider.loadState())?.state.operationKey).toBe(state().operationKey);
    f.setComments([comment(body), comment(body, undefined, 43)]);
    await expect(f.provider.loadState()).rejects.toThrow('Duplicate');
    f.setComments([comment('<!-- pi-stateful-review:v1 --> broken')]);
    await expect(f.provider.loadState()).rejects.toThrow();
    const other = state();
    other.snapshot.pullNumber = 2;
    f.setComments([comment(renderReviewComment(other))]);
    await expect(f.provider.loadState()).rejects.toThrow('mismatch');
  });
  it('uses actor permissions rather than PR author trust', async () => {
    const f = fixture();
    await f.provider.authorizeControl();
    expect(f.permission).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', username: 'actor' });
    f.permission.mockResolvedValue({ data: { permission: 'read' } });
    await expect(f.provider.authorizeControl()).rejects.toThrow('write permission');
  });
  it.each(['head', 'base', 'ref', 'intent', 'closed', 'draft', 'fork'])(
    'rejects stale or unsupported %s before writing',
    async change => {
      const f = fixture();
      if (change === 'head') {
        f.pr.head.sha = 'f'.repeat(40);
      }
      if (change === 'base') {
        f.refObject.sha = 'f'.repeat(40);
      }
      if (change === 'ref') {
        f.pr.base.ref = 'other';
      }
      if (change === 'intent') {
        f.pr.body = 'changed';
      }
      if (change === 'closed') {
        f.pr.state = 'closed';
      }
      if (change === 'draft') {
        f.pr.draft = true;
      }
      if (change === 'fork') {
        f.pr.head.repo.full_name = 'fork/repo';
      }
      await expect(
        f.provider.publish(null, snapshot, state(), renderReviewComment(state(), null))
      ).rejects.toThrow();
      expect(f.issues.createComment).not.toHaveBeenCalled();
    }
  );
  it('rejects changed expected canonical body', async () => {
    const f = fixture();
    f.setComments([comment(renderReviewComment(state(), null))]);
    await expect(
      f.provider.publish(null, snapshot, state(), renderReviewComment(state(), null))
    ).rejects.toThrow('changed');
  });
  it('rejects PAT publication before creating a misleading user-owned canonical record', async () => {
    const f = fixture();
    f.installationRepos.mockRejectedValue(new Error('403: installation access token required'));
    await expect(
      f.provider.publish(null, snapshot, state(), renderReviewComment(state(), null))
    ).rejects.toThrow('GITHUB_TOKEN');
    expect(f.issues.createComment).not.toHaveBeenCalled();
  });
  it('uses server authentication rather than Octokit token-format guesses', async () => {
    const f = fixture();
    f.auth.mockResolvedValue({ token: 'opaque-action-token', tokenType: 'oauth' });
    await f.initialize();
    await f.provider.publish(null, snapshot, state(), renderReviewComment(state(), null));
    expect(f.installationRepos).toHaveBeenCalledWith({ per_page: 1 });
    expect(f.canonicalCreates()).toHaveLength(1);
  });
  it('rejects unverified snapshot authentication before preparing sources', async () => {
    const f = fixture();
    f.installationRepos.mockRejectedValue(new Error('Not an installation token'));
    await expect(f.provider.snapshot(null)).rejects.toThrow('GITHUB_TOKEN');
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it('rejects unexpected read-back ownership without creating a replacement', async () => {
    const f = fixture();
    await f.initialize();
    f.issues.createComment.mockImplementationOnce(async ({ body }) => {
      f.comments().push(comment(body, 'different-app[bot]'));
      return { data: comment(body) };
    });
    await expect(
      f.provider.publish(null, snapshot, state(), renderReviewComment(state(), null))
    ).rejects.toThrow('could not be verified');
    expect(f.canonicalCreates()).toHaveLength(1);
  });
  it('creates once and reads back', async () => {
    const f = fixture();
    await f.initialize();
    await f.provider.publish(null, snapshot, state(), renderReviewComment(state(), null));
    expect(f.canonicalCreates()).toHaveLength(1);
    expect((await f.provider.loadState())?.body).toBe(renderReviewComment(state(), null));
    expect(f.comments()).toHaveLength(2);
  });
  it('reconciles ambiguous successful creates without retry', async () => {
    const f = fixture();
    const body = renderReviewComment(state(), null);
    await f.initialize();
    f.issues.createComment.mockImplementationOnce(async () => {
      f.comments().push(comment(body));
      throw new Error('timeout');
    });
    await f.provider.publish(null, snapshot, state(), body);
    expect(f.canonicalCreates()).toHaveLength(1);
    await f.newPlatform().ensureInitialized!(await f.provider.loadState(), async () => null);
  });
  it('never edits history or retries failed creates', async () => {
    const f = fixture();
    const body = renderReviewComment(state(), null);
    f.setComments([comment(body)]);
    const expected = await f.provider.loadState();
    const next = state();
    next.revision++;
    next.completedReviews++;
    next.operationKey = 'f'.repeat(64);
    await f.initialize();
    f.issues.createComment.mockRejectedValueOnce(new Error('denied'));
    await expect(
      f.provider.publish(expected, snapshot, next, renderReviewComment(next, expected))
    ).rejects.toThrow('denied');
    expect(f.canonicalCreates()).toHaveLength(1);
    expect(f.canonicalUpdates()).toHaveLength(0);
    expect(await f.provider.loadState()).toEqual(expected);
    await expect(f.newPlatform().ensureInitialized!(expected, async () => null)).rejects.toThrow(
      'history'
    );
    await expect(
      f.provider.publish(expected, snapshot, next, renderReviewComment(next, expected))
    ).rejects.toThrow('history');
    expect(f.canonicalCreates()).toHaveLength(1);
    const fresh = fixture();
    await fresh.initialize();
    fresh.issues.createComment.mockRejectedValue(new Error('timeout'));
    await expect(fresh.provider.publish(null, snapshot, state(), body)).rejects.toThrow('timeout');
    expect(fresh.canonicalCreates()).toHaveLength(1);
  });
  it('never sends transport credentials to a server_url permalink override', async () => {
    const f = fixture();
    f.context.serverUrl = 'https://untrusted.example';
    await f.provider.snapshot(null);
    expect(f.prepare).toHaveBeenCalledWith(
      expect.anything(),
      null,
      'https://github.com/owner/repo.git',
      'token'
    );
  });
  it.each([
    'http://github.com/owner/repo.git',
    'https://user:password@github.com/owner/repo.git',
    'https://github.com/other/repo.git',
    'https://github.com/owner/repo.git?extra=1',
  ])('rejects unsafe repository clone URL %s', async url => {
    const f = fixture();
    f.pr.base.repo.clone_url = url;
    await expect(f.provider.snapshot(null)).rejects.toThrow('Unsafe repository clone URL');
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it('prepares only live pinned metadata, refusing forks/drafts', async () => {
    const f = fixture();
    await f.provider.snapshot(null);
    expect(f.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: H, baseSha: B }),
      null,
      'https://github.com/owner/repo.git',
      'token'
    );
    f.pr.draft = true;
    await expect(f.provider.snapshot(null)).rejects.toThrow('non-draft');
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });
});
