import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ReviewChangedFile,
  ReviewChangedHunk,
  ReviewCoverageInventory,
  ReviewIdentity,
} from '@alexanderfortin/pi-orchestrator';

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 10_000;
type RawGit = (...args: string[]) => Promise<Buffer>;
interface TreeEntry {
  blob: string;
  mode: string;
}
type Change = Pick<ReviewChangedFile, 'path' | 'previousPath' | 'status'>;

function decode(buffer: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

function changes(buffer: Buffer): Change[] {
  if (!buffer.length) {
    return [];
  }
  const fields = decode(buffer).split('\0');
  if (fields.pop() !== '') {
    throw new Error('Invalid inventory name-status output');
  }
  const result: Change[] = [];
  const statuses = {
    A: 'added',
    M: 'modified',
    D: 'deleted',
    R: 'renamed',
    C: 'copied',
    T: 'type_changed',
  } as const;
  for (let i = 0; i < fields.length;) {
    const code = fields[i++]!;
    const match = /^([AMDTRC])(?:\d+)?$/.exec(code);
    if (!match) {
      throw new Error('Unsupported inventory change status');
    }
    const status = statuses[match[1] as keyof typeof statuses];
    const first = fields[i++];
    const path = status === 'renamed' || status === 'copied' ? fields[i++] : first;
    if (!first || !path) {
      throw new Error('Invalid inventory change path');
    }
    result.push({
      path,
      previousPath: status === 'renamed' || status === 'copied' ? first : null,
      status,
    });
    if (result.length > MAX_FILES) {
      throw new Error('Inventory file limit exceeded');
    }
  }
  return result;
}

function patches(buffer: Buffer): Buffer[] {
  if (!buffer.length) {
    return [];
  }
  if (!buffer.subarray(0, 11).equals(Buffer.from('diff --git '))) {
    throw new Error('Invalid inventory patch output');
  }
  const starts = [0];
  const boundary = Buffer.from('\ndiff --git ');
  for (let offset = 0; ;) {
    const next = buffer.indexOf(boundary, offset);
    if (next < 0) {
      break;
    }
    starts.push(next + 1);
    if (starts.length > MAX_FILES) {
      throw new Error('Inventory file limit exceeded');
    }
    offset = next + boundary.length;
  }
  return starts.map((start, i) => buffer.subarray(start, starts[i + 1] ?? buffer.length));
}

function hunks(patch: Buffer): ReviewChangedHunk[] {
  const lines = patch.toString('latin1').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const result: ReviewChangedHunk[] = [];
  for (const [i, line] of lines.entries()) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) {
      continue;
    }
    if (result.length) {
      result[result.length - 1]!.patchEndLine = i;
    }
    result.push({
      index: result.length,
      patchStartLine: i + 1,
      patchEndLine: lines.length,
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return result;
}

export async function prepareReviewCoverageInventory(
  root: string,
  identity: ReviewIdentity,
  previousHeadSha: string | null,
  rawGit: RawGit
): Promise<string> {
  let metadataBytes = 0;
  let patchBytes = 0;
  let fileCount = 0;
  const trees = new Map<string, Map<string, TreeEntry>>();
  async function metadata(...args: string[]) {
    const value = await rawGit(...args);
    metadataBytes += value.length;
    if (metadataBytes > MAX_BYTES) {
      throw new Error('Inventory metadata byte limit exceeded');
    }
    return value;
  }
  async function tree(sha: string) {
    const cached = trees.get(sha);
    if (cached) {
      return cached;
    }
    const entries = decode(await metadata('ls-tree', '-r', '-z', sha)).split('\0');
    if (entries.pop() !== '') {
      throw new Error('Invalid inventory tree output');
    }
    if (entries.length > MAX_FILES) {
      throw new Error('Inventory tree file limit exceeded');
    }
    const result = new Map<string, TreeEntry>();
    for (const entry of entries) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
      if (!match) {
        throw new Error('Unsupported inventory entry (symlink/submodule)');
      }
      result.set(match[3]!, { mode: match[1]!, blob: match[2]! });
    }
    trees.set(sha, result);
    return result;
  }
  async function inventory(from: string, basis: 'full' | 'incremental') {
    const oldTree = await tree(from);
    const newTree = await tree(identity.headSha);
    const diffArgs = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '-l0'];
    const files = changes(
      await metadata('diff', ...diffArgs, '--name-status', '-z', from, identity.headSha, '--')
    );
    fileCount += files.length;
    if (fileCount > MAX_FILES) {
      throw new Error('Inventory file limit exceeded');
    }
    const diff = await rawGit('diff', ...diffArgs, '--binary', from, identity.headSha, '--');
    patchBytes += diff.length;
    if (patchBytes > MAX_BYTES) {
      throw new Error('Inventory patch byte limit exceeded');
    }
    // Both formats use the same diffcore ordering. Only section boundaries are read;
    // quoted filename headers never supply file identities or paths.
    const sections = patches(diff);
    if (sections.length !== files.length) {
      throw new Error('Inventory patch/file count mismatch');
    }
    const directory = join(root, `coverage-${basis}`);
    await mkdir(directory);
    const result: ReviewChangedFile[] = [];
    for (const [index, file] of files.entries()) {
      const old = file.status === 'added' ? undefined : oldTree.get(file.previousPath ?? file.path);
      const next = file.status === 'deleted' ? undefined : newTree.get(file.path);
      if ((!old && file.status !== 'added') || (!next && file.status !== 'deleted')) {
        throw new Error('Inventory tree/change mismatch');
      }
      const patch = sections[index]!;
      const metadata = {
        ...file,
        oldBlob: old?.blob ?? null,
        newBlob: next?.blob ?? null,
        oldMode: old?.mode ?? null,
        newMode: next?.mode ?? null,
        binary: /^(GIT binary patch|Binary files )/m.test(patch.toString('latin1')),
        patchBytes: patch.length,
        hunks: hunks(patch),
      };
      const id = createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
      const patchPath = join(directory, `${id}.diff`);
      await writeFile(patchPath, patch, { flag: 'wx', mode: 0o644 });
      result.push({ id, ...metadata, patchPath });
    }
    return result;
  }
  const value: ReviewCoverageInventory = {
    version: 1,
    identity,
    previousHeadSha,
    full: await inventory(identity.mergeBaseSha, 'full'),
    incremental: previousHeadSha ? await inventory(previousHeadSha, 'incremental') : null,
  };
  const path = join(root, 'coverage-inventory.json');
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_BYTES) {
    throw new Error('Inventory JSON byte limit exceeded');
  }
  await writeFile(path, serialized, { flag: 'wx', mode: 0o644 });
  return path;
}
