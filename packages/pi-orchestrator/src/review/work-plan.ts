import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { reviewHash, reviewIdentity } from './state';
import { pinnedFilePath } from './work-digests';
import type { ReviewSnapshot, ReviewStateRecord } from './types';
import type {
  ReviewChangedFile,
  ReviewCoverageInventory,
  ReviewCoverageOptions,
  ReviewWorkFollowUp,
  ReviewWorkSpan,
  ReviewWorkUnit,
} from './work-types';

export const REVIEW_COVERAGE_VERSION = 'coverage-work-v2';
export const DEFAULT_REVIEW_COVERAGE_OPTIONS: Readonly<ReviewCoverageOptions> = {
  concurrency: 3,
  maxUnits: 96,
  maxAttempts: 2,
  unitTimeoutMs: 300_000,
  runTimeoutMs: 1_320_000,
  synthesisReserveMs: 240_000,
  maxSynthesisAttempts: 3,
  maxUnitBytes: 96 * 1024,
  maxUnitLines: 1800,
  maxUnitFiles: 8,
  maxUnitSpans: 24,
};

export function reviewCoverageOptions(
  value: Partial<ReviewCoverageOptions> = {}
): ReviewCoverageOptions {
  const result = { ...DEFAULT_REVIEW_COVERAGE_OPTIONS, ...value };
  for (const [key, amount] of Object.entries(result)) {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error(`Invalid coverage option: ${key}`);
    }
  }
  if (
    result.concurrency > 3 ||
    result.maxUnits > 96 ||
    result.maxAttempts > 2 ||
    result.unitTimeoutMs > 300_000 ||
    result.runTimeoutMs > 1_320_000 ||
    result.maxSynthesisAttempts > 3 ||
    result.maxUnitBytes > 96 * 1024 ||
    result.maxUnitLines > 1800 ||
    result.maxUnitFiles > 8 ||
    result.maxUnitSpans > 24 ||
    result.synthesisReserveMs >= result.runTimeoutMs ||
    result.maxUnitBytes < 4
  ) {
    throw new Error('Coverage options exceed the bounded single-run policy');
  }
  return result;
}

export function validReviewPath(path: string): boolean {
  return (
    Boolean(path) &&
    !isAbsolute(path) &&
    !/^[A-Za-z]:/.test(path) &&
    !/[\\\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..')
  );
}

function contained(root: string, file: string): boolean {
  const path = relative(resolve(root), resolve(file));
  return (
    isAbsolute(file) &&
    Boolean(path) &&
    !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    path !== '..' &&
    !isAbsolute(path)
  );
}

export async function readCoverageFile(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) {
      throw new Error('Coverage evidence exceeds file bound');
    }
    const data = await handle.readFile();
    if (data.length > limit) {
      throw new Error('Coverage evidence exceeds file bound');
    }
    return data;
  } finally {
    await handle.close();
  }
}

