import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { reviewHash, reviewIdentity } from './state';
import type { ReviewSnapshot } from './types';
import type {
  DigestNormalization,
  ReviewCoverageInventory,
  ReviewUnitResult,
  ReviewWorkFollowUp,
  ReviewWorkUnit,
} from './work-types';

export const ReviewDigestCheckSchema = Type.Object(
  {
    manifestPath: Type.String({ minLength: 1, maxLength: 512 }),
    pointer: Type.String({ maxLength: 1024 }),
    normalization: Type.Union([Type.Literal('sha256-raw-v1'), Type.Literal('sha256-utf8-lf-v1')]),
    selection: Type.Union([Type.Literal('changed'), Type.Literal('all')]),
  },
  { additionalProperties: false }
);
const checkValidator = Compile(ReviewDigestCheckSchema);
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT = 6 * 1024;
type Role = 'H' | 'M' | 'B' | 'P';
export interface ReviewDigestReceipt {
  role: Role;
  sha: string;
  path: string;
  algorithm: 'sha256';
  normalization: DigestNormalization;
  digest: string;
  bytes: number;
}

function validPath(path: string, maxBytes = 512): boolean {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    Buffer.byteLength(path) <= maxBytes &&
    !isAbsolute(path) &&
    !/^[A-Za-z]:/.test(path) &&
    !/[\\\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every(part => Boolean(part) && part !== '.' && part !== '..')
  );
}
function abort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
function within(root: string, file: string): boolean {
  const rel = relative(root, file);
  return Boolean(rel) && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
export async function pinnedFilePath(root: string, path: string): Promise<string> {
  if (!validPath(path, 1000)) {
    throw new Error('Invalid pinned source path');
  }
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error('Digest source symlinks are forbidden');
    }
  }
  if (!within(canonicalRoot, await realpath(current))) {
    throw new Error('Digest source escapes snapshot');
  }
  return current;
}
async function boundedRead(file: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  abort(signal);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) {
      throw new Error('Digest evidence exceeds byte budget or is not a regular file');
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      abort(signal);
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit - bytes + 1));
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (!read.bytesRead) {
        break;
      }
      bytes += read.bytesRead;
      if (bytes > limit) {
        throw new Error('Digest evidence exceeds byte budget');
      }
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    abort(signal);
    return Buffer.concat(chunks, bytes);
  } finally {
    await handle.close();
  }
}
function utf8(data: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
}
async function inventory(
  snapshot: ReviewSnapshot,
  signal?: AbortSignal
): Promise<ReviewCoverageInventory | null> {
  abort(signal);
  if (!snapshot.coverageInventoryPath) {
    return null;
  }
  const root = resolve(dirname(snapshot.fullDiffPath));
  if (!within(root, resolve(snapshot.coverageInventoryPath))) {
    throw new Error('Digest inventory escapes evidence directory');
  }
  const file = await pinnedFilePath(root, relative(root, snapshot.coverageInventoryPath));
  const value = JSON.parse(
    utf8(await boundedRead(file, MAX_BYTES, signal))
  ) as ReviewCoverageInventory;
  const identity = reviewIdentity(snapshot);
  if (
    value.version !== 1 ||
    !value.identity ||
    Object.entries(identity).some(
      ([key, expected]) => value.identity[key as keyof typeof identity] !== expected
    ) ||
    !Array.isArray(value.full) ||
    value.full.length > 10_000 ||
    value.full.some(
      item =>
        !item ||
        !validPath(item.path) ||
        (item.previousPath !== null && !validPath(item.previousPath))
    ) ||
    (value.previousHeadSha !== null && !/^[a-f0-9]{40}$/.test(value.previousHeadSha))
  ) {
    throw new Error('Invalid digest coverage inventory');
  }
  return value;
}
async function source(
  snapshot: ReviewSnapshot,
  role: Role
): Promise<{ root: string; sha: string }> {
  switch (role) {
    case 'H':
      return { root: snapshot.headPath, sha: snapshot.headSha };
    case 'M':
      return { root: snapshot.basePath, sha: snapshot.mergeBaseSha };
    case 'B':
      if (snapshot.targetPath) {
        return { root: snapshot.targetPath, sha: snapshot.baseSha };
      }
      break;
    case 'P': {
      const previous = (await inventory(snapshot))?.previousHeadSha;
      if (snapshot.previousPath && previous) {
        return { root: snapshot.previousPath, sha: previous };
      }
      break;
    }
  }
  throw new Error(`Snapshot role ${role} unavailable`);
}
export async function digestReviewFiles(
  snapshot: ReviewSnapshot,
  paths: string[],
  normalization: DigestNormalization,
  signal?: AbortSignal,
  role: Role = 'H'
): Promise<ReviewDigestReceipt[]> {
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  abort(signal);
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.length > 8 ||
    paths.some(path => !validPath(path)) ||
    new Set(paths).size !== paths.length
  ) {
    throw new Error('Digest calls require 1 to 8 distinct valid paths');
  }
  if (normalization !== 'sha256-raw-v1' && normalization !== 'sha256-utf8-lf-v1') {
    throw new Error('Invalid digest normalization');
  }
  const { root, sha } = await source(snapshot, role);
  let remaining = MAX_BYTES;
  const receipts: ReviewDigestReceipt[] = [];
  for (const path of paths) {
    abort(signal);
    const data = await boundedRead(await pinnedFilePath(root, path), remaining, signal);
    remaining -= data.length;
    const input = normalization === 'sha256-raw-v1' ? data : utf8(data).replace(/\r\n?/g, '\n');
    abort(signal);
    receipts.push({
      role,
      sha,
      path,
      algorithm: 'sha256',
      normalization,
      digest: createHash('sha256').update(input).digest('hex'),
      bytes: data.length,
    });
  }
  if (Buffer.byteLength(JSON.stringify(receipts)) > MAX_OUTPUT) {
    throw new Error('Digest receipts exceed output budget');
  }
  return receipts;
}
function pointerMap(value: unknown, pointer: string): Record<string, string> {
  if (pointer && !pointer.startsWith('/')) {
    throw new Error('Invalid digest JSON pointer');
  }
  for (const token of pointer ? pointer.slice(1).split('/') : []) {
    if (/~(?![01])/u.test(token)) {
      throw new Error('Invalid digest JSON pointer escape');
    }
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      throw new Error('Digest JSON pointer is absent');
    }
    value = (value as Record<string, unknown>)[key];
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length > 256
  ) {
    throw new Error('Digest manifest must contain a bounded plain map');
  }
  for (const [path, digest] of Object.entries(value)) {
    if (!validPath(path) || typeof digest !== 'string' || !/^[a-fA-F0-9]{64}$/.test(digest)) {
      throw new Error('Invalid digest manifest entry');
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([path, digest]) => [path, (digest as string).toLowerCase()])
  );
}
async function manifest(
  root: string,
  path: string,
  pointer: string,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  abort(signal);
  return pointerMap(
    JSON.parse(utf8(await boundedRead(await pinnedFilePath(root, path), 64 * 1024, signal))),
    pointer
  );
}
export async function expandDigestCheck(
  rootUnit: ReviewWorkUnit,
  request: ReviewWorkFollowUp,
  snapshot: ReviewSnapshot,
  signal?: AbortSignal
): Promise<ReviewWorkUnit[]> {
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  abort(signal);
  if (!request.digestCheck) {
    return [rootUnit];
  }
  const check = request.digestCheck;
  if (
    !checkValidator.Check(check) ||
    !validPath(check.manifestPath) ||
    request.paths.length !== 1 ||
    request.paths[0] !== check.manifestPath
  ) {
    throw new Error('Invalid digest check or manifest-only scope');
  }
  const head = await manifest(snapshot.headPath, check.manifestPath, check.pointer, signal);
  let base: Record<string, string> = {};
  if (check.selection === 'changed') {
    // Only a genuinely absent merge-base manifest permits an empty baseline.
    await realpath(snapshot.basePath);
    try {
      base = await manifest(snapshot.basePath, check.manifestPath, check.pointer, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  const full = check.selection === 'changed' ? await inventory(snapshot, signal) : null;
  const changed = new Set(
    full?.full.flatMap(file => [file.path, ...(file.previousPath ? [file.previousPath] : [])])
  );
  const items = Object.keys(head)
    .sort()
    .filter(
      path => check.selection === 'all' || !full || head[path] !== base[path] || changed.has(path)
    )
    .map(path => ({ path, expectedDigest: head[path]! }));
  const leaves: ReviewWorkUnit[] = [];
  const leaf = (group: typeof items): ReviewWorkUnit => {
    const digest = {
      manifestPath: check.manifestPath,
      normalization: check.normalization,
      items: group,
      children: [],
    };
    return {
      ...rootUnit,
      kind: 'followup',
      id: reviewHash({ parent: rootUnit.id, basis: rootUnit.basis, digest }),
      paths: group.map(item => item.path),
      spans: [],
      findingIds: [],
      digest,
    };
  };
  let group: typeof items = [];
  for (const item of items) {
    abort(signal);
    const candidate = leaf([...group, item]);
    if (
      candidate.digest!.items.length > 8 ||
      maximumDigestResultBytes(candidate, snapshot) > MAX_OUTPUT
    ) {
      if (group.length) {
        leaves.push(leaf(group));
      }
      group = [item];
      if (maximumDigestResultBytes(leaf(group), snapshot) > MAX_OUTPUT) {
        throw new Error('Digest item cannot fit result envelope budget');
      }
    } else {
      group = candidate.digest!.items;
    }
  }
  if (group.length) {
    leaves.push(leaf(group));
  }
  const aggregate: ReviewWorkUnit = {
    ...rootUnit,
    paths: [...new Set([...rootUnit.paths, check.manifestPath])].sort(),
    digest: {
      manifestPath: check.manifestPath,
      normalization: check.normalization,
      items: [],
      children: leaves.map(leaf => leaf.id),
    },
  };
  digestAggregateResult(
    aggregate,
    leaves.map(leaf => ({ id: leaf.id, evidenceHash: '0'.repeat(64) }))
  );
  return [aggregate, ...leaves];
}

export function digestAggregateResult(
  unit: ReviewWorkUnit,
  partitions: { id: string; evidenceHash: string }[]
): ReviewUnitResult {
  if (
    !unit.digest ||
    unit.digest.items.length ||
    partitions.length !== unit.digest.children.length ||
    partitions.some(
      (part, index) =>
        part.id !== unit.digest!.children[index] || !/^[a-f0-9]{64}$/.test(part.evidenceHash)
    )
  ) {
    throw new Error('Digest aggregate scope or partition identity is invalid');
  }
  const result: ReviewUnitResult = {
    unitId: unit.id,
    status: 'reviewed',
    coveredSpanIds: [],
    reconciledFindingIds: [],
    assessment: JSON.stringify({
      mechanicalOnly: true,
      manifestPath: unit.digest.manifestPath,
      normalization: unit.digest.normalization,
      partitions,
    }),
    limitations: [],
    findings: [],
    followUps: [],
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT) {
    throw new Error(
      'Digest aggregate exceeds result budget; narrow the material scope or report blocked coverage.'
    );
  }
  return result;
}
function digestResult(
  unitId: string,
  receipts: ReviewDigestReceipt[],
  items: { path: string; expectedDigest: string }[]
): ReviewUnitResult {
  const evidence = receipts.map((receipt, index) => ({
    ...receipt,
    expectedDigest: items[index]!.expectedDigest,
    match: receipt.digest === items[index]!.expectedDigest,
  }));
  const limitations = evidence
    .filter(item => !item.match)
    .map(item => `Digest mismatch: ${item.path}`);
  return {
    unitId,
    status: limitations.length ? 'blocked' : 'reviewed',
    coveredSpanIds: [],
    reconciledFindingIds: [],
    assessment: JSON.stringify(evidence),
    limitations,
    findings: [],
    followUps: [],
  };
}

function maximumDigestResultBytes(unit: ReviewWorkUnit, snapshot: ReviewSnapshot): number {
  const recipe = unit.digest!;
  const receipts: ReviewDigestReceipt[] = recipe.items.map(item => ({
    role: 'H',
    sha: snapshot.headSha,
    path: item.path,
    algorithm: 'sha256',
    normalization: recipe.normalization,
    digest: `${item.expectedDigest[0] === '0' ? '1' : '0'}${item.expectedDigest.slice(1)}`,
    bytes: MAX_BYTES,
  }));
  // All mismatches maximize limitations and comparison widths; outer JSON escapes assessment again.
  return Buffer.byteLength(JSON.stringify(digestResult(unit.id, receipts, recipe.items)));
}

export async function executeDigestUnit(
  unit: ReviewWorkUnit,
  snapshot: ReviewSnapshot,
  signal?: AbortSignal
): Promise<ReviewUnitResult> {
  if (
    !unit.digest ||
    unit.digest.children.length ||
    !unit.digest.items.length ||
    unit.digest.items.length > 8
  ) {
    throw new Error('Native digest execution requires a leaf');
  }
  const result: ReviewUnitResult = {
    unitId: unit.id,
    status: 'blocked',
    coveredSpanIds: [],
    reconciledFindingIds: [],
    assessment: '',
    limitations: [],
    findings: [],
    followUps: [],
  };
  try {
    const receipts = await digestReviewFiles(
      snapshot,
      unit.digest.items.map(item => item.path),
      unit.digest.normalization,
      signal
    );
    Object.assign(result, digestResult(unit.id, receipts, unit.digest.items));
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT) {
      throw new Error('Digest result envelope exceeds output budget');
    }
  } catch (error) {
    result.status = 'blocked';
    const reason = String(error).slice(0, 1024);
    result.assessment = JSON.stringify({ error: reason });
    result.limitations = [`Native digest verification unavailable: ${reason}`];
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT) {
    throw new Error('Digest result envelope exceeds output budget');
  }
  return result;
}

export function validateDigestResult(
  unit: ReviewWorkUnit,
  snapshot: ReviewSnapshot,
  result: ReviewUnitResult
): void {
  const recipe = unit.digest;
  if (
    !recipe ||
    recipe.children.length ||
    !recipe.items.length ||
    recipe.items.length > 8 ||
    result.unitId !== unit.id ||
    result.status !== 'reviewed' ||
    result.coveredSpanIds.length ||
    result.reconciledFindingIds.length ||
    result.limitations.length ||
    result.findings.length ||
    result.followUps.length ||
    Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT
  ) {
    throw new Error('Invalid native digest result envelope');
  }
  const receipts: unknown = JSON.parse(result.assessment);
  if (
    !Array.isArray(receipts) ||
    receipts.length !== recipe.items.length ||
    new Set(recipe.items.map(item => item.path)).size !== recipe.items.length ||
    unit.paths.length !== recipe.items.length ||
    new Set(unit.paths).size !== unit.paths.length
  ) {
    throw new Error('Invalid native digest receipt scope');
  }
  for (const [index, item] of recipe.items.entries()) {
    const receipt = receipts[index] as Record<string, unknown> | null;
    if (
      !validPath(item.path) ||
      !unit.paths.includes(item.path) ||
      !/^[a-f0-9]{64}$/.test(item.expectedDigest) ||
      !receipt ||
      typeof receipt !== 'object' ||
      Array.isArray(receipt) ||
      Object.keys(receipt).sort().join(',') !==
        'algorithm,bytes,digest,expectedDigest,match,normalization,path,role,sha' ||
      receipt.path !== item.path ||
      receipt.role !== 'H' ||
      receipt.sha !== snapshot.headSha ||
      receipt.algorithm !== 'sha256' ||
      receipt.normalization !== recipe.normalization ||
      receipt.digest !== item.expectedDigest ||
      receipt.expectedDigest !== item.expectedDigest ||
      receipt.match !== true ||
      typeof receipt.bytes !== 'number' ||
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes < 0 ||
      receipt.bytes > MAX_BYTES
    ) {
      throw new Error('Invalid native digest receipt identity or comparison');
    }
  }
  if (
    receipts.reduce((sum, receipt) => sum + (receipt as ReviewDigestReceipt).bytes, 0) > MAX_BYTES
  ) {
    throw new Error('Invalid native digest receipt byte budget');
  }
}
