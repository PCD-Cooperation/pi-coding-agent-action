import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { ReviewIdentity, ReviewSnapshot, ReviewState } from '@alexanderfortin/pi-orchestrator';

const exec = promisify(execFile);
const MAX_BYTES = 128 * 1024 * 1024;

/** Host-only git; never executes a shell, PR scripts, submodules, or PR symlinks.
 * Complete ancestry is fetched (no --depth). Output/file limits fail closed.
 * Successful snapshot directories live for the job lifetime; runners must clean temp.
 */
export async function prepareReviewSnapshot(
  identity: Omit<ReviewIdentity, 'mergeBaseSha'>,
  previous: ReviewState | null,
  remote: string,
  token?: string
): Promise<ReviewSnapshot> {
  const root = await mkdtemp(join(tmpdir(), 'pi-review-'));
  const gitDir = join(root, 'objects.git');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'https',
    GIT_LFS_SKIP_SMUDGE: '1',
    ...(token
      ? {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraHeader',
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
        }
      : {}),
  };
  async function git(...args: string[]) {
    return (await rawGit(...args)).toString('utf8');
  }
  async function rawGit(...args: string[]) {
    const { stdout } = await exec(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.symlinks=false',
        '-c',
        'core.attributesFile=/dev/null',
        '-c',
        'protocol.file.allow=never',
        '-c',
        'http.followRedirects=false',
        `--git-dir=${gitDir}`,
        ...args,
      ],
      { env, encoding: 'buffer', maxBuffer: MAX_BYTES, timeout: 180_000 }
    );
    return stdout;
  }
  const validSha = (sha: string) => {
    if (!/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error('Invalid snapshot SHA');
    }
    return sha;
  };
  async function fetch(sha: string) {
    await git('fetch', '--no-tags', '--no-recurse-submodules', remote, validSha(sha));
    if ((await git('rev-parse', `${sha}^{commit}`)).trim() !== sha) {
      throw new Error('Fetched SHA mismatch');
    }
  }
  async function materialize(sha: string, name: string) {
    const tree = await rawGit('ls-tree', '-r', '-l', '-z', sha);
    const entries = new TextDecoder('utf-8', { fatal: true })
      .decode(tree)
      .split('\0')
      .filter(Boolean);
    let size = 0;
    if (entries.length > 10_000) {
      throw new Error('Snapshot file limit exceeded');
    }
    const files: { path: string; blob: string; mode: number }[] = [];
    const names = new Set<string>();
    for (const entry of entries) {
      const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]*)$/.exec(entry);
      if (!match || !['100644', '100755'].includes(match[1]!)) {
        throw new Error('Unsupported snapshot entry (symlink/submodule)');
      }
      size += Number(match[3]);
      const path = match[4]!;
      const normalized = path.normalize('NFC').toLowerCase();
      if (
        names.has(normalized) ||
        isAbsolute(path) ||
        path
          .split('/')
          .some(
            part => part.toLowerCase() === '.git' || part === '..' || part === '.' || part === ''
          ) ||
        path.includes('\\')
      ) {
        throw new Error('Unsafe or case-colliding snapshot path');
      }
      names.add(normalized);
      files.push({ path, blob: validSha(match[2]!), mode: 0o644 });
    }
    if (size > MAX_BYTES) {
      throw new Error('Snapshot byte limit exceeded');
    }
    const path = join(root, name);
    await mkdir(path);
    // Raw blob reads bypass *all* tracked attributes, filters and encoding conversion.
    // Keep review input non-executable, even when its Git executable bit is set.
    for (let offset = 0; offset < files.length; offset += 8) {
      const results = await Promise.allSettled(
        files.slice(offset, offset + 8).map(async file => {
          const target = join(path, file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, await rawGit('cat-file', 'blob', file.blob), {
            flag: 'wx',
            mode: file.mode,
          });
        })
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          throw result.reason;
        }
      }
    }
    return path;
  }
  try {
    await git('init', '--bare', '--template=');
    await fetch(identity.headSha);
    await fetch(identity.baseSha);
    const mergeBases = (await git('merge-base', '--all', identity.baseSha, identity.headSha))
      .trim()
      .split('\n');
    if (mergeBases.length !== 1) {
      throw new Error('Ambiguous merge base');
    }
    const mergeBaseSha = validSha(mergeBases[0]!);
    const headPath = await materialize(identity.headSha, 'head');
    const basePath = await materialize(mergeBaseSha, 'base');
    const fullDiffPath = join(root, 'full.diff');
    await writeFile(
      fullDiffPath,
      await git(
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--binary',
        mergeBaseSha,
        identity.headSha,
        '--'
      )
    );
    let fallbackReason: string | null = previous ? null : 'No previous completed review';
    let previousPath: string | null = null;
    let incrementalDiffPath: string | null = null;
    if (previous && previous.snapshot.baseRef !== identity.baseRef) {
      fallbackReason = 'Base ref changed';
    } else if (previous && previous.snapshot.mergeBaseSha !== mergeBaseSha) {
      fallbackReason = 'Merge base changed';
    } else if (previous) {
      try {
        await fetch(previous.snapshot.headSha);
      } catch {
        fallbackReason = 'Previous reviewed head unavailable';
      }
      if (!fallbackReason) {
        previousPath = await materialize(previous.snapshot.headSha, 'previous');
        incrementalDiffPath = join(root, 'incremental.diff');
        await writeFile(
          incrementalDiffPath,
          await git(
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--binary',
            previous.snapshot.headSha,
            identity.headSha,
            '--'
          )
        );
      }
    }
    return {
      ...identity,
      mergeBaseSha,
      mode: incrementalDiffPath ? 'incremental' : 'full',
      fallbackReason,
      headPath,
      basePath,
      previousPath,
      fullDiffPath,
      incrementalDiffPath,
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
