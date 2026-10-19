import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument, visit } from 'yaml';
import type { ReviewSnapshot } from './types';

const REPOSITORIES = ['PCD-Cooperation/pi-coding-agent-action', 'shaftoe/pi-coding-agent-action'];
const FILES = [
  { path: 'action.yml', optional: false },
  { path: 'packages/pi-orchestrator/src/orchestrator.ts', optional: false },
  { path: 'packages/pi-action/src/adapters/git-adapter.ts', optional: false },
  { path: 'packages/pi-platform-github/src/comments.ts', optional: false },
  // Stateful review contracts did not exist in older approved action versions.
  { path: 'packages/pi-orchestrator/src/review/runner.ts', optional: true },
  { path: 'packages/pi-orchestrator/src/review/state.ts', optional: true },
  { path: 'packages/pi-platform-github/src/review-state.ts', optional: true },
];
const DIFF_LIMIT = 8 * 1024 * 1024;
const FILE_LIMIT = 64 * 1024;
const TOTAL_LIMIT = 256 * 1024;

export interface ReviewDependencies {
  policyVersion: string;
  complete: boolean;
  contexts: {
    repository: string;
    sha: string;
    files: { path: string; localPath: string; sha256: string }[];
  }[];
  notes: string[];
}

interface DependencyOptions {
  fetch?: typeof fetch;
  tempRoot?: string;
}

async function readBounded(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error('not a regular file');
    }
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) {
        return buffer.subarray(0, size);
      }
      size += bytesRead;
    }
    throw new Error(`exceeds ${limit} byte safe read limit`);
  } finally {
    await handle.close();
  }
}

function workflowPaths(diff: string, notes: string[]): string[] {
  const paths = new Set<string>();
  const lines = diff.split('\n');
  const gitHeaders = lines.some(line => line.startsWith('diff --git '));
  let oldRemaining = 0;
  let newRemaining = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    let tokens: string[];
    if (gitHeaders) {
      if (!line.startsWith('diff --git ')) {
        continue;
      }
      const match = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(line);
      if (!match) {
        if (line.includes('.github/workflows/')) {
          notes.push('Unsupported workflow diff header.');
        }
        continue;
      }
      tokens = match.slice(1);
    } else {
      // Hunk payload can resemble file markers; only inspect actual unified headers.
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldRemaining = Number(hunk[1] ?? 1);
        newRemaining = Number(hunk[2] ?? 1);
        continue;
      }
      if (oldRemaining > 0 || newRemaining > 0) {
        if (line.startsWith(' ') || line.startsWith('-')) {
          oldRemaining--;
        }
        if (line.startsWith(' ') || line.startsWith('+')) {
          newRemaining--;
        }
        continue;
      }
      if (!line.startsWith('--- ') || !lines[index + 1]?.startsWith('+++ ')) {
        continue;
      }
      tokens = [line.slice(4), lines[++index]!.slice(4)].map(token => token.split('\t')[0]!);
    }
    for (const token of tokens) {
      let path: string;
      try {
        path = token.startsWith('"') ? (JSON.parse(token) as string) : token;
      } catch {
        if (token.includes('.github/workflows/')) {
          notes.push('Unsupported quoted workflow diff path.');
        }
        continue;
      }
      path = path.replace(/^[ab]\//, '');
      if (!path.startsWith('.github/workflows/') || !/\.ya?ml$/.test(path)) {
        continue;
      }
      if (!/^\.github\/workflows\/[A-Za-z0-9_. -]+\.ya?ml$/.test(path)) {
        notes.push(`Rejected unsafe or unsupported workflow path: ${JSON.stringify(path)}`);
        continue;
      }
      paths.add(path);
    }
  }
  return [...paths].sort();
}

async function readWorkflow(root: string, path: string): Promise<Buffer> {
  let current = root;
  for (const part of ['', ...path.split('/')]) {
    if (part) {
      current = join(current, part);
    }
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error('symlink rejected');
    }
  }
  return readBounded(current, 256 * 1024);
}

function workflowUses(source: Buffer): string[] {
  const document = parseDocument(source.toString('utf8'), { schema: 'failsafe', uniqueKeys: true });
  if (document.errors.length || document.warnings.length) {
    throw new Error('workflow YAML has parse errors or warnings');
  }
  visit(document, {
    Alias() {
      throw new Error('workflow YAML aliases are not supported');
    },
  });
  const pending: unknown[] = [document.toJS({ maxAliasCount: 0, mapAsMap: true })];
  const references: string[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      pending.push(...node);
    } else if (node instanceof Map) {
      for (const [key, value] of node as Map<unknown, unknown>) {
        if (typeof key !== 'string') {
          throw new Error('workflow YAML mapping keys must be strings');
        }
        if (key.toLowerCase() === 'uses') {
          if (typeof value !== 'string') {
            throw new Error('workflow YAML uses values must be strings');
          }
          references.push(value.trim());
        } else {
          pending.push(value);
        }
      }
    }
  }
  return references;
}

