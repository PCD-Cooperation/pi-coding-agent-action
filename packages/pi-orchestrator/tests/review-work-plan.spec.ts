import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildReviewWorkUnits,
  followUpWorkUnit,
  loadCoverageInventory,
  normalizedWorkUnits,
  reviewCoverageOptions,
} from '../src/review/work-plan';
import { reviewHash, reviewIdentity } from '../src/review/state';
import type { ReviewFinding, ReviewSnapshot, ReviewStateRecord } from '../src/review/types';
import type {
  ReviewChangedFile,
  ReviewChangedHunk,
  ReviewCoverageInventory,
  ReviewCoverageOptions,
  ReviewWorkUnit,
} from '../src/review/work-types';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'review-work-plan-'));
  roots.push(root);
  const snapshot: ReviewSnapshot = {
    repository: 'owner/repository',
    pullNumber: 7,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    mergeBaseSha: 'c'.repeat(40),
    baseRef: 'main',
    intentHash: reviewHash('intent'),
    mode: 'full',
    fallbackReason: null,
    headPath: join(root, 'head'),
    basePath: join(root, 'base'),
    targetPath: join(root, 'target'),
    previousPath: join(root, 'previous'),
    fullDiffPath: join(root, 'full.diff'),
    incrementalDiffPath: join(root, 'incremental.diff'),
    coverageInventoryPath: join(root, 'inventory.json'),
  };
  await Promise.all(
    [snapshot.headPath, snapshot.basePath, snapshot.targetPath!, snapshot.previousPath!].map(path =>
      mkdir(path)
    )
  );
  async function file(
    path: string,
    patch: string | Buffer,
    overrides: Partial<ReviewChangedFile> = {}
  ): Promise<ReviewChangedFile> {
    const bytes = Buffer.from(patch);
    const metadata = {
      path,
      previousPath: null,
      status: 'modified' as const,
      oldBlob: 'd'.repeat(40),
      newBlob: 'e'.repeat(40),
      oldMode: '100644',
      newMode: '100644',
      binary: false,
      patchBytes: bytes.length,
      hunks: [] as ReviewChangedHunk[],
      ...overrides,
    };
    const id = reviewHash(metadata);
    const patchPath = join(root, `${id}.diff`);
    await writeFile(patchPath, bytes);
    return { id, ...metadata, patchPath };
  }
  async function text(path: string, hunks: string[][], overrides: Partial<ReviewChangedFile> = {}) {
    const lines = [
      `diff --git a/${path} b/${path}`,
      'index ddddddd..eeeeeee 100644',
      `--- a/${path}`,
      `+++ b/${path}`,
    ];
    const metadata: ReviewChangedHunk[] = [];
    for (const [index, content] of hunks.entries()) {
      const oldLines = content.filter(line => line.startsWith('-') || line.startsWith(' ')).length;
      const newLines = content.filter(line => line.startsWith('+') || line.startsWith(' ')).length;
      const oldStart = oldLines ? index * 100 + 1 : 0;
      const newStart = newLines ? index * 100 + 1 : 0;
      const patchStartLine = lines.length + 1;
      lines.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, ...content);
      metadata.push({
        index,
        patchStartLine,
        patchEndLine: lines.length,
        oldStart,
        oldLines,
        newStart,
        newLines,
      });
    }
    return file(path, `${lines.join('\n')}\n`, { hunks: metadata, ...overrides });
  }
  async function inventory(
    full: ReviewChangedFile[],
    incremental: ReviewChangedFile[] | null = null,
    previousHeadSha: string | null = null
  ): Promise<ReviewCoverageInventory> {
    const value: ReviewCoverageInventory = {
      version: 1,
      identity: reviewIdentity(snapshot),
      previousHeadSha,
      full,
      incremental,
    };
    await writeFile(snapshot.coverageInventoryPath!, JSON.stringify(value));
    return loadCoverageInventory(snapshot);
  }
  async function build(files: ReviewChangedFile[], options: Partial<ReviewCoverageOptions> = {}) {
    return buildReviewWorkUnits(
      await inventory(files),
      snapshot,
      null,
      reviewCoverageOptions(options)
    );
  }
  return { root, snapshot, file, text, inventory, build };
}