export async function loadCoverageInventory(
  snapshot: ReviewSnapshot
): Promise<ReviewCoverageInventory> {
  const root = dirname(snapshot.fullDiffPath);
  if (!snapshot.coverageInventoryPath || !contained(root, snapshot.coverageInventoryPath)) {
    throw new Error('Coverage mode requires a host-staged inventory');
  }
  const value = JSON.parse(
    (await readCoverageFile(snapshot.coverageInventoryPath, 128 * 1024 * 1024)).toString('utf8')
  ) as ReviewCoverageInventory;
  const identity = reviewIdentity(snapshot);
  if (
    value.version !== 1 ||
    !value.identity ||
    Object.entries(identity).some(
      ([key, item]) => value.identity[key as keyof typeof identity] !== item
    )
  ) {
    throw new Error('Coverage inventory snapshot mismatch');
  }
  const statuses = ['added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed'];
  for (const files of [value.full, value.incremental]) {
    if (files === null) {
      continue;
    }
    if (!Array.isArray(files) || files.length > 10_000) {
      throw new Error('Invalid coverage file inventory');
    }
    const ids = new Set<string>();
    for (const file of files) {
      if (
        !file ||
        typeof file.id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(file.id) ||
        ids.has(file.id) ||
        !validReviewPath(file.path) ||
        (file.previousPath !== null && !validReviewPath(file.previousPath)) ||
        !statuses.includes(file.status) ||
        typeof file.binary !== 'boolean' ||
        !Number.isSafeInteger(file.patchBytes) ||
        file.patchBytes < 0 ||
        !contained(root, file.patchPath) ||
        !Array.isArray(file.hunks) ||
        file.hunks.length > 100_000 ||
        [file.oldBlob, file.newBlob].some(
          blob => blob !== null && (typeof blob !== 'string' || !/^[a-f0-9]{40}$/.test(blob))
        ) ||
        [file.oldMode, file.newMode].some(
          mode => mode !== null && (typeof mode !== 'string' || !/^[0-7]{6}$/.test(mode))
        )
      ) {
        throw new Error('Invalid coverage file metadata');
      }
      ids.add(file.id);
      let end = 0;
      for (const [index, hunk] of file.hunks.entries()) {
        if (
          !hunk ||
          Object.keys(hunk).length !== 7 ||
          hunk.index !== index ||
          ![
            'index',
            'patchStartLine',
            'patchEndLine',
            'oldStart',
            'oldLines',
            'newStart',
            'newLines',
          ].every(key => Object.hasOwn(hunk, key)) ||
          !Object.values(hunk).every(item => Number.isSafeInteger(item) && item >= 0) ||
          hunk.patchStartLine < 1 ||
          hunk.patchStartLine <= end ||
          hunk.patchEndLine < hunk.patchStartLine
        ) {
          throw new Error('Invalid coverage hunk inventory');
        }
        end = hunk.patchEndLine;
      }
    }
  }
  if (
    !Array.isArray(value.full) ||
    (value.previousHeadSha !== null && !/^[a-f0-9]{40}$/.test(value.previousHeadSha))
  ) {
    throw new Error('Invalid coverage inventory endpoints');
  }
  return value;
}

function lineOffsets(buffer: Buffer): number[] {
  const offsets = [0];
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 10) {
      offsets.push(i + 1);
    }
  }
  if (offsets.at(-1) !== buffer.length) {
    offsets.push(buffer.length);
  }
  return offsets;
}

function normalizedSpan(span: ReviewWorkSpan) {
  const { patchPath: _patchPath, ...data } = span;
  return data;
}

function unit(data: Omit<ReviewWorkUnit, 'id'>): ReviewWorkUnit {
  return { id: reviewHash({ ...data, spans: data.spans.map(normalizedSpan) }), ...data };
}

async function fileSpans(
  file: ReviewChangedFile,
  options: ReviewCoverageOptions
): Promise<ReviewWorkSpan[]> {
  const patch = await readCoverageFile(file.patchPath, 128 * 1024 * 1024);
  if (patch.length !== file.patchBytes) {
    throw new Error('Coverage patch size mismatch');
  }
  const offsets = lineOffsets(patch);
  const spans: ReviewWorkSpan[] = [];
  const add = (
    start: number,
    end: number,
    startLine: number,
    endLine: number,
    oldStart: number,
    oldLines: number,
    newStart: number,
    newLines: number,
    partialLine = false
  ) => {
    const data = {
      fileId: file.id,
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      binary: file.binary,
      oldBlob: file.oldBlob,
      newBlob: file.newBlob,
      oldMode: file.oldMode,
      newMode: file.newMode,
      patchStartByte: start,
      patchEndByte: end,
      patchStartLine: startLine,
      patchEndLine: endLine,
      oldStart,
      oldLines,
      newStart,
      newLines,
      partialLine,
    };
    spans.push({ id: reviewHash(data), ...data, patchPath: file.patchPath });
  };
  if (file.binary || !file.hunks.length) {
    const endLine = file.binary ? Math.min(offsets.length - 1, 8) : offsets.length - 1;
    const end = offsets[endLine] ?? 0;
    if (end > options.maxUnitBytes) {
      throw new Error('Coverage metadata header exceeds unit bound');
    }
    add(0, end, 1, endLine, 0, 0, 0, 0);
    return spans;
  }
  for (const hunk of file.hunks) {
    if (hunk.patchEndLine >= offsets.length) {
      throw new Error('Coverage hunk exceeds patch');
    }
    let old = hunk.oldStart,
      current = hunk.newStart;
    let begin = offsets[hunk.patchStartLine - 1]!;
    let beginLine = hunk.patchStartLine;
    let oldBegin = old,
      newBegin = current;
    const flush = (end: number, endLine: number) => {
      if (end > begin) {
        add(begin, end, beginLine, endLine, oldBegin, old - oldBegin, newBegin, current - newBegin);
      }
      begin = end;
      beginLine = endLine + 1;
      oldBegin = old;
      newBegin = current;
    };
    for (let line = hunk.patchStartLine; line <= hunk.patchEndLine; line++) {
      const start = offsets[line - 1]!,
        end = offsets[line]!;
      if (end - begin > options.maxUnitBytes || line - beginLine >= options.maxUnitLines) {
        flush(start, line - 1);
      }
      const marker = patch[start];
      const oldStep = line === hunk.patchStartLine ? 0 : marker === 45 || marker === 32 ? 1 : 0;
      const newStep = line === hunk.patchStartLine ? 0 : marker === 43 || marker === 32 ? 1 : 0;
      if (end - start > options.maxUnitBytes) {
        let part = start;
        while (part < end) {
          let stop = Math.min(end, part + options.maxUnitBytes);
          while (stop < end && (patch[stop]! & 0xc0) === 0x80) {
            stop--;
          }
          if (stop <= part) {
            throw new Error('Cannot split coverage patch line safely');
          }
          add(part, stop, line, line, old, oldStep, current, newStep, true);
          part = stop;
        }
        old += oldStep;
        current += newStep;
        begin = end;
        beginLine = line + 1;
        oldBegin = old;
        newBegin = current;
      } else {
        old += oldStep;
        current += newStep;
      }
    }
    flush(offsets[hunk.patchEndLine]!, hunk.patchEndLine);
    if (old !== hunk.oldStart + hunk.oldLines || current !== hunk.newStart + hunk.newLines) {
      throw new Error('Coverage hunk line counts do not match the inventory');
    }
  }
  return spans;
}