async function withDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('dependency preparation deadline exceeded'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function fetchBounded(
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal,
  budget: { bytes: number },
  optional: boolean
): Promise<Buffer | undefined> {
  signal.throwIfAborted();
  const response = await withDeadline(
    fetcher(url, {
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    }),
    signal
  );
  if (
    optional &&
    response.status === 404 &&
    !response.redirected &&
    response.type !== 'opaqueredirect'
  ) {
    void response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.ok || response.redirected || response.type === 'opaqueredirect') {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${response.status} or redirect rejected`);
  }
  if (!response.body) {
    throw new Error('missing response body');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await withDeadline(reader.read(), signal);
      if (done) {
        break;
      }
      size += value.byteLength;
      budget.bytes += value.byteLength;
      if (size > FILE_LIMIT || budget.bytes > TOTAL_LIMIT) {
        throw new Error('dependency byte limit exceeded');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function prepareReviewDependencies(
  snapshot: ReviewSnapshot,
  options: DependencyOptions = {}
): Promise<ReviewDependencies> {
  const result: ReviewDependencies = {
    policyVersion: 'approved-action-pins-v3',
    complete: true,
    contexts: [],
    notes: [],
  };
  const overall = AbortSignal.timeout(45_000);
  const fail = (note: string) => {
    result.complete = false;
    result.notes.push(note);
  };
  let paths: string[];
  try {
    paths = workflowPaths(
      (await readBounded(snapshot.fullDiffPath, DIFF_LIMIT)).toString('utf8'),
      result.notes
    );
    if (result.notes.length) {
      result.complete = false;
    }
  } catch (error) {
    fail(`Dependency discovery unavailable: ${String(error)}`);
    return result;
  }
  if (paths.length > 128) {
    fail('Workflow path count exceeds 128; dependency discovery omitted.');
    return result;
  }
  const references = new Map<string, { repository: string; sha: string }>();
  let workflowBytes = 0;
  const trees: [string, string][] = [
    ['head', snapshot.headPath],
    ['base', snapshot.basePath],
  ];
  if (snapshot.targetPath && !trees.some(([, root]) => root === snapshot.targetPath)) {
    trees.push(['target', snapshot.targetPath]);
  }
  for (const path of paths) {
    for (const [tree, root] of trees) {
      let source: Buffer;
      try {
        overall.throwIfAborted();
        source = await readWorkflow(root, path);
        workflowBytes += source.length;
        if (workflowBytes > DIFF_LIMIT) {
          fail('Total workflow read limit exceeded; remaining dependency discovery omitted.');
          return result;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          result.notes.push(`${tree} workflow absent: ${path}`);
        } else {
          fail(`Cannot inspect ${tree} workflow ${path}: ${String(error)}`);
        }
        continue;
      }
      let uses: string[];
      try {
        uses = workflowUses(source);
      } catch (error) {
        fail(`Cannot parse ${tree} workflow ${path}: ${String(error)}`);
        continue;
      }
      for (const value of uses) {
        const pin = /^([^\s@]+)\s*@\s*([0-9a-f]{40})$/i.exec(value);
        const repository = REPOSITORIES.find(
          repo => repo.toLowerCase() === pin?.[1]?.toLowerCase()
        );
        if (!pin || !repository) {
          const relevant = REPOSITORIES.some(repo =>
            value.toLowerCase().includes(repo.toLowerCase())
          );
          const note = `Unsupported or excluded uses reference in ${tree}:${path}: ${JSON.stringify(value)}`;
          if (relevant) {
            fail(note);
          } else {
            result.notes.push(note);
          }
          continue;
        }
        const sha = pin[2]!.toLowerCase();
        references.set(`${repository}@${sha}`, { repository, sha });
      }
    }
  }
  let directory: string | undefined;
  const budget = { bytes: 0 };
  let count = 0;
  for (const reference of references.values()) {
    if (++count > 4) {
      fail(`Reference limit exceeded; omitted ${reference.repository}@${reference.sha}`);
      continue;
    }
    const context: ReviewDependencies['contexts'][number] = { ...reference, files: [] };
    result.contexts.push(context);
    for (const { path, optional } of FILES) {
      try {
        overall.throwIfAborted();
        const content = await fetchBounded(
          options.fetch ?? fetch,
          `https://raw.githubusercontent.com/${reference.repository}/${reference.sha}/${path}`,
          AbortSignal.any([overall, AbortSignal.timeout(15_000)]),
          budget,
          optional
        );
        if (content === undefined) {
          result.notes.push(
            `Versioned contract absent: ${reference.repository}@${reference.sha}/${path}`
          );
          continue;
        }
        directory ??= await mkdtemp(join(options.tempRoot ?? tmpdir(), 'pi-review-dependencies-'));
        const localPath = join(directory, `${count}-${context.files.length}.txt`);
        await writeFile(localPath, content, { mode: 0o600, flag: 'wx' });
        context.files.push({
          path,
          localPath,
          sha256: createHash('sha256').update(content).digest('hex'),
        });
      } catch (error) {
        fail(`Cannot stage ${reference.repository}@${reference.sha}/${path}: ${String(error)}`);
      }
    }
  }
  result.notes = [...new Set(result.notes)];
  return result;
}