function previous(snapshot: ReviewSnapshot, findings: ReviewFinding[] = []): ReviewStateRecord {
  return {
    commentId: 9,
    body: 'canonical history is not a work plan',
    state: {
      schemaVersion: 1,
      revision: 1,
      snapshot: { ...reviewIdentity(snapshot), headSha: 'f'.repeat(40) },
      configurationHash: reviewHash('configuration'),
      operationKey: reviewHash('operation'),
      completedReviews: 1,
      reviewMode: 'full',
      fallbackReason: null,
      coverageNotes: 'Prior complete review',
      actionableRounds: 0,
      needsHuman: false,
      nextFindingId: findings.length + 1,
      findings,
      intervention: null,
    },
  };
}
function finding(index: number, lifecycle: ReviewFinding['lifecycle']): ReviewFinding {
  return {
    id: `F${index}`,
    rootCause: 'A prior root cause',
    origin: 'pr_introduced',
    lifecycle,
    material: true,
    location: 'src/code.ts:1',
    evidence: 'Pinned code evidence',
    originEvidence: 'Pinned baseline attribution',
    dispositionReason:
      lifecycle === 'open' || lifecycle === 'reintroduced' ? '' : 'Recorded disposition',
    firstReportedHead: 'f'.repeat(40),
  };
}
function diffUnits(units: ReviewWorkUnit[]) {
  return units.filter(unit => unit.kind === 'diff');
}
function assertBounds(units: ReviewWorkUnit[], options = reviewCoverageOptions()) {
  for (const unit of diffUnits(units)) {
    expect(unit.spans.length).toBeLessThanOrEqual(options.maxUnitSpans);
    expect(new Set(unit.spans.map(span => span.fileId)).size).toBeLessThanOrEqual(
      options.maxUnitFiles
    );
    expect(
      unit.spans.reduce((sum, span) => sum + span.patchEndByte! - span.patchStartByte!, 0)
    ).toBeLessThanOrEqual(options.maxUnitBytes);
    expect(
      unit.spans.reduce((sum, span) => sum + span.patchEndLine - span.patchStartLine + 1, 0)
    ).toBeLessThanOrEqual(options.maxUnitLines);
  }
}

describe('bounded coverage planning options', () => {
  it('uses the full single-run policy and returns independent option objects', () => {
    expect(reviewCoverageOptions()).toEqual({
      concurrency: 3,
      maxUnits: 96,
      maxAttempts: 2,
      unitTimeoutMs: 300000,
      runTimeoutMs: 1320000,
      synthesisReserveMs: 240000,
      maxSynthesisAttempts: 3,
      maxUnitBytes: 96 * 1024,
      maxUnitLines: 1800,
      maxUnitFiles: 8,
      maxUnitSpans: 24,
    });
    const changed = reviewCoverageOptions();
    changed.maxUnitSpans = 1;
    expect(reviewCoverageOptions().maxUnitSpans).toBe(24);
  });
  it.each([
    { concurrency: 4 },
    { maxUnits: 97 },
    { maxAttempts: 3 },
    { unitTimeoutMs: 300001 },
    { runTimeoutMs: 1320001 },
    { maxSynthesisAttempts: 4 },
    { maxUnitBytes: 98305 },
    { maxUnitLines: 1801 },
    { maxUnitFiles: 9 },
    { maxUnitSpans: 25 },
    { synthesisReserveMs: 1320000 },
    { maxUnitBytes: 3 },
    { maxUnitSpans: 0 },
    { maxUnitLines: 1.5 },
    { maxUnits: Number.MAX_SAFE_INTEGER + 1 },
    { concurrency: Number.NaN },
  ])('rejects invalid or policy-expanding overrides: %j', options => {
    expect(() => reviewCoverageOptions(options)).toThrow();
  });
});

