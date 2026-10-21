import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  digestReviewFiles,
  executeDigestUnit,
  expandDigestCheck,
  validateDigestResult,
} from '../src/review/work-digests';
import { reviewIdentity } from '../src/review/state';
import { parseReviewUnitResult } from '../src/review/work-submission';
import type { ReviewSnapshot } from '../src/review/types';
import type { ReviewWorkFollowUp, ReviewWorkUnit } from '../src/review/work-types';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let root: string;
let snapshot: ReviewSnapshot;
const unit: ReviewWorkUnit = {
  id: 'root',
  kind: 'followup',
  basis: 'full',
  question: 'Verify manifest',
  paths: ['manifest.json'],
  spans: [],
  findingIds: [],
};
const request: ReviewWorkFollowUp = {
  paths: ['manifest.json'],
  question: 'Verify manifest',
  digestCheck: {
    manifestPath: 'manifest.json',
    pointer: '/files',
    normalization: 'sha256-utf8-lf-v1',
    selection: 'changed',
  },
};
async function manifest(files: Record<string, string>, base = false) {
  await writeFile(
    join(base ? snapshot.basePath : snapshot.headPath, 'manifest.json'),
    JSON.stringify({ files })
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'review-digests-'));
  const headPath = join(root, 'head');
  const basePath = join(root, 'base');
  await Promise.all([mkdir(headPath), mkdir(basePath)]);
  snapshot = {
    repository: 'owner/repo',
    pullNumber: 1,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    mergeBaseSha: 'c'.repeat(40),
    baseRef: 'main',
    intentHash: 'd'.repeat(64),
    mode: 'full',
    fallbackReason: null,
    headPath,
    basePath,
    targetPath: headPath,
    previousPath: basePath,
    fullDiffPath: join(root, 'full.diff'),
    incrementalDiffPath: null,
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('native digest receipts', () => {
  it('rejects an oversized aggregate during preflight even when the manifest and leaf budgets fit', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 190 }, (_, index) => [
        `${String(index).padStart(3, '0')}-${'"'.repeat(128)}.txt`,
        hash('data'),
      ])
    );
    expect(Buffer.byteLength(JSON.stringify({ files }))).toBeLessThan(64 * 1024);
    await manifest(files);
    await expect(
      expandDigestCheck(
        unit,
        {
          ...request,
          digestCheck: { ...request.digestCheck!, selection: 'all' },
        },
        snapshot
      )
    ).rejects.toThrow('Digest aggregate exceeds result budget');
  });

  it('preserves BOM, Unicode, trailing whitespace and newlines while applying universal newlines', async () => {
    const text = '\ufeffTürkçe\r\n世界\rlast  \n\n';
    await writeFile(join(snapshot.headPath, 'source'), text);
    const [receipt] = await digestReviewFiles(snapshot, ['source'], 'sha256-utf8-lf-v1');
    expect(receipt).toEqual({
      role: 'H',
      sha: snapshot.headSha,
      path: 'source',
      algorithm: 'sha256',
      normalization: 'sha256-utf8-lf-v1',
      digest: hash('\ufeffTürkçe\n世界\nlast  \n\n'),
      bytes: Buffer.byteLength(text),
    });
  });
  it('hashes the full 3302-line file without rendering source', async () => {
    const data = 'line with substantial source text\n'.repeat(3302);
    await writeFile(join(snapshot.headPath, 'large'), data);
    const receipts = await digestReviewFiles(snapshot, ['large'], 'sha256-raw-v1');
    expect(receipts[0]?.digest).toBe(hash(data));
    expect(JSON.stringify(receipts).length).toBeLessThan(1024);
    expect(JSON.stringify(receipts)).not.toContain('substantial');
  });
  it('supports binary raw but rejects malformed UTF-8', async () => {
    const data = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    await writeFile(join(snapshot.headPath, 'binary'), data);
    expect((await digestReviewFiles(snapshot, ['binary'], 'sha256-raw-v1'))[0]?.digest).toBe(
      hash(data)
    );
    await expect(digestReviewFiles(snapshot, ['binary'], 'sha256-utf8-lf-v1')).rejects.toThrow();
  });
  it('maps pinned snapshot roles and requires a previous-head inventory', async () => {
    await writeFile(join(snapshot.basePath, 'source'), 'base');
    expect(
      (await digestReviewFiles(snapshot, ['source'], 'sha256-raw-v1', undefined, 'M'))[0]?.sha
    ).toBe(snapshot.mergeBaseSha);
    await writeFile(join(snapshot.headPath, 'source'), 'head');
    expect(
      (await digestReviewFiles(snapshot, ['source'], 'sha256-raw-v1', undefined, 'B'))[0]?.sha
    ).toBe(snapshot.baseSha);
    await expect(
      digestReviewFiles(snapshot, ['source'], 'sha256-raw-v1', undefined, 'P')
    ).rejects.toThrow('unavailable');
    snapshot.coverageInventoryPath = join(root, 'inventory.json');
    await writeFile(
      snapshot.coverageInventoryPath,
      JSON.stringify({
        version: 1,
        identity: reviewIdentity(snapshot),
        previousHeadSha: 'e'.repeat(40),
        full: [],
        incremental: [],
      })
    );
    expect(
      (await digestReviewFiles(snapshot, ['source'], 'sha256-raw-v1', undefined, 'P'))[0]?.sha
    ).toBe('e'.repeat(40));
  });
  it('rejects absent, traversal, intermediate/final symlinks and directories', async () => {
    await writeFile(join(root, 'outside'), 'secret');
    await symlink(root, join(snapshot.headPath, 'escape'));
    await symlink(join(root, 'outside'), join(snapshot.headPath, 'link'));
    await mkdir(join(snapshot.headPath, 'directory'));
    for (const path of [
      'missing',
      '../outside',
      '/etc/passwd',
      'C:/file',
      'escape/outside',
      'link',
      'directory',
      'bad\\path',
      './source',
    ]) {
      await expect(digestReviewFiles(snapshot, [path], 'sha256-raw-v1')).rejects.toThrow();
    }
  });
  it('enforces file, batch, output and cancellation bounds', async () => {
    const file = join(snapshot.headPath, 'big');
    await writeFile(file, '');
    await truncate(file, 128 * 1024 * 1024 + 1);
    await expect(digestReviewFiles(snapshot, ['big'], 'sha256-raw-v1')).rejects.toThrow('budget');
    await expect(
      digestReviewFiles(
        snapshot,
        Array.from({ length: 9 }, (_, i) => `${i}`),
        'sha256-raw-v1'
      )
    ).rejects.toThrow('1 to 8');
    await expect(
      digestReviewFiles(snapshot, ['big'], 'sha256-raw-v1', AbortSignal.abort())
    ).rejects.toThrow();
    await truncate(file, 65 * 1024 * 1024);
    await writeFile(join(snapshot.headPath, 'big2'), '');
    await truncate(join(snapshot.headPath, 'big2'), 65 * 1024 * 1024);
    await expect(digestReviewFiles(snapshot, ['big', 'big2'], 'sha256-raw-v1')).rejects.toThrow(
      'budget'
    );
  });
});