export async function buildReviewWorkUnits(
  inventory: ReviewCoverageInventory,
  snapshot: ReviewSnapshot,
  previous: ReviewStateRecord | null,
  options: ReviewCoverageOptions
): Promise<ReviewWorkUnit[]> {
  const basis = snapshot.mode;
  const files = basis === 'full' ? inventory.full : inventory.incremental;
  if (
    !files ||
    (basis === 'incremental' && inventory.previousHeadSha !== previous?.state.snapshot.headSha)
  ) {
    throw new Error('Coverage inventory is missing the reviewed endpoint delta');
  }
  const units: ReviewWorkUnit[] = [];
  let pending: ReviewWorkSpan[] = [],
    bytes = 0,
    lines = 0;
  const flush = () => {
    if (!pending.length) {
      return;
    }
    units.push(
      unit({
        kind: 'diff',
        basis,
        question:
          'Inspect every assigned change and affected code/contracts; report whole-artifact invariants or integration gaps as required follow-up scopes, never silently sample.',
        paths: [
          ...new Set(
            pending.flatMap(span => [span.path, ...(span.previousPath ? [span.previousPath] : [])])
          ),
        ].sort(),
        spans: pending,
        findingIds: [],
      })
    );
    pending = [];
    bytes = 0;
    lines = 0;
  };
  const byFile = new Map<string, Set<string>>();
  for (const file of files) {
    for (const span of await fileSpans(file, options)) {
      const size = span.patchEndByte! - span.patchStartByte!;
      const count = span.patchEndLine - span.patchStartLine + 1;
      const paths = new Set([...pending.map(item => item.path), span.path]);
      if (
        pending.length &&
        (bytes + size > options.maxUnitBytes ||
          lines + count > options.maxUnitLines ||
          paths.size > options.maxUnitFiles ||
          pending.length >= options.maxUnitSpans)
      ) {
        flush();
      }
      pending.push(span);
      bytes += size;
      lines += count;
    }
  }
  flush();
  for (const item of units) {
    for (const span of item.spans) {
      if (!byFile.has(span.fileId)) {
        byFile.set(span.fileId, new Set());
      }
      byFile.get(span.fileId)!.add(item.id);
    }
  }
  for (const file of files) {
    if ((byFile.get(file.id)?.size ?? 0) > 1) {
      units.push(
        unit({
          kind: 'followup',
          basis,
          question:
            'Inspect whole-file integration and global invariants across the separately reviewed ranges. Check schema/generator/provenance/consumer contracts where applicable, without executing PR code or demanding formal per-record certification.',
          paths: [file.path, ...(file.previousPath ? [file.previousPath] : [])],
          spans: [],
          findingIds: [],
        })
      );
    }
  }
  const findings =
    previous?.state.findings.filter(finding =>
      ['open', 'reintroduced'].includes(finding.lifecycle)
    ) ?? [];
  for (let i = 0; i < findings.length; i += 8) {
    units.push(
      unit({
        kind: 'reconcile',
        basis,
        question:
          'Reconcile every assigned prior finding against current pinned code, preserving stable IDs and explicit dispositions. Prior comments are not proof.',
        paths: [],
        spans: [],
        findingIds: findings.slice(i, i + 8).map(finding => finding.id),
      })
    );
  }
  assertReviewWorkPlan(units, files, options);
  return units;
}