describe('coverage inventory and assigned ranges', () => {
  it('accounts for every text hunk, binary, mode-only, empty, renamed and deleted file', async () => {
    const f = await fixture();
    const ordinary = await f.text('src/ordinary.ts', [
      [' unchanged', '-old', '+new'],
      ['-removed', '+replacement'],
    ]);
    const deleted = await f.text('src/deleted.ts', [['-removed']], {
      status: 'deleted',
      newBlob: null,
      newMode: null,
    });
    const renamed = await f.file(
      'src/new name.ts',
      'diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n',
      { status: 'renamed', previousPath: 'src/old name.ts' }
    );
    const binary = await f.file(
      'images/data.bin',
      `diff --git a/data b/data\nindex d..e\nGIT binary patch\nliteral 123\n${'opaque\n'.repeat(30)}`,
      { binary: true }
    );
    const modeOnly = await f.file(
      'scripts/tool.sh',
      'diff --git a/tool b/tool\nold mode 100644\nnew mode 100755\n',
      { newMode: '100755' }
    );
    const empty = await f.file('src/empty.ts', '', {
      status: 'added',
      oldBlob: null,
      oldMode: null,
    });
    const files = [ordinary, deleted, renamed, binary, modeOnly, empty];
    const units = await f.build(files);
    const spans = units.flatMap(unit => unit.spans);
    expect(new Set(spans.map(span => span.fileId))).toEqual(new Set(files.map(file => file.id)));
    expect(new Set(spans.map(span => span.id)).size).toBe(spans.length);
    for (const file of [ordinary, deleted]) {
      for (const hunk of file.hunks) {
        const assigned = spans.filter(
          span => span.fileId === file.id && span.patchStartLine === hunk.patchStartLine
        );
        expect(assigned).toHaveLength(1);
        expect(assigned[0]).toMatchObject({
          patchEndLine: hunk.patchEndLine,
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
        });
      }
    }
    expect(spans.find(span => span.fileId === renamed.id)).toMatchObject({
      previousPath: renamed.previousPath,
      status: 'renamed',
    });
    expect(units.flatMap(unit => unit.paths)).toContain('src/old name.ts');
    expect(spans.find(span => span.fileId === modeOnly.id)).toMatchObject({
      oldMode: '100644',
      newMode: '100755',
    });
    expect(spans.find(span => span.fileId === binary.id)).toMatchObject({
      binary: true,
      patchStartByte: 0,
      patchEndLine: 8,
      oldBlob: binary.oldBlob,
      newBlob: binary.newBlob,
    });
    expect(spans.find(span => span.fileId === empty.id)).toMatchObject({
      patchStartByte: 0,
      patchEndByte: 0,
      status: 'added',
    });
    assertBounds(units);
  });

  it('returns an empty diff plan for an empty change set rather than inventing reviewed ranges', async () => {
    const f = await fixture();
    expect(await f.build([])).toEqual([]);
  });

  it('splits long UTF-8 patch lines into contiguous half-open byte ranges without broken code points', async () => {
    const f = await fixture();
    const file = await f.text('generated/utf8.ts', [[`+${'🙂漢'.repeat(40000)}`]]);
    const patch = await readFile(file.patchPath);
    const units = await f.build([file]);
    const spans = diffUnits(units)
      .flatMap(unit => unit.spans)
      .sort((a, b) => a.patchStartByte! - b.patchStartByte!);
    const hunk = file.hunks[0]!;
    const offsets = [
      0,
      ...Array.from(patch.keys())
        .filter(index => patch[index] === 10)
        .map(index => index + 1),
    ];
    expect(spans[0]!.patchStartByte).toBe(offsets[hunk.patchStartLine - 1]);
    expect(spans.at(-1)!.patchEndByte).toBe(offsets[hunk.patchEndLine]);
    for (const [index, span] of spans.entries()) {
      if (index) {
        expect(span.patchStartByte).toBe(spans[index - 1]!.patchEndByte);
      }
      const bytes = patch.subarray(span.patchStartByte, span.patchEndByte);
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toThrow();
      expect(bytes.length).toBeLessThanOrEqual(96 * 1024);
    }
    const fragments = spans.filter(span => span.partialLine);
    expect(fragments.length).toBeGreaterThan(1);
    expect(
      fragments.every(
        span => span.patchStartLine === hunk.patchEndLine && span.patchEndLine === hunk.patchEndLine
      )
    ).toBe(true);
    expect(
      Buffer.concat(spans.map(span => patch.subarray(span.patchStartByte, span.patchEndByte)))
    ).toEqual(patch.subarray(offsets[hunk.patchStartLine - 1], offsets[hunk.patchEndLine]));
    expect(units.filter(unit => unit.kind === 'followup')).toHaveLength(1);
    expect(units.find(unit => unit.kind === 'followup')!.paths).toEqual([file.path]);
    assertBounds(units);
  });

  it('keeps IDs and normalized plans stable across different host staging roots', async () => {
    const a = await fixture();
    const b = await fixture();
    const patch = [[`+${'é'.repeat(60000)}`]];
    const first = await a.build([await a.text('src/stable.ts', patch)]);
    const second = await b.build([await b.text('src/stable.ts', patch)]);
    expect(first.map(unit => unit.id)).toEqual(second.map(unit => unit.id));
    expect(first.flatMap(unit => unit.spans.map(span => span.id))).toEqual(
      second.flatMap(unit => unit.spans.map(span => span.id))
    );
    expect(normalizedWorkUnits(first)).toEqual(normalizedWorkUnits(second));
    expect(JSON.stringify(normalizedWorkUnits(first))).not.toContain(a.root);
    expect(first[0]!.spans[0]!.patchPath).not.toBe(second[0]!.spans[0]!.patchPath);
  });

  it('admits exactly 96 KiB of assigned patch bytes and splits the next byte with an integration unit', async () => {
    const f = await fixture();
    const headerBytes = Buffer.byteLength('@@ -0,0 +1,1 @@\n');
    const content = `+${'x'.repeat(96 * 1024 - headerBytes - 2)}`;
    const exact = await f.text('src/exact.ts', [[content]]);
    const exactUnits = await f.build([exact]);
    expect(exactUnits).toHaveLength(1);
    expect(exactUnits[0]!.spans[0]!.patchEndByte! - exactUnits[0]!.spans[0]!.patchStartByte!).toBe(
      96 * 1024
    );
    const over = await f.text('src/over.ts', [[`${content}x`]]);
    const overUnits = await f.build([over]);
    expect(diffUnits(overUnits)).toHaveLength(2);
    expect(overUnits.filter(unit => unit.kind === 'followup')).toHaveLength(1);
    assertBounds(overUnits);
  });

  it('counts hunk headers in the 1800-line cap and schedules whole-file integration after a split', async () => {
    const f = await fixture();
    const exact = await f.text('src/1800.ts', [Array.from({ length: 1799 }, () => '+x')]);
    expect(await f.build([exact])).toHaveLength(1);
    const over = await f.text('src/1801.ts', [Array.from({ length: 1800 }, () => '+x')]);
    const units = await f.build([over]);
    expect(diffUnits(units)).toHaveLength(2);
    expect(units.filter(unit => unit.kind === 'followup')).toHaveLength(1);
    assertBounds(units);
  });

  it('enforces eight changed files and 24 assigned spans per unit independently', async () => {
    const f = await fixture();
    const files = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        f.file(`empty-${index}`, '', { status: 'added', oldBlob: null, oldMode: null })
      )
    );
    expect(await f.build(files.slice(0, 8))).toHaveLength(1);
    expect(diffUnits(await f.build(files))).toHaveLength(2);
    const exact = await f.text(
      'src/24.ts',
      Array.from({ length: 24 }, () => ['-a', '+b'])
    );
    expect(await f.build([exact])).toHaveLength(1);
    const over = await f.text(
      'src/25.ts',
      Array.from({ length: 25 }, () => ['-a', '+b'])
    );
    const units = await f.build([over]);
    expect(diffUnits(units).map(unit => unit.spans.length)).toEqual([24, 1]);
    expect(units.filter(unit => unit.kind === 'followup')).toHaveLength(1);
    assertBounds(units);
  });

  it('admits 96 work units but includes integration and reconciliation in that same budget', async () => {
    const f = await fixture();
    const files = await Promise.all(
      Array.from({ length: 97 }, (_, index) => f.file(`file-${index}`, ''))
    );
    expect(await f.build(files.slice(0, 96), { maxUnitFiles: 1 })).toHaveLength(96);
    await expect(f.build(files, { maxUnitFiles: 1 })).rejects.toThrow('budget');
    const inventory = await f.inventory(files.slice(0, 96));
    await expect(
      buildReviewWorkUnits(
        inventory,
        f.snapshot,
        previous(f.snapshot, [finding(1, 'open')]),
        reviewCoverageOptions({ maxUnitFiles: 1 })
      )
    ).rejects.toThrow('budget');
    const split = await f.text('src/split.ts', [Array.from({ length: 1800 }, () => '+x')]);
    await expect(f.build([split], { maxUnits: 2 })).rejects.toThrow('budget');
  });

  it('uses only the pinned incremental endpoint delta and refuses absent or mismatched prior endpoints', async () => {
    const f = await fixture();
    const full = await f.text('full.ts', [['+full']]);
    const incremental = await f.text('incremental.ts', [['+incremental']]);
    const prior = previous(f.snapshot);
    const inventory = await f.inventory([full], [incremental], prior.state.snapshot.headSha);
    f.snapshot.mode = 'incremental';
    const units = await buildReviewWorkUnits(inventory, f.snapshot, prior, reviewCoverageOptions());
    expect(units.every(unit => unit.basis === 'incremental')).toBe(true);
    expect(units.flatMap(unit => unit.spans.map(span => span.fileId))).toEqual([incremental.id]);
    await expect(
      buildReviewWorkUnits(inventory, f.snapshot, null, reviewCoverageOptions())
    ).rejects.toThrow('endpoint');
    const wrong = structuredClone(prior);
    wrong.state.snapshot.headSha = '9'.repeat(40);
    await expect(
      buildReviewWorkUnits(inventory, f.snapshot, wrong, reviewCoverageOptions())
    ).rejects.toThrow('endpoint');
    await expect(
      buildReviewWorkUnits(
        { ...inventory, incremental: null },
        f.snapshot,
        prior,
        reviewCoverageOptions()
      )
    ).rejects.toThrow('endpoint');
    f.snapshot.mode = 'full';
    expect(
      (await buildReviewWorkUnits(inventory, f.snapshot, prior, reviewCoverageOptions())).flatMap(
        unit => unit.spans.map(span => span.fileId)
      )
    ).toEqual([full.id]);
  });

  it('reconciles all open/reintroduced findings in stable groups of at most eight without reopening closed dispositions', async () => {
    const f = await fixture();
    const active = Array.from({ length: 17 }, (_, index) =>
      finding(index + 1, index % 2 ? 'open' : 'reintroduced')
    );
    const findings = [
      ...active,
      finding(18, 'fixed'),
      finding(19, 'refuted'),
      finding(20, 'risk_accepted'),
    ];
    const record = previous(f.snapshot, findings);
    const units = await buildReviewWorkUnits(
      await f.inventory([]),
      f.snapshot,
      record,
      reviewCoverageOptions()
    );
    expect(units.map(unit => unit.kind)).toEqual(['reconcile', 'reconcile', 'reconcile']);
    expect(units.map(unit => unit.findingIds.length)).toEqual([8, 8, 1]);
    expect(units.flatMap(unit => unit.findingIds)).toEqual(active.map(finding => finding.id));
    expect(units.every(unit => !unit.spans.length && !unit.paths.length)).toBe(true);
    expect(record.state.findings).toEqual(findings);
  });

  it.each([
    'identity',
    'duplicate file',
    'traversal',
    'absolute source',
    'outside patch',
    'negative bytes',
    'blob',
    'mode',
    'hunk extra field',
    'hunk overlap',
    'missing full',
  ])('rejects malformed host inventory: %s', async corruption => {
    const f = await fixture();
    const file = await f.text('src/code.ts', [['-a', '+b'], ['+c']]);
    await f.inventory([file]);
    const value = JSON.parse(await readFile(f.snapshot.coverageInventoryPath!, 'utf8'));
    const item = value.full[0];
    if (corruption === 'identity') {
      value.identity.headSha = '0'.repeat(40);
    }
    if (corruption === 'duplicate file') {
      value.full.push(structuredClone(item));
    }
    if (corruption === 'traversal') {
      item.path = '../escape';
    }
    if (corruption === 'absolute source') {
      item.path = '/absolute';
    }
    if (corruption === 'outside patch') {
      item.patchPath = join(dirname(f.root), 'outside.diff');
    }
    if (corruption === 'negative bytes') {
      item.patchBytes = -1;
    }
    if (corruption === 'blob') {
      item.oldBlob = 'not-a-sha';
    }
    if (corruption === 'mode') {
      item.newMode = '999999';
    }
    if (corruption === 'hunk extra field') {
      item.hunks[0].sampled = true;
    }
    if (corruption === 'hunk overlap') {
      item.hunks[1].patchStartLine = item.hunks[0].patchEndLine;
    }
    if (corruption === 'missing full') {
      value.full = null;
    }
    await writeFile(f.snapshot.coverageInventoryPath!, JSON.stringify(value));
    await expect(loadCoverageInventory(f.snapshot)).rejects.toThrow();
  });

  it('rejects missing inventories, changed patch sizes, out-of-range hunks and inaccurate line counts', async () => {
    const f = await fixture();
    const withoutInventory = { ...f.snapshot };
    delete withoutInventory.coverageInventoryPath;
    await expect(loadCoverageInventory(withoutInventory)).rejects.toThrow();
    const file = await f.text('src/code.ts', [['-a', '+b']]);
    await expect(f.build([{ ...file, patchBytes: file.patchBytes + 1 }])).rejects.toThrow('size');
    await expect(
      f.build([{ ...file, hunks: [{ ...file.hunks[0]!, patchEndLine: 1000 }] }])
    ).rejects.toThrow('exceeds patch');
    await expect(
      f.build([{ ...file, hunks: [{ ...file.hunks[0]!, oldLines: 7 }] }])
    ).rejects.toThrow('line counts');
  });
});

