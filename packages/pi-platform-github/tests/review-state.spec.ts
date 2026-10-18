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
import type { ReviewState, ReviewSnapshot } from '@alexanderfortin/pi-orchestrator';
import type { GitHubModuleDeps } from '../src/types';
import { createStatefulReviewPlatform } from '../src/review-state';

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const M = 'c'.repeat(40);
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
  const pr = {
    state: 'open',
    draft: false,
    merged: false,
    title: 'Title',
    body: 'Body',
    head: { sha: H, repo: { full_name: 'owner/repo' } },
    base: {
      sha: B,
      ref: 'main',
      repo: { full_name: 'owner/repo', clone_url: 'https://github.com/owner/repo.git' },
    },
  };
  const issues = {
    listComments: vi.fn(async ({ page, per_page }: { page: number; per_page: number }) => ({
      data: comments.slice((page - 1) * per_page, page * per_page),
    })),
    createComment: vi.fn(async ({ body }: { body: string }) => {
      comments.push(comment(body));
      return { data: comments.at(-1) };
    }),
    updateComment: vi.fn(async ({ body }: { body: string }) => {
      comments = [comment(body)];
      return { data: comments[0] };
    }),
  };
  const permission = vi.fn(async () => ({ data: { permission: 'write' } }));
  const prepare = vi.fn(async () => snapshot);
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
        repos: { getCollaboratorPermissionLevel: permission },
      },
    },
  } as unknown as GitHubModuleDeps;
  return {
    provider: createStatefulReviewPlatform(deps, prepare),
    issues,
    pr,
    permission,
    auth,
    installationRepos,
    warning,
    prepare,
    context: deps.context,
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
      const identity = { ...snapshot, headSha, baseSha };
      const previous = state();
      previous.snapshot.headSha = previousSha;
      previous.snapshot.mergeBaseSha = baseSha;
      const result = await prepareReviewSnapshot(identity, previous, fixturePath);
      snapshots.push(dirname(result.headPath));
      expect(result.mode).toBe('incremental');
      expect(result.mergeBaseSha).toBe(baseSha);
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

describe('GitHub canonical state', () => {
  it('ignores untrusted prose quoting a marker instead of treating it as canonical state', async () => {
    const f = fixture();
    f.setComments([
      comment('The bot wrote:\n> <!-- pi-stateful-review:v1 -->', 'user'),
      comment(renderReviewComment(state())),
    ]);
    expect((await f.provider.loadState())?.commentId).toBe(42);
  });
  it('loads all pages beyond 500 comments', async () => {
    const f = fixture();
    f.setComments([
      ...Array.from({ length: 601 }, (_, i) => comment('ordinary', 'user', i)),
      comment(renderReviewComment(state())),
    ]);
    expect((await f.provider.loadState())?.state.operationKey).toBe(state().operationKey);
    expect(f.issues.listComments).toHaveBeenCalledTimes(7);
  });
  it('ignores wrong authors but rejects genuine duplicates, malformed records and association mismatches', async () => {
    const f = fixture();
    const body = renderReviewComment(state());
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
        f.pr.base.sha = 'f'.repeat(40);
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
        f.provider.publish(null, snapshot, state(), renderReviewComment(state()))
      ).rejects.toThrow();
      expect(f.issues.createComment).not.toHaveBeenCalled();
    }
  );
  it('rejects changed expected canonical body', async () => {
    const f = fixture();
    f.setComments([comment(renderReviewComment(state()))]);
    await expect(
      f.provider.publish(null, snapshot, state(), renderReviewComment(state()))
    ).rejects.toThrow('changed');
  });
  it('rejects PAT publication before creating a misleading user-owned canonical record', async () => {
    const f = fixture();
    f.installationRepos.mockRejectedValue(new Error('403: installation access token required'));
    await expect(
      f.provider.publish(null, snapshot, state(), renderReviewComment(state()))
    ).rejects.toThrow('GITHUB_TOKEN');
    expect(f.issues.createComment).not.toHaveBeenCalled();
  });
  it('uses server authentication rather than Octokit token-format guesses', async () => {
    const f = fixture();
    f.auth.mockResolvedValue({ token: 'opaque-action-token', tokenType: 'oauth' });
    await f.provider.publish(null, snapshot, state(), renderReviewComment(state()));
    expect(f.installationRepos).toHaveBeenCalledWith({ per_page: 1 });
    expect(f.issues.createComment).toHaveBeenCalledOnce();
  });
  it('rejects unverified snapshot authentication before preparing sources', async () => {
    const f = fixture();
    f.installationRepos.mockRejectedValue(new Error('Not an installation token'));
    await expect(f.provider.snapshot(null)).rejects.toThrow('GITHUB_TOKEN');
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it('rejects unexpected read-back ownership without creating a replacement', async () => {
    const f = fixture();
    f.issues.createComment.mockImplementationOnce(async ({ body }) => {
      f.setComments([comment(body, 'different-app[bot]')]);
      return { data: comment(body) };
    });
    await expect(
      f.provider.publish(null, snapshot, state(), renderReviewComment(state()))
    ).rejects.toThrow('could not be verified');
    expect(f.issues.createComment).toHaveBeenCalledTimes(1);
  });
  it('creates once and reads back', async () => {
    const f = fixture();
    await f.provider.publish(null, snapshot, state(), renderReviewComment(state()));
    expect(f.issues.createComment).toHaveBeenCalledTimes(1);
    expect(f.issues.listComments).toHaveBeenCalledTimes(2);
  });
  it('reconciles ambiguous successful creates without retry', async () => {
    const f = fixture();
    const body = renderReviewComment(state());
    f.issues.createComment.mockImplementationOnce(async () => {
      f.setComments([comment(body)]);
      throw new Error('timeout');
    });
    await f.provider.publish(null, snapshot, state(), body);
    expect(f.issues.createComment).toHaveBeenCalledTimes(1);
  });
  it('never replaces failed updates or retries failed creates', async () => {
    const f = fixture();
    const body = renderReviewComment(state());
    f.setComments([comment(body)]);
    const expected = await f.provider.loadState();
    const next = state();
    next.revision++;
    next.completedReviews++;
    next.operationKey = 'f'.repeat(64);
    f.issues.updateComment.mockRejectedValue(new Error('denied'));
    await expect(
      f.provider.publish(expected, snapshot, next, renderReviewComment(next))
    ).rejects.toThrow('denied');
    expect(f.issues.createComment).not.toHaveBeenCalled();
    f.setComments([]);
    f.issues.createComment.mockRejectedValue(new Error('timeout'));
    await expect(f.provider.publish(null, snapshot, state(), body)).rejects.toThrow('timeout');
    expect(f.issues.createComment).toHaveBeenCalledTimes(1);
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