export function assertReviewWorkPlan(
  units: ReviewWorkUnit[],
  files: ReviewChangedFile[],
  options: ReviewCoverageOptions
): void {
  if (
    units.length > options.maxUnits ||
    new Set(units.map(item => item.id)).size !== units.length
  ) {
    throw new Error('Coverage inventory exceeds the explicit work-unit budget');
  }
  const spans = units.flatMap(item => item.spans);
  const covered = new Set(spans.map(span => span.fileId));
  if (
    new Set(spans.map(span => span.id)).size !== spans.length ||
    files.some(file => !covered.has(file.id))
  ) {
    throw new Error('Coverage plan duplicated a range or omitted a changed file');
  }
  for (const file of files) {
    if (file.binary) {
      continue;
    }
    for (const hunk of file.hunks) {
      const assigned = spans
        .filter(
          span =>
            span.fileId === file.id &&
            span.patchStartLine >= hunk.patchStartLine &&
            span.patchEndLine <= hunk.patchEndLine
        )
        .sort((a, b) => a.patchStartByte! - b.patchStartByte!);
      if (
        !assigned.length ||
        assigned[0]!.patchStartLine !== hunk.patchStartLine ||
        assigned.at(-1)!.patchEndLine !== hunk.patchEndLine ||
        assigned.some(
          (span, index) => index > 0 && assigned[index - 1]!.patchEndByte !== span.patchStartByte
        )
      ) {
        throw new Error('Coverage plan omitted or overlapped a changed hunk range');
      }
    }
  }
}

export function followUpWorkDefinition(
  request: ReviewWorkFollowUp,
  basis: ReviewWorkUnit['basis']
): ReviewWorkUnit {
  const paths = [...new Set(request.paths)].sort();
  if (!paths.length || paths.length > 8 || paths.some(path => !validReviewPath(path))) {
    throw new Error('Invalid follow-up source paths');
  }
  if (request.digestCheck) {
    const check = request.digestCheck;
    if (paths.length !== 1 || paths[0] !== check.manifestPath) {
      throw new Error(
        'Digest follow-ups must name only their manifest; request semantic checks separately.'
      );
    }
    return unit({
      kind: 'followup',
      basis,
      question: `Native digest check: ${JSON.stringify({ manifestPath: check.manifestPath, pointer: check.pointer, normalization: check.normalization, selection: check.selection })}`,
      paths,
      spans: [],
      findingIds: [],
    });
  }
  return unit({
    kind: 'followup',
    basis,
    question: request.question.trim(),
    paths,
    spans: [],
    findingIds: [],
  });
}

export async function followUpWorkUnit(
  request: ReviewWorkFollowUp,
  snapshot: ReviewSnapshot,
  signal?: AbortSignal
): Promise<ReviewWorkUnit> {
  const result = followUpWorkDefinition(request, snapshot.mode);
  const paths = result.paths;
  const roots = [
    snapshot.headPath,
    snapshot.basePath,
    snapshot.targetPath,
    snapshot.previousPath,
  ].filter((value): value is string => Boolean(value));
  for (const path of paths) {
    signal?.throwIfAborted();
    let found = false;
    for (const root of roots) {
      try {
        signal?.throwIfAborted();
        const handle = await open(
          await pinnedFilePath(root, path),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK
        );
        try {
          if ((await handle.stat()).isFile()) {
            found = true;
          }
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    if (!found) {
      throw new Error(`Follow-up scope source is unavailable: ${path}`);
    }
  }
  return result;
}

export function normalizedWorkUnits(units: ReviewWorkUnit[]): unknown {
  return units.map(item => ({ ...item, spans: item.spans.map(normalizedSpan) }));
}