describe('follow-up source scopes', () => {
  it('trims question edges and normalizes unique paths without rewriting the scope text', async () => {
    const f = await fixture();
    const paths = ['head-only.ts', 'base-only.ts', 'target-only.ts', 'previous-only.ts'];
    const sourceRoots = [
      f.snapshot.headPath,
      f.snapshot.basePath,
      f.snapshot.targetPath!,
      f.snapshot.previousPath!,
    ];
    await Promise.all(
      paths.map((path, index) => writeFile(join(sourceRoots[index]!, path), 'source text only'))
    );
    const unit = await followUpWorkUnit(
      {
        paths: [...paths].reverse().concat(paths[0]!),
        question: '  Check\n integration\t contracts.  ',
      },
      f.snapshot
    );
    expect(unit).toMatchObject({
      kind: 'followup',
      basis: 'full',
      question: 'Check\n integration\t contracts.',
      paths: [...paths].sort(),
      spans: [],
      findingIds: [],
    });
    expect(
      (await followUpWorkUnit({ paths, question: 'Check\n integration\t contracts.' }, f.snapshot))
        .id
    ).toBe(unit.id);
    const other = await fixture();
    await Promise.all(
      paths.map(path => writeFile(join(other.snapshot.headPath, path), 'different host root'))
    );
    expect(
      (
        await followUpWorkUnit(
          { paths, question: 'Check\n integration\t contracts.' },
          other.snapshot
        )
      ).id
    ).toBe(unit.id);
  });

  it('does not conflate literal or indentation whitespace in different required questions', async () => {
    const f = await fixture();
    await writeFile(join(f.snapshot.headPath, 'source.ts'), 'source');
    const a = await followUpWorkUnit(
      { paths: ['source.ts'], question: 'Inspect the literal "a  b".' },
      f.snapshot
    );
    const b = await followUpWorkUnit(
      { paths: ['source.ts'], question: 'Inspect the literal "a b".' },
      f.snapshot
    );
    expect(a.id).not.toBe(b.id);
    expect(a.question).toBe('Inspect the literal "a  b".');
  });

  it.each([
    '',
    '../escape.ts',
    '/absolute.ts',
    'src/../escape.ts',
    'src/./file.ts',
    'src//file.ts',
    'C:escape.ts',
    'src\\file.ts',
    'src/\u0000file.ts',
  ])('rejects unsafe follow-up path %j before reading outside source roots', async path => {
    const f = await fixture();
    await expect(
      followUpWorkUnit({ paths: [path], question: 'Check' }, f.snapshot)
    ).rejects.toThrow();
  });

  it('requires between one and eight existing regular source files and refuses final-component symlinks', async () => {
    const f = await fixture();
    await expect(followUpWorkUnit({ paths: [], question: 'Check' }, f.snapshot)).rejects.toThrow();
    await expect(
      followUpWorkUnit({ paths: ['missing.ts'], question: 'Check' }, f.snapshot)
    ).rejects.toThrow('unavailable');
    await mkdir(join(f.snapshot.headPath, 'directory'));
    await expect(
      followUpWorkUnit({ paths: ['directory'], question: 'Check' }, f.snapshot)
    ).rejects.toThrow('unavailable');
    const paths = Array.from({ length: 9 }, (_, index) => `source-${index}.ts`);
    await Promise.all(paths.map(path => writeFile(join(f.snapshot.headPath, path), 'source text')));
    expect(
      (await followUpWorkUnit({ paths: paths.slice(0, 8), question: 'Check' }, f.snapshot)).paths
    ).toHaveLength(8);
    await expect(followUpWorkUnit({ paths, question: 'Check' }, f.snapshot)).rejects.toThrow();
    await symlink(join(f.snapshot.headPath, paths[0]!), join(f.snapshot.headPath, 'linked.ts'));
    await expect(
      followUpWorkUnit({ paths: ['linked.ts'], question: 'Check' }, f.snapshot)
    ).rejects.toThrow();
  });
});
