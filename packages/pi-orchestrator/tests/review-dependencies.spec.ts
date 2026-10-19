import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { prepareReviewDependencies } from '../src/review/dependencies';
import type { ReviewSnapshot } from '../src/review/types';

const repo = 'PCD-Cooperation/pi-coding-agent-action';
const sha = '92f2245b0a70704cb70dafe03fb7cee995e61783';
const workflow = '.github/workflows/review.yml';
const directories: string[] = [];

async function fixture(head = `- uses: ${repo}@${sha}`, base = head, path = workflow) {
  const root = await mkdtemp(join(tmpdir(), 'review-deps-test-'));
  directories.push(root);
  const headPath = join(root, 'head');
  const basePath = join(root, 'base');
  for (const [tree, content] of [
    [headPath, head],
    [basePath, base],
  ]) {
    const file = join(tree!, workflow);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content!);
  }
  const fullDiffPath = join(root, 'full.diff');
  await writeFile(fullDiffPath, `diff --git a/${path} b/${path}\n`);
  const snapshot: ReviewSnapshot = {
    repository: 'example/repo',
    pullNumber: 1,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    mergeBaseSha: 'c'.repeat(40),
    baseRef: 'main',
    intentHash: 'intent',
    mode: 'full',
    fallbackReason: null,
    headPath,
    basePath,
    previousPath: null,
    fullDiffPath,
    incrementalDiffPath: null,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response('public source\r\n'));
  return { root, snapshot, fetcher, options: { fetch: fetcher, tempRoot: root } };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('approved immutable dependency evidence', () => {
  test('deduplicates base/head, canonicalizes pins, stages exact bytes with private mode', async () => {
    const f = await fixture(
      `  - UsEs : ' pcd-cooperation/PI-CODING-AGENT-ACTION @ ${sha.toUpperCase()} ' # pin`
    );
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(true);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]).toMatchObject({ repository: repo, sha });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of f.fetcher.mock.calls) {
      expect(String(url)).toMatch(
        new RegExp(`^https://raw\\.githubusercontent\\.com/${repo}/${sha}/`)
      );
      expect(init).toMatchObject({
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      expect(init).not.toHaveProperty('headers');
      expect(new URL(String(url)).username).toBe('');
    }
    expect(result.contexts[0]!.files.map(file => file.path)).toEqual([
      'action.yml',
      'packages/pi-orchestrator/src/orchestrator.ts',
    ]);
    for (const file of result.contexts[0]!.files) {
      expect(await readFile(file.localPath, 'utf8')).toBe('public source\r\n');
      expect(file.sha256).toBe(createHash('sha256').update('public source\r\n').digest('hex'));
      expect((await stat(file.localPath)).mode & 0o777).toBe(0o600);
    }
  });

  test('discovers both file markers in simple unified diffs', async () => {
    const f = await fixture();
    const renamed = '.github/workflows/renamed.yaml';
    await writeFile(
      join(f.snapshot.headPath, renamed),
      `uses: shaftoe/pi-coding-agent-action@${'f'.repeat(40)}`
    );
    await writeFile(f.snapshot.fullDiffPath, `--- a/${workflow}\n+++ b/${renamed}\n`);
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(true);
    expect(result.contexts).toHaveLength(2);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });

  test('simple unified nonworkflow diff and spoofed hunk markers make no network calls', async () => {
    const f = await fixture();
    await writeFile(
      f.snapshot.fullDiffPath,
      `--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n--- a/${workflow}\n+++ b/${workflow}\n`
    );
    expect(await prepareReviewDependencies(f.snapshot, f.options)).toMatchObject({
      complete: true,
      contexts: [],
      notes: [],
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test('captures both changed pins and the second approved repository', async () => {
    const f = await fixture(
      `uses: shaftoe/pi-coding-agent-action@${'f'.repeat(40)}`,
      `uses: ${repo}@${sha}`
    );
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(true);
    expect(result.contexts).toHaveLength(2);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });

  test.each(['.github/workflows/README.md', 'src/\\\\303\\\\251.ts'])(
    'nonworkflow path %s remains successful',
    async path => {
      const f = await fixture(undefined, undefined, path);
      await writeFile(f.snapshot.fullDiffPath, `diff --git "a/${path}" "b/${path}"\n`);
      expect(await prepareReviewDependencies(f.snapshot, f.options)).toMatchObject({
        complete: true,
        contexts: [],
        notes: [],
      });
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  );

  test('rejects workflow reads beyond their safe file bound', async () => {
    const f = await fixture();
    await writeFile(join(f.snapshot.headPath, workflow), 'x'.repeat(256 * 1024 + 1));
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(false);
    expect(result.notes.join(' ')).toContain('safe read limit');
  });

  test('recognizes quoted diff paths and yaml extension', async () => {
    const f = await fixture();
    const path = '.github/workflows/review.yaml';
    await writeFile(join(f.snapshot.headPath, path), `uses: ${repo}@${sha}`);
    await writeFile(join(f.snapshot.basePath, path), `uses: ${repo}@${sha}`);
    await writeFile(f.snapshot.fullDiffPath, `diff --git "a/${path}" "b/${path}"\n`);
    expect((await prepareReviewDependencies(f.snapshot, f.options)).complete).toBe(true);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  test.each([
    `uses: "PCD-Cooperation\\u002fpi-coding-agent-action@${sha}"`,
    `"u\\u0073es": '${repo}@${sha}'`,
    `- {uses: '${repo}@${sha}'}`,
    `jobs: {review: {steps: [{"u\\u0073es": "PCD-Cooperation\\u002fpi-coding-agent-action@${sha}"}]}}`,
    `uses: >-\n  ${repo}@${sha}`,
  ])('decodes YAML action references: %s', async source => {
    const f = await fixture(source);
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(true);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]).toMatchObject({ repository: repo, sha });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  test('does not interpret run or prompt scalar contents as action mappings', async () => {
    const f = await fixture(
      `jobs:\n  review:\n    steps:\n      - run: |\n          uses: ${repo}@${sha}\n      - with:\n          prompt: 'uses: ${repo}@main'`
    );
    expect(await prepareReviewDependencies(f.snapshot, f.options)).toMatchObject({
      complete: true,
      contexts: [],
      notes: [],
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test.each([
    `pin: &pin '${repo}@${sha}'\nuses: *pin`,
    'sequence: &sequence [*sequence]',
    'a: &a [text]\nb: &b [*a, *a, *a]\nc: [*b, *b, *b]',
    'uses: *unknown',
  ])('rejects aliases without expanding graphs: %s', async source => {
    const f = await fixture(source);
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(false);
    expect(result.notes.join(' ')).toContain('aliases');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test.each([
    `jobs: [ { uses: '${repo}@${sha}' }`,
    `uses: '${repo}@${sha}'\n"u\\u0073es": '${repo}@${sha}'`,
    `uses: !unknown '${repo}@${sha}'`,
    `uses: '${repo}@${sha}'\n---\nuses: '${repo}@${sha}'`,
    `uses: [ '${repo}@${sha}' ]`,
    '? [uses]\n: value',
  ])('fails closed on invalid, warned, or unresolvable workflow YAML: %s', async source => {
    const f = await fixture(source);
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(false);
    expect(result.notes.join(' ')).toContain('Cannot parse');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test('nonworkflow diffs do not read sources or call the network', async () => {
    const f = await fixture(undefined, undefined, 'src/index.ts');
    expect(await prepareReviewDependencies(f.snapshot, f.options)).toMatchObject({
      complete: true,
      contexts: [],
      notes: [],
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test.each(['../escape.yml', 'nested/test.yml', 'test.yml/../../escape.yml'])(
    'rejects unsafe workflow path %s',
    async path => {
      const f = await fixture(undefined, undefined, `.github/workflows/${path}`);
      expect((await prepareReviewDependencies(f.snapshot, f.options)).complete).toBe(false);
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  );

  test.each([
    `${repo}@main`,
    `${repo}@${sha}/../other`,
    `https://github.com/${repo}@${sha}`,
    `${repo}/subdir@${sha}`,
    `${repo}@${sha}00`,
  ])('does not resolve unsupported approved reference %s', async reference => {
    const f = await fixture(`uses: ${reference}`);
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(false);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test('excludes other repositories without fetching them', async () => {
    const f = await fixture(`uses: attacker/pi-coding-agent-action@${sha}`);
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(true);
    expect(result.notes.join(' ')).toContain('excluded');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test('reports absent workflow in added/deleted snapshots without losing the other pin', async () => {
    const f = await fixture();
    await rm(join(f.snapshot.basePath, workflow));
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(true);
    expect(result.notes.join(' ')).toContain('base workflow absent');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  test('rejects workflow file and directory symlinks', async () => {
    const f = await fixture();
    await rm(join(f.snapshot.headPath, workflow));
    await symlink(join(f.snapshot.basePath, workflow), join(f.snapshot.headPath, workflow));
    expect((await prepareReviewDependencies(f.snapshot, f.options)).complete).toBe(false);
    await rm(join(f.snapshot.headPath, '.github'), { recursive: true });
    await symlink(join(f.snapshot.basePath, '.github'), join(f.snapshot.headPath, '.github'));
    expect((await prepareReviewDependencies(f.snapshot, f.options)).complete).toBe(false);
  });

  test('fails closed rather than clipping an oversized diff', async () => {
    const f = await fixture();
    await writeFile(f.snapshot.fullDiffPath, Buffer.alloc(8 * 1024 * 1024 + 1));
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(false);
    expect(result.notes.join(' ')).toContain('safe read limit');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test('limits references to four and requests to eight, noting every omission', async () => {
    const source = Array.from(
      { length: 6 },
      (_, i) => `- uses: ${repo}@${String(i).repeat(40)}`
    ).join('\n');
    const f = await fixture(source);
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(8);
    expect(result.notes.filter(note => note.includes('Reference limit'))).toHaveLength(2);
  });

  test.each([404, 302])('fails closed on HTTP %s', async status => {
    const f = await fixture();
    f.fetcher.mockImplementation(
      async () => new Response('', { status, headers: { location: 'https://evil.example/secret' } })
    );
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(false);
    expect(result.contexts[0]!.files).toEqual([]);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  test('uses redirect:error and treats fetch redirect rejection as incomplete', async () => {
    const f = await fixture();
    f.fetcher.mockImplementation(async (_url, init) => {
      expect(init!.redirect).toBe('error');
      throw new TypeError('cross-origin redirect forbidden');
    });
    expect((await prepareReviewDependencies(f.snapshot, f.options)).complete).toBe(false);
  });

  test('bounds streamed file bytes and cancels without response.text()', async () => {
    const f = await fixture();
    const cancel = vi.fn();
    f.fetcher.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(65537));
            },
            cancel,
          })
        )
    );
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(false);
    expect(result.contexts[0]!.files).toEqual([]);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  test.each(['fetch', 'body'])(
    'bounds stalled %s operations by fetch and overall deadlines',
    async stage => {
      const f = await fixture(
        [0, 1].map(i => `- uses: ${repo}@${String(i).repeat(40)}`).join('\n')
      );
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), milliseconds);
        return controller.signal;
      });
      f.fetcher.mockImplementation(async () =>
        stage === 'fetch'
          ? new Promise<Response>(() => {})
          : new Response(new ReadableStream({ start() {} }))
      );
      const pending = prepareReviewDependencies(f.snapshot, f.options);
      // Discovery reads the local snapshot before starting the fetch deadlines.
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(45_000);
      const result = await pending;
      expect(result.complete).toBe(false);
      expect(result.contexts.flatMap(context => context.files)).toHaveLength(0);
      expect(f.fetcher).toHaveBeenCalledTimes(3);
      expect(result.notes.join(' ')).toContain('deadline');
    }
  );

  test('enforces total bytes across individually valid files', async () => {
    const f = await fixture(
      [0, 1, 2].map(i => `- uses: ${repo}@${String(i).repeat(40)}`).join('\n')
    );
    f.fetcher.mockImplementation(async () => new Response(new Uint8Array(65536)));
    const result = await prepareReviewDependencies(f.snapshot, f.options);
    expect(result.complete).toBe(false);
    expect(result.contexts.flatMap(context => context.files)).toHaveLength(4);
    expect(result.notes.join(' ')).toContain('byte limit');
  });
});
