import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ReviewCoverageInventory,
  ReviewIdentity,
  ReviewSnapshot,
  ReviewState,
} from '@alexanderfortin/pi-orchestrator';
import { prepareReviewSnapshot } from '../src/review-snapshot';

const gitExec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async () => {
  const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  return {
    ...original,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: gitExec }),
  };
});

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })));
  gitExec.mockReset();
});

async function fixture() {
  const actual = await vi.importActual<{ execFile: typeof execFile }>('node:child_process');
  const exec = promisify(actual.execFile);
  const root = await mkdtemp(join(tmpdir(), 'pi-inventory-fixture-'));
  cleanup.push(root);
  const git = async (...args: string[]) =>
    (
      await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      })
    ).stdout.trim();
  const put = (path: string, contents: string | Buffer) => writeFile(join(root, path), contents);
  const commit = async (message: string) => {
    await git('add', '.');
    await git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  await git('init', '--initial-branch=main', '--template=');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'core.fileMode', 'true');
  const oldName = 'old café 日本語.txt';
  const newName = ':renamed [*] 日本語\t"\n.txt';
  const strangeName = ':(exclude) glob[*] - café\t"\n.txt';
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index}\n`);
  await put(oldName, 'unique rename contents\n'.repeat(10));
  await put('deleted.txt', 'delete this\n');
  await put('empty-deleted.txt', '');
  await put('mode-only.sh', '#!/bin/sh\nexit 99\n');
  await put('binary.dat', Buffer.from([0, 1, 2, 3]));
  await put('multi.txt', lines.join(''));
  const mergeBaseSha = await commit('merge base');
  await put('previous-only.txt', 'present only at previous head\n');
  const previousHeadSha = await commit('previous');
  await git('mv', '--', oldName, newName);
  await rm(join(root, 'deleted.txt'));
  await rm(join(root, 'empty-deleted.txt'));
  await rm(join(root, 'previous-only.txt'));
  await put('empty-added.txt', '');
  await put('empty-added-other.txt', '');
  await put(strangeName, 'unusual literal Git path\n');
  await put('-leading-dash.txt', 'dash\n');
  await put('binary.dat', Buffer.from([0, 9, 8, 7]));
  lines[1] = 'changed first hunk\n';
  lines[38] = 'changed second hunk\n';
  await put('multi.txt', lines.join(''));
  await git('add', '.');
  await git('update-index', '--chmod=+x', '--', 'mode-only.sh');
  await git('commit', '-m', 'head');
  const headSha = await git('rev-parse', 'HEAD');
  const identity: Omit<ReviewIdentity, 'mergeBaseSha'> = {
    repository: 'owner/repo',
    pullNumber: 1,
    headSha,
    baseSha: mergeBaseSha,
    baseRef: 'main',
    intentHash: 'a'.repeat(64),
  };
  const previous: ReviewState = {
    schemaVersion: 1,
    revision: 1,
    snapshot: { ...identity, headSha: previousHeadSha, mergeBaseSha },
    configurationHash: 'b'.repeat(64),
    operationKey: 'c'.repeat(64),
    completedReviews: 1,
    reviewMode: 'full',
    fallbackReason: null,
    coverageNotes: '',
    actionableRounds: 0,
    needsHuman: false,
    nextFindingId: 1,
    findings: [],
    intervention: null,
  };
  // Only the trusted transport adapter changes; snapshot extraction still uses real Git.
  gitExec.mockImplementation((command, args, options) =>
    exec(
      command,
      args.map((arg: string) =>
        arg === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : arg
      ),
      { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file' } }
    )
  );
  const snapshot = async (prior: ReviewState | null = previous, coverage = true) => {
    const result = await prepareReviewSnapshot(identity, prior, root, undefined, { coverage });
    cleanup.push(dirname(result.headPath));
    return result;
  };
  return { root, git, identity, previous, snapshot, oldName, newName, strangeName };
}

async function inventory(snapshot: ReviewSnapshot): Promise<ReviewCoverageInventory> {
  return JSON.parse(await readFile(snapshot.coverageInventoryPath!, 'utf8'));
}

describe('host Git coverage inventory', () => {
  it('preserves endpoint blob/mode identities, literal paths and all metadata-only changes', async () => {
    const f = await fixture();
    const snapshot = await f.snapshot();
    const value = await inventory(snapshot);
    expect(value.version).toBe(1);
    expect(value.identity).toEqual({ ...f.identity, mergeBaseSha: f.identity.baseSha });
    expect(value.previousHeadSha).toBe(f.previous.snapshot.headSha);
    expect(snapshot.mode).toBe('incremental');
    const files = new Map(value.full.map(file => [file.path, file]));
    expect(files.get(f.newName)).toMatchObject({
      status: 'renamed',
      previousPath: f.oldName,
      hunks: [],
    });
    expect(files.get(f.newName)!.oldBlob).toBe(files.get(f.newName)!.newBlob);
    expect(files.has(f.oldName)).toBe(false);
    expect(files.get('deleted.txt')).toMatchObject({
      status: 'deleted',
      previousPath: null,
      newBlob: null,
      newMode: null,
    });
    expect(files.get('deleted.txt')!.oldBlob).toMatch(/^[a-f0-9]{40}$/);
    const empty = value.full.filter(file => file.path.startsWith('empty-'));
    expect(empty).toHaveLength(2);
    expect(empty.find(file => file.status === 'added')).toMatchObject({ hunks: [], oldBlob: null });
    expect(empty.find(file => file.status === 'renamed')).toMatchObject({
      hunks: [],
      previousPath: 'empty-deleted.txt',
    });
    const mode = files.get('mode-only.sh')!;
    expect(mode).toMatchObject({
      status: 'modified',
      oldMode: '100644',
      newMode: '100755',
      hunks: [],
    });
    expect(mode.oldBlob).toBe(mode.newBlob);
    expect(mode.oldBlob).toMatch(/^[a-f0-9]{40}$/);
    expect((await stat(join(snapshot.headPath, mode.path))).mode & 0o111).toBe(0);
    const binary = files.get('binary.dat')!;
    expect(binary).toMatchObject({ binary: true, hunks: [] });
    expect(await readFile(binary.patchPath, 'utf8')).toContain('GIT binary patch');
    expect(files.get(f.strangeName)).toMatchObject({ path: f.strangeName, status: 'added' });
    expect(files.get('-leading-dash.txt')).toMatchObject({ status: 'added' });
    for (const file of [...value.full, ...value.incremental!]) {
      expect(isAbsolute(file.patchPath)).toBe(true);
      expect(file.patchPath.startsWith(dirname(snapshot.headPath) + '/')).toBe(true);
      expect(file.id).toMatch(/^[a-f0-9]{64}$/);
      expect((await stat(file.patchPath)).mode & 0o111).toBe(0);
      expect((await readFile(file.patchPath)).length).toBe(file.patchBytes);
      expect((await readFile(file.patchPath, 'utf8')).match(/^diff --git /gm)).toHaveLength(1);
    }
    expect(files.has('previous-only.txt')).toBe(false);
    expect(value.incremental!.find(file => file.path === 'previous-only.txt')).toMatchObject({
      status: 'deleted',
      newBlob: null,
    });
  }, 30_000);

  it('indexes exact 1-based inclusive hunk header/body ranges and is stable across temp roots', async () => {
    const f = await fixture();
    const first = await f.snapshot();
    const second = await f.snapshot();
    const a = await inventory(first);
    const b = await inventory(second);
    expect(first.coverageInventoryPath).not.toBe(second.coverageInventoryPath);
    expect(a.full.map(({ patchPath: _path, ...file }) => file)).toEqual(
      b.full.map(({ patchPath: _path, ...file }) => file)
    );
    expect(a.incremental!.map(file => file.id)).toEqual(b.incremental!.map(file => file.id));
    const file = a.full.find(file => file.path === 'multi.txt')!;
    const patchLines = (await readFile(file.patchPath, 'utf8')).trimEnd().split('\n');
    expect(file.hunks).toHaveLength(2);
    expect(file.hunks.map(hunk => hunk.index)).toEqual([0, 1]);
    expect(file.hunks[0]!.patchEndLine).toBe(file.hunks[1]!.patchStartLine - 1);
    expect(file.hunks[1]!.patchEndLine).toBe(patchLines.length);
    for (const hunk of file.hunks) {
      const lines = patchLines.slice(hunk.patchStartLine - 1, hunk.patchEndLine);
      expect(lines[0]).toContain(
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
      );
      expect(
        lines.slice(1).filter(line => line.startsWith(' ') || line.startsWith('-'))
      ).toHaveLength(hunk.oldLines);
      expect(
        lines.slice(1).filter(line => line.startsWith(' ') || line.startsWith('+'))
      ).toHaveLength(hunk.newLines);
    }
  }, 30_000);

  it('is opt-in, supports full fallback, and keeps same-SHA artifacts distinct', async () => {
    const f = await fixture();
    const disabled = await f.snapshot(f.previous, false);
    expect(disabled.coverageInventoryPath).toBeUndefined();
    expect(gitExec.mock.calls.some(([, args]) => args.includes('--name-status'))).toBe(false);
    const full = await inventory(await f.snapshot(null));
    expect(full.incremental).toBeNull();
    expect(full.previousHeadSha).toBeNull();
    const fallback = await f.snapshot({
      ...f.previous,
      snapshot: { ...f.previous.snapshot, baseRef: 'other' },
    });
    expect(fallback.mode).toBe('full');
    expect((await inventory(fallback)).incremental).toBeNull();
    const same = await prepareReviewSnapshot(
      { ...f.identity, headSha: f.identity.baseSha },
      null,
      f.root,
      undefined,
      { coverage: true }
    );
    cleanup.push(dirname(same.headPath));
    expect(same.basePath).toBe(same.headPath);
    expect(same.coverageInventoryPath).not.toBe(same.headPath);
    expect((await inventory(same)).full).toEqual([]);
    const samePrevious = await f.snapshot({
      ...f.previous,
      snapshot: { ...f.previous.snapshot, headSha: f.identity.headSha },
    });
    expect((await inventory(samePrevious)).incremental).toEqual([]);
    expect((await inventory(samePrevious)).full.length).toBeGreaterThan(0);
  }, 30_000);

  it.each(['count', 'incremental-diff', 'invalid-utf8'])(
    'fails closed and cleans the job root on inventory %s failure',
    async failure => {
      const f = await fixture();
      const real = gitExec.getMockImplementation()!;
      let root = '';
      gitExec.mockImplementation(async (command, args: string[], options) => {
        root = dirname(args.find(arg => arg.startsWith('--git-dir='))!.slice('--git-dir='.length));
        if (args.includes('--name-status') && failure === 'count') {
          return { stdout: Buffer.from('A\0file\0'.repeat(10_001)), stderr: Buffer.alloc(0) };
        }
        if (args.includes('--name-status') && failure === 'invalid-utf8') {
          return { stdout: Buffer.from([65, 0, 255, 0]), stderr: Buffer.alloc(0) };
        }
        if (
          args.includes('--binary') &&
          args.includes('--find-renames') &&
          args.includes(f.previous.snapshot.headSha) &&
          failure === 'incremental-diff'
        ) {
          throw new Error('inventory diff failure');
        }
        return real(command, args, options);
      });
      await expect(f.snapshot()).rejects.toThrow();
      expect(root).not.toBe('');
      await expect(access(root)).rejects.toThrow();
    },
    30_000
  );

  it('retains symlink rejection with coverage enabled', async () => {
    const f = await fixture();
    await symlink('deleted.txt', join(f.root, 'unsafe'));
    await f.git('add', '.');
    await f.git('commit', '-m', 'unsafe link');
    await expect(
      prepareReviewSnapshot(
        { ...f.identity, headSha: await f.git('rev-parse', 'HEAD') },
        null,
        f.root,
        undefined,
        { coverage: true }
      )
    ).rejects.toThrow('symlink');
  }, 30_000);
});