describe('manifest expansion and execution', () => {
  it('selects 13 of 125 entries from full inventory plus changed digests and partitions by eight', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 125 }, (_, i) => [`source-${String(i).padStart(3, '0')}`, hash('old')])
    );
    await manifest(files, true);
    await manifest({ ...files, 'source-012': hash('new') });
    snapshot.coverageInventoryPath = join(root, 'inventory.json');
    await writeFile(
      snapshot.coverageInventoryPath,
      JSON.stringify({
        version: 1,
        identity: reviewIdentity(snapshot),
        previousHeadSha: null,
        full: Array.from({ length: 12 }, (_, i) => ({
          path: `source-${String(i).padStart(3, '0')}`,
          previousPath: null,
        })),
        incremental: [],
      })
    );
    const expanded = await expandDigestCheck(unit, request, snapshot);
    expect(expanded.map(item => item.digest?.items.length)).toEqual([0, 8, 5]);
    expect(expanded[0]?.id).toBe(unit.id);
    expect(expanded[0]?.digest?.children).toEqual(expanded.slice(1).map(item => item.id));
    expect(await expandDigestCheck(unit, request, snapshot)).toEqual(expanded);
    expect(
      await expandDigestCheck(
        unit,
        { ...request, digestCheck: { ...request.digestCheck!, selection: 'all' } },
        snapshot
      )
    ).toHaveLength(17);
  });
  it('conservatively selects all without inventory, allows absent M manifest, and fails closed on corrupt M', async () => {
    await manifest({ source: hash('source') });
    expect(await expandDigestCheck(unit, request, snapshot)).toHaveLength(2);
    await writeFile(join(snapshot.basePath, 'manifest.json'), '{broken');
    await expect(expandDigestCheck(unit, request, snapshot)).rejects.toThrow();
  });
  it('validates all map identities, pointer, and manifest-only scope', async () => {
    for (const files of [{ '../escape': hash('x') }, { source: 'wrong' }]) {
      await manifest(files);
      await expect(expandDigestCheck(unit, request, snapshot)).rejects.toThrow();
    }
    await manifest({ source: hash('x') });
    await expect(
      expandDigestCheck(unit, { ...request, paths: ['source'] }, snapshot)
    ).rejects.toThrow();
    await expect(
      expandDigestCheck(
        unit,
        { ...request, digestCheck: { ...request.digestCheck!, pointer: '/missing' } },
        snapshot
      )
    ).rejects.toThrow();
    expect(await expandDigestCheck(unit, { paths: [], question: '' }, snapshot)).toEqual([unit]);
    await expect(expandDigestCheck(unit, request, snapshot, AbortSignal.abort())).rejects.toThrow();
  });
  it('supports escaped JSON pointer keys and rejects malformed escapes', async () => {
    await writeFile(
      join(snapshot.headPath, 'manifest.json'),
      JSON.stringify({ 'a/b~c': { source: hash('x') } })
    );
    const recipe = { ...request, digestCheck: { ...request.digestCheck!, pointer: '/a~1b~0c' } };
    expect(await expandDigestCheck(unit, recipe, snapshot)).toHaveLength(2);
    await expect(
      expandDigestCheck(
        unit,
        { ...recipe, digestCheck: { ...recipe.digestCheck, pointer: '/a~2' } },
        snapshot
      )
    ).rejects.toThrow('escape');
  });
  it('bounds manifest size and count', async () => {
    await manifest(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`s${i}`, hash('x')])));
    await expect(expandDigestCheck(unit, request, snapshot)).rejects.toThrow();
    await writeFile(join(snapshot.headPath, 'manifest.json'), ' '.repeat(65537));
    await expect(expandDigestCheck(unit, request, snapshot)).rejects.toThrow('budget');
  });
  it('partitions long quoted Unicode paths by the complete double-escaped result budget', async () => {
    const directory = `${'"'.repeat(75)}${'界'.repeat(30)}`;
    const paths = Array.from(
      { length: 12 },
      (_, i) =>
        `${directory}/${directory}/${'"'.repeat(100)}${'ş'.repeat(35)}${String(i).padStart(2, '0')}`
    );
    expect(paths.every(path => Buffer.byteLength(path) <= 512)).toBe(true);
    await mkdir(join(snapshot.headPath, directory, directory), { recursive: true });
    await Promise.all(paths.map(path => writeFile(join(snapshot.headPath, path), 'x')));
    await manifest(Object.fromEntries(paths.map(path => [path, hash('x')])));
    const expanded = await expandDigestCheck(unit, request, snapshot);
    const leaves = expanded.slice(1);
    expect(leaves.length).toBeGreaterThan(2);
    expect(leaves.every(leaf => leaf.digest!.items.length < 8)).toBe(true);
    expect(leaves.flatMap(leaf => leaf.paths)).toEqual([...paths].sort());
    expect(await expandDigestCheck(unit, request, snapshot)).toEqual(expanded);
    for (const leaf of leaves) {
      const result = await executeDigestUnit(leaf, snapshot);
      expect(result.status).toBe('reviewed');
      expect(parseReviewUnitResult(result, leaf)).toEqual(result);
      expect(() => validateDigestResult(leaf, snapshot, result)).not.toThrow();
      expect(
        JSON.parse(result.assessment).map((receipt: { path: string }) => receipt.path)
      ).toEqual(leaf.paths);
      await Promise.all(
        leaf.paths.map(path => writeFile(join(snapshot.headPath, path), 'changed'))
      );
      const mismatch = await executeDigestUnit(leaf, snapshot);
      expect(mismatch.status).toBe('blocked');
      expect(parseReviewUnitResult(mismatch, leaf)).toEqual(mismatch);
      expect(mismatch.limitations).toEqual(leaf.paths.map(path => `Digest mismatch: ${path}`));
      expect(JSON.parse(mismatch.assessment)).toHaveLength(leaf.paths.length);
      expect(Buffer.byteLength(JSON.stringify(mismatch))).toBeLessThanOrEqual(6144);
    }
  });
  it('rejects an oversized wrapped result without truncating receipt evidence', async () => {
    const paths = Array.from(
      { length: 8 },
      (_, i) => `${'a'.repeat(200)}/${'b'.repeat(200)}/${String(i).repeat(50)}`
    );
    await mkdir(join(snapshot.headPath, 'a'.repeat(200), 'b'.repeat(200)), { recursive: true });
    await Promise.all(paths.map(path => writeFile(join(snapshot.headPath, path), 'x')));
    const leaf: ReviewWorkUnit = {
      ...unit,
      paths,
      digest: {
        manifestPath: 'manifest.json',
        normalization: 'sha256-raw-v1',
        items: paths.map(path => ({ path, expectedDigest: hash('x') })),
        children: [],
      },
    };
    const result = await executeDigestUnit(leaf, snapshot);
    expect(result.status).toBe('blocked');
    expect(result.assessment).toContain('budget');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(6144);
  });
  it('emits exact native match evidence and blocks mismatch without fabricated findings', async () => {
    await manifest({ source: hash('hello\n') });
    await writeFile(join(snapshot.headPath, 'source'), 'hello\r\n');
    const [, leaf] = await expandDigestCheck(unit, request, snapshot);
    const result = await executeDigestUnit(leaf!, snapshot);
    expect(result.status).toBe('reviewed');
    expect(() => validateDigestResult(leaf!, snapshot, result)).not.toThrow();
    const receipt = JSON.parse(result.assessment)[0];
    for (const altered of [
      [],
      [receipt, receipt],
      [{ ...receipt, sha: snapshot.baseSha }],
      [{ ...receipt, path: 'invented' }],
      [{ ...receipt, digest: hash('bad') }],
      [{ ...receipt, match: false }],
      [{ ...receipt, normalization: 'sha256-raw-v1' }],
      [{ ...receipt, bytes: -1 }],
    ]) {
      expect(() =>
        validateDigestResult(leaf!, snapshot, { ...result, assessment: JSON.stringify(altered) })
      ).toThrow();
    }
    expect(() =>
      validateDigestResult(leaf!, snapshot, {
        ...result,
        assessment: result.assessment + ' '.repeat(6144),
      })
    ).toThrow();
    expect(JSON.parse(result.assessment)).toEqual([
      expect.objectContaining({
        path: 'source',
        digest: hash('hello\n'),
        expectedDigest: hash('hello\n'),
        bytes: 7,
        match: true,
      }),
    ]);
    expect(Buffer.byteLength(result.assessment)).toBeLessThanOrEqual(6144);
    await writeFile(join(snapshot.headPath, 'source'), 'bad');
    const mismatch = await executeDigestUnit(leaf!, snapshot);
    expect(mismatch.status).toBe('blocked');
    expect(mismatch.limitations).toEqual(['Digest mismatch: source']);
    expect(mismatch.findings).toEqual([]);
    await expect(executeDigestUnit(unit, snapshot)).rejects.toThrow('leaf');
    const aborted = await executeDigestUnit(leaf!, snapshot, AbortSignal.abort());
    expect(aborted.status).toBe('blocked');
    expect(aborted.assessment).toContain('AbortError');
    expect(Buffer.byteLength(JSON.stringify(aborted))).toBeLessThanOrEqual(6144);
  });
});
