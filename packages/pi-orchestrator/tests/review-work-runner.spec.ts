import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionToolContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { PlatformProvider } from '../src/platform';
import type { Logger, PiAgentFactory, PiConfig, PromptResult, SessionStats } from '../src/types';
import { commitReview } from '../src/review/runner';
import type { PreparedReview } from '../src/review/runner';
import {
  advanceReview,
  renderReviewComment,
  reviewHash,
  reviewIdentity,
} from '../src/review/state';
import { parseReviewSubmission } from '../src/review/submission';
import { reviewCoverageOptions } from '../src/review/work-plan';
import { ReviewCoverageRunError, runReviewCoverage } from '../src/review/work-runner';
import { parseReviewWorkState } from '../src/review/work-state';
import {
  createReviewSynthesisCapture,
  createReviewUnitCapture,
  parseReviewFollowUps,
  parseReviewUnitResult,
} from '../src/review/work-submission';
import type {
  FindingInput,
  ReviewSnapshot,
  ReviewStateRecord,
  ReviewSubmission,
} from '../src/review/types';
import type {
  ReviewChangedFile,
  ReviewCoverageInventory,
  ReviewCoverageOptions,
  ReviewUnitResult,
  ReviewWorkFollowUp,
  ReviewWorkRecord,
  ReviewWorkState,
  ReviewWorkStore,
  ReviewWorkUnit,
} from '../src/review/work-types';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

class MemoryWorkStore implements ReviewWorkStore {
  record: ReviewWorkRecord | null = null;
  journal: ReviewWorkRecord[] = [];
  loads = 0;
  loadSignals: (AbortSignal | undefined)[] = [];
  saveSignals: (AbortSignal | undefined)[] = [];
  beforeLoad?: (signal?: AbortSignal) => Promise<void>;
  beforeSave?: (state: ReviewWorkState, signal?: AbortSignal) => void | Promise<void>;

  async load(signal?: AbortSignal): Promise<ReviewWorkRecord | null> {
    this.loads++;
    this.loadSignals.push(signal);
    await this.beforeLoad?.(signal);
    return structuredClone(this.record);
  }

  async save(
    expected: ReviewWorkRecord | null,
    state: ReviewWorkState,
    signal?: AbortSignal
  ): Promise<ReviewWorkRecord> {
    this.saveSignals.push(signal);
    await this.beforeSave?.(state, signal);
    if (JSON.stringify(expected) !== JSON.stringify(this.record)) {
      throw new Error('Unexpected coverage journal compare/save conflict');
    }
    const parsed = parseReviewWorkState(state);
    this.record = { commentId: 42, body: JSON.stringify(parsed), state: parsed };
    this.journal.push(structuredClone(this.record));
    return structuredClone(this.record);
  }
}

function complete(): ReviewSubmission {
  return {
    coverage: 'complete',
    coverageNotes:
      'Fixture static review only; deployment and external operational assumptions are unverified.',
    findings: [],
  };
}

function candidate(): FindingInput {
  return {
    id: null,
    rootCause: 'Changed eligibility predicate permits an unchecked value.',
    origin: 'pr_introduced',
    lifecycle: 'open',
    material: true,
    location: 'src/file-0.ts:1',
    evidence: 'Pinned head changes the guarded value from 0 to 1.',
    originEvidence: 'Pinned merge-base uses 0 at the same location.',
    dispositionReason: '',
  };
}

function reviewed(
  unit: ReviewWorkUnit,
  overrides: Partial<ReviewUnitResult> = {}
): ReviewUnitResult {
  return {
    unitId: unit.id,
    status: 'reviewed',
    coveredSpanIds: unit.spans.map(span => span.id),
    reconciledFindingIds: [...unit.findingIds],
    assessment: 'Assigned fixture spans and integration question inspected against pinned source.',
    limitations: [],
    findings: [],
    followUps: [],
    ...overrides,
  };
}

const stats: SessionStats = {
  inputTokens: 3,
  outputTokens: 2,
  totalTokens: 5,
  cost: 0.125,
  version: 'fixture-sdk',
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture(count = 1, options: Partial<ReviewCoverageOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'review-work-runner-'));
  roots.push(root);
  const snapshot: ReviewSnapshot = {
    repository: 'owner/repository',
    pullNumber: 7,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    mergeBaseSha: 'c'.repeat(40),
    baseRef: 'main',
    intentHash: reviewHash('declared intent'),
    mode: 'full',
    fallbackReason: null,
    headPath: join(root, 'H'),
    basePath: join(root, 'M'),
    targetPath: join(root, 'B'),
    previousPath: null,
    fullDiffPath: join(root, 'full.diff'),
    incrementalDiffPath: null,
    coverageInventoryPath: join(root, 'coverageInventory.json'),
  };
  await Promise.all(
    [snapshot.headPath, snapshot.basePath, snapshot.targetPath!].map(path =>
      mkdir(join(path, 'src'), { recursive: true })
    )
  );
  const files: ReviewChangedFile[] = [];
  const patches: string[] = [];
  for (let index = 0; index < count; index++) {
    const path = `src/file-${index}.ts`;
    const before = `export const value${index} = 0;\n`;
    const after = `export const value${index} = 1;\n`;
    const patch = [
      `diff --git a/${path} b/${path}`,
      'index ddddddd..eeeeeee 100644',
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1,1 +1,1 @@',
      `-${before.trimEnd()}`,
      `+${after.trimEnd()}`,
      '',
    ].join('\n');
    const patchPath = join(root, `patch-${index}.diff`);
    await Promise.all([
      writeFile(patchPath, patch),
      writeFile(join(snapshot.headPath, path), after),
      writeFile(join(snapshot.basePath, path), before),
      writeFile(join(snapshot.targetPath!, path), before),
    ]);
    patches.push(patch);
    files.push({
      id: reviewHash({ path, patch }),
      path,
      previousPath: null,
      status: 'modified',
      oldBlob: 'd'.repeat(40),
      newBlob: 'e'.repeat(40),
      oldMode: '100644',
      newMode: '100644',
      binary: false,
      patchBytes: Buffer.byteLength(patch),
      patchPath,
      hunks: [
        {
          index: 0,
          patchStartLine: 5,
          patchEndLine: 7,
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
        },
      ],
    });
  }
  await writeFile(snapshot.fullDiffPath, patches.join(''));
  const inventory = async () => {
    const data: ReviewCoverageInventory = {
      version: 1,
      identity: reviewIdentity(snapshot),
      previousHeadSha: null,
      full: files,
      incremental: null,
    };
    await writeFile(snapshot.coverageInventoryPath!, JSON.stringify(data));
  };
  await inventory();
  const prepared: PreparedReview = {
    previous: null,
    snapshot,
    dependencies: { policyVersion: 'fixture-v1', complete: true, contexts: [], notes: [] },
    configurationHash: reviewHash('review configuration'),
    operationKey: reviewHash('operation'),
    intervention: null,
    maxRounds: 3,
    prompt: 'Review the pinned fixture statically. Do not execute PR code or certify deployment.',
    skip: null,
    coverageOptions: reviewCoverageOptions({ maxUnitFiles: 1, ...options }),
  };
  const config: PiConfig = {
    provider: 'fixture',
    model: 'root-reviewer',
    reviewSubagentModel: 'unit-reviewer',
    token: 'not-a-network-credential',
    thinkingLevel: 'high',
    promptInput: 'Review',
    statefulReview: true,
    reviewCoverage: true,
    cwd: root,
  };
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    notice: vi.fn(),
    error: vi.fn(),
  };
  const store = new MemoryWorkStore();
  let canonical: ReviewStateRecord | null = null;
  const publish = vi.fn<NonNullable<PlatformProvider['statefulReview']>['publish']>(
    async (expected, _snapshot, state, body) => {
      if (JSON.stringify(expected) !== JSON.stringify(canonical)) {
        throw new Error('Canonical predecessor changed');
      }
      canonical = { commentId: 99, state: structuredClone(state), body };
    }
  );
  const provider = {
    type: 'github',
    statefulReview: {
      loadState: async () => structuredClone(canonical),
      snapshot: async () => snapshot,
      authorizeControl: async () => undefined,
      workStore: store,
      publish,
    },
  } as unknown as PlatformProvider;
  function seedPrevious() {
    const state = advanceReview(
      null,
      snapshot,
      complete(),
      prepared.configurationHash,
      reviewHash('prior operation'),
      3
    );
    canonical = { commentId: 99, state, body: renderReviewComment(state) };
    prepared.previous = structuredClone(canonical);
  }
  const run = (factory: PiAgentFactory, startedAt = Date.now()) =>
    runReviewCoverage(config, logger, provider, factory, prepared, startedAt);
  return {
    root,
    config,
    prepared,
    snapshot,
    inventory,
    store,
    provider,
    publish,
    seedPrevious,
    canonical: () => structuredClone(canonical),
    run,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
interface Hooks {
  unit?: (
    unit: ReviewWorkUnit,
    attempt: number,
    prompt: string,
    config: PiConfig
  ) => Promise<ReviewUnitResult>;
  synthesis?: (
    attempt: number,
    prompt: string,
    config: PiConfig
  ) => Promise<ReviewSubmission | ReviewWorkFollowUp[]>;
  abort?: (unit: ReviewWorkUnit | undefined, attempt: number) => Promise<void>;
  dispose?: (unit: ReviewWorkUnit | undefined, attempt: number) => Promise<void>;
}

function fakePiAgent(f: Fixture, hooks: Hooks = {}) {
  const calls: {
    unit: ReviewWorkUnit | undefined;
    config: PiConfig;
    attempt: number;
    prompt: string;
  }[] = [];
  const attempts = new Map<string, number>();
  const validationErrors: unknown[] = [];
  const factory: PiAgentFactory = config => {
    const unit = config.reviewWorkUnit;
    if (!unit && !config.reviewCoverageSynthesis) {
      throw new Error('Unexpected root session');
    }
    const key = unit?.id ?? 'synthesis';
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const call = { unit, config, attempt, prompt: '' };
    calls.push(call);
    return {
      run: async prompt => {
        call.prompt = prompt;
        if (unit) {
          const raw = hooks.unit ? await hooks.unit(unit, attempt, prompt, config) : reviewed(unit);
          try {
            const result = parseReviewUnitResult(raw, unit);
            if (!config.reviewUnitValidator) {
              throw new Error('Worker capture validator missing');
            }
            await config.reviewUnitValidator(structuredClone(result));
            return { result: '', error: undefined, sessionStats: stats, reviewUnit: result };
          } catch (error) {
            validationErrors.push(error);
            throw error;
          }
        }
        const raw = hooks.synthesis ? await hooks.synthesis(attempt, prompt, config) : complete();
        try {
          if (Array.isArray(raw)) {
            const requests = parseReviewFollowUps(raw);
            if (!config.reviewFollowupValidator) {
              throw new Error('Follow-up capture validator missing');
            }
            await config.reviewFollowupValidator(structuredClone(requests));
            return { result: '', error: undefined, sessionStats: stats, reviewFollowUps: requests };
          }
          const review = parseReviewSubmission(raw);
          if (!config.reviewSubmissionValidator) {
            throw new Error('Synthesis capture validator missing');
          }
          await config.reviewSubmissionValidator(structuredClone(review));
          return { result: '', error: undefined, sessionStats: stats, review };
        } catch (error) {
          validationErrors.push(error);
          throw error;
        }
      },
      getSessionStats: () => stats,
      dispose: async () => hooks.dispose?.(unit, attempt),
      abort: async () => hooks.abort?.(unit, attempt),
      exportSessionHtml: async () => {
        throw new Error('Unexpected session export');
      },
      exportSessionJsonl: async () => {
        throw new Error('Unexpected session export');
      },
    };
  };
  return {
    factory,
    calls,
    attempts,
    validationErrors,
    workers: () => calls.filter(call => call.unit),
    syntheses: () => calls.filter(call => !call.unit),
    run: () => f.run(factory),
  };
}

function expectUsage(result: Pick<PromptResult, 'sessionStats'>, sessions: number) {
  expect(result.sessionStats).toEqual({
    inputTokens: stats.inputTokens * sessions,
    outputTokens: stats.outputTokens * sessions,
    totalTokens: stats.totalTokens * sessions,
    cost: stats.cost * sessions,
    version: stats.version,
  });
}

async function expectUnpublished(f: Fixture, result: PromptResult, before = f.canonical()) {
  expect(result.review?.coverage).toBe('incomplete');
  expect(f.store.record?.state.phase).toBe('collecting');
  expect(f.store.journal.every(record => record.state.phase !== 'ready')).toBe(true);
  await expect(commitReview(f.provider, f.prepared, result)).rejects.toThrow();
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.canonical()).toEqual(before);
}

async function captureTools(factory: ExtensionFactory) {
  const tools = new Map<string, ToolDefinition>();
  await factory({
    on: vi.fn(),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI);
  return (name: string, value: unknown) =>
    tools
      .get(name)!
      .execute('fixture-submission', value, undefined, undefined, {} as ExtensionToolContext);
}

async function manifestFixture(count: number) {
  const f = await fixture(count, { maxUnitFiles: 8 });
  const sources: Record<string, string> = {};
  for (let index = 0; index < count; index++) {
    const path = `src/file-${index}.ts`;
    const data = await readFile(join(f.snapshot.headPath, path));
    sources[path] = createHash('sha256')
      .update(data.toString('utf8').replace(/\r\n?/g, '\n'))
      .digest('hex');
  }
  const manifest = JSON.stringify({ sources });
  await Promise.all(
    [f.snapshot.headPath, f.snapshot.basePath].map(root =>
      writeFile(join(root, 'manifest.json'), manifest)
    )
  );
  const request: ReviewWorkFollowUp = {
    paths: ['manifest.json'],
    question: 'Verify every manifest source digest against the pinned head.',
    digestCheck: {
      manifestPath: 'manifest.json',
      pointer: '/sources',
      normalization: 'sha256-utf8-lf-v1',
      selection: 'all',
    },
  };
  return { ...f, sources, request };
}

function nativeEvidence(state: ReviewWorkState) {
  const leaves: {
    entryId: string;
    result: ReviewUnitResult;
    receipts: Record<string, unknown>[];
  }[] = [];
  const roots: { entryId: string; partitions: { id: string; evidenceHash: string }[] }[] = [];
  for (const entry of state.entries) {
    if (entry.data?.kind !== 'unit') {
      continue;
    }
    const result = entry.data.result;
    if (!result.assessment.startsWith('[') && !result.assessment.startsWith('{')) {
      continue;
    }
    const evidence = JSON.parse(result.assessment);
    if (Array.isArray(evidence)) {
      leaves.push({ entryId: entry.id, result, receipts: evidence });
    } else if (evidence.mechanicalOnly) {
      roots.push({ entryId: entry.id, partitions: evidence.partitions });
    }
  }
  return { leaves, roots };
}

describe('host coverage work integration', () => {
  it('rejects unavailable worker scope before return and accepts a corrected proposal in the same session', async () => {
    const f = await fixture(2);
    const rejected: unknown[] = [];
    const fake = fakePiAgent(f, {
      unit: async (unit, attempt, _prompt, config) => {
        if (unit.kind !== 'diff' || !unit.paths.includes('src/file-0.ts')) {
          return reviewed(unit);
        }
        expect(attempt).toBe(1);
        const capture = createReviewUnitCapture(unit, config.reviewUnitValidator);
        const execute = await captureTools(capture.factory);
        const invalid = reviewed(unit, {
          followUps: [{ paths: ['src/missing.ts'], question: 'Inspect the consumer contract.' }],
        });
        await expect(
          execute('submit_review_unit_result', invalid).catch(error => {
            rejected.push(error);
            throw error;
          })
        ).rejects.toThrow(/unavailable|missing|exist|source/i);
        expect(f.store.record!.state.entries.filter(entry => entry.kind === 'unit')).toHaveLength(
          2
        );
        const corrected = reviewed(unit, {
          followUps: [{ paths: ['src/file-0.ts'], question: 'Inspect the consumer contract.' }],
        });
        expect(capture.getResult()).toBeUndefined();
        await expect(execute('submit_review_unit_result', corrected)).resolves.toMatchObject({
          terminate: true,
        });
        return capture.getResult()!;
      },
    });
    const result = await fake.run();
    expect(rejected).toHaveLength(1);
    expect(fake.validationErrors).toEqual([]);
    expect(fake.workers()).toHaveLength(3);
    expect(fake.workers().every(call => call.attempt === 1)).toBe(true);
    expect(JSON.stringify(f.store.record)).not.toContain('src/missing.ts');
    expect(result.review?.coverage).toBe('complete');
  });

  it('rejects unavailable synthesis scope before return without poisoning completed workers', async () => {
    const f = await fixture(2);
    const fake = fakePiAgent(f, {
      synthesis: async (attempt, _prompt, config) => {
        if (attempt > 1) {
          return complete();
        }
        const capture = createReviewSynthesisCapture(
          config.reviewSubmissionValidator,
          config.reviewFollowupValidator
        );
        const execute = await captureTools(capture.factory);
        const before = structuredClone(
          f.store.record!.state.entries.filter(entry => entry.kind === 'unit')
        );
        await expect(
          execute('request_review_followup', {
            requests: [{ paths: ['src/missing.ts'], question: 'Inspect synthesis source.' }],
          })
        ).rejects.toThrow(/unavailable|missing|exist|source/i);
        expect(f.store.record!.state.entries.filter(entry => entry.kind === 'unit')).toEqual(
          before
        );
        const requests = [{ paths: ['src/file-0.ts'], question: 'Inspect synthesis source.' }];
        expect(capture.getFollowUps()).toBeUndefined();
        await expect(execute('request_review_followup', { requests })).resolves.toMatchObject({
          terminate: true,
        });
        return capture.getFollowUps()!;
      },
    });
    const result = await fake.run();
    expect(result.review?.coverage).toBe('complete');
    expect(fake.validationErrors).toEqual([]);
    expect(fake.workers()).toHaveLength(3);
    expect(fake.workers().every(call => call.attempt === 1)).toBe(true);
    expect(fake.syntheses()).toHaveLength(2);
    expect(JSON.stringify(f.store.record)).not.toContain('src/missing.ts');
  });

  it('preflights concurrent proposals against shared capacity and lets the valid worker finish', async () => {
    const f = await fixture(2, { maxUnits: 3 });
    const bothEntered = deferred();
    const admitted: string[] = [];
    const rejected: unknown[] = [];
    let entered = 0;
    const fake = fakePiAgent(f, {
      unit: async (unit, _attempt, _prompt, config) => {
        if (unit.kind !== 'diff') {
          return reviewed(unit);
        }
        if (++entered === 2) {
          bothEntered.resolve();
        }
        await bothEntered.promise;
        const proposal = reviewed(unit, {
          followUps: [
            { paths: unit.paths, question: `Inspect distinct invariant for ${unit.paths[0]}.` },
          ],
        });
        try {
          await config.reviewUnitValidator!(proposal);
          admitted.push(unit.id);
          return proposal;
        } catch (error) {
          rejected.push(error);
          return reviewed(unit);
        }
      },
    });
    const result = await fake.run();
    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0])).toMatch(/budget|capacity/i);
    expect(result.review?.coverage).toBe('complete');
    expect(fake.workers()).toHaveLength(3);
    expect(fake.validationErrors).toEqual([]);
    for (const record of f.store.journal) {
      expect(
        record.state.entries.filter(entry => entry.kind === 'unit').length
      ).toBeLessThanOrEqual(3);
    }
    expect(f.store.record!.state.entries.every(entry => entry.status === 'reviewed')).toBe(true);
  });

  it('keeps admission storage failures fatal without persisting phantom follow-up units', async () => {
    const f = await fixture();
    f.store.beforeSave = state => {
      if (state.entries.filter(entry => entry.kind === 'unit').length > 1) {
        throw new Error('Durable admission storage unavailable');
      }
    };
    const fake = fakePiAgent(f, {
      unit: async unit =>
        reviewed(unit, {
          followUps: [{ paths: ['src/file-0.ts'], question: 'Inspect downstream contract.' }],
        }),
    });
    await expect(fake.run()).rejects.toThrow('Durable admission storage unavailable');
    expect(f.store.record!.state.entries.filter(entry => entry.kind === 'unit')).toHaveLength(1);
    expect(f.store.record!.state.entries.every(entry => entry.data === null)).toBe(true);
    expect(f.store.record!.state.phase).toBe('collecting');
    expect(fake.workers()).toHaveLength(1);
    expect(fake.syntheses()).toHaveLength(0);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.prepared.coverageGate).toBeUndefined();
  });

  it.each([64, 125])(
    'executes %i manifest items in bounded native leaves, not model paraphrase chains',
    async count => {
      const f = await manifestFixture(count);
      const fake = fakePiAgent(f, {
        unit: async unit =>
          reviewed(unit, {
            followUps: unit.paths.includes('src/file-0.ts') ? [f.request] : [],
          }),
      });
      const result = await fake.run();
      expect(fake.validationErrors).toEqual([]);
      expect(result.review?.coverage).toBe('complete');
      const initial = Math.ceil(count / 8);
      expect(fake.workers()).toHaveLength(initial);
      expect(fake.workers().every(call => call.unit!.kind === 'diff')).toBe(true);
      expect(fake.syntheses()).toHaveLength(1);
      const state = f.store.record!.state;
      const { leaves, roots } = nativeEvidence(state);
      expect(leaves).toHaveLength(Math.ceil(count / 8));
      expect(roots).toHaveLength(1);
      expect(state.entries.filter(entry => entry.kind === 'unit')).toHaveLength(
        initial + leaves.length + 1
      );
      expect(state.entries.length - 1).toBeLessThanOrEqual(96);
      expect(state.phase).toBe('ready');
      const receipts = leaves.flatMap(leaf => leaf.receipts);
      expect(receipts).toHaveLength(count);
      expect(new Set(receipts.map(receipt => receipt.path))).toEqual(
        new Set(Object.keys(f.sources))
      );
      for (const receipt of receipts) {
        const path = receipt.path as string;
        expect(receipt).toEqual({
          role: 'H',
          sha: f.snapshot.headSha,
          path,
          algorithm: 'sha256',
          normalization: 'sha256-utf8-lf-v1',
          digest: f.sources[path],
          expectedDigest: f.sources[path],
          match: true,
          bytes: Buffer.byteLength(await readFile(join(f.snapshot.headPath, path))),
        });
      }
      expect(roots[0]!.partitions).toEqual(
        leaves.map(leaf => ({
          id: leaf.entryId,
          evidenceHash: reviewHash(leaf.result),
        }))
      );
      expect(f.prepared.coverageComplete?.()).toBe(true);
      await commitReview(f.provider, f.prepared, result);
      expect(f.publish).toHaveBeenCalledOnce();
    }
  );

  it('retains exact native receipts across a failed synthesis invocation and reuses them on retry', async () => {
    const f = await manifestFixture(64);
    const first = fakePiAgent(f, {
      synthesis: async attempt => {
        if (attempt === 1) {
          return [f.request];
        }
        throw new Error('Synthesis provider unavailable');
      },
    });
    const incomplete = await first.run();
    await expectUnpublished(f, incomplete);
    const native = nativeEvidence(f.store.record!.state);
    expect(native.leaves).toHaveLength(8);
    expect(native.leaves.flatMap(leaf => leaf.receipts)).toHaveLength(64);
    const receipts = structuredClone(native);
    const attempts = new Map(
      f.store.record!.state.entries.map(entry => [entry.id, entry.attempts])
    );
    const retry = fakePiAgent(f);
    const result = await retry.run();
    expect(retry.workers()).toHaveLength(0);
    expect(retry.syntheses()).toHaveLength(1);
    expect(nativeEvidence(f.store.record!.state)).toEqual(receipts);
    for (const leaf of receipts.leaves) {
      expect(f.store.record!.state.entries.find(entry => entry.id === leaf.entryId)!.attempts).toBe(
        attempts.get(leaf.entryId)
      );
    }
    expect(result.review?.coverage).toBe('complete');
  });

  it.each(['missing', 'mismatch'])(
    'does not count a %s digest source or its root as complete',
    async failure => {
      const f = await manifestFixture(9);
      const path = join(f.snapshot.headPath, 'src/file-0.ts');
      if (failure === 'missing') {
        await rm(path);
      } else {
        await writeFile(path, 'export const changedOutsideManifest = true;\n');
      }
      const fake = fakePiAgent(f, {
        synthesis: async attempt => {
          expect(attempt).toBe(1);
          return [f.request];
        },
      });
      const result = await fake.run();
      expect(fake.syntheses()).toHaveLength(1);
      expect(fake.workers()).toHaveLength(2);
      expect(result.review?.coverage).toBe('incomplete');
      expect(f.prepared.coverageComplete?.()).toBe(false);
      const state = f.store.record!.state;
      expect(
        state.entries.some(
          entry =>
            entry.status === 'blocked' &&
            entry.data?.kind === 'unit' &&
            entry.data.result.limitations.some(note => /digest|unavailable/i.test(note))
        )
      ).toBe(true);
      expect(state.entries.some(entry => entry.status === 'pending')).toBe(true);
      expect(nativeEvidence(state).roots).toHaveLength(0);
      await expectUnpublished(f, result);
    }
  );

  it('deduplicates rephrased mechanical recipes without collapsing distinct semantic manifest checks', async () => {
    const f = await manifestFixture(9);
    const semantic = [
      { paths: ['manifest.json'], question: 'Inspect manifest consumer authorization.' },
      { paths: ['manifest.json'], question: 'Inspect manifest update transaction atomicity.' },
    ];
    const fake = fakePiAgent(f, {
      synthesis: async attempt =>
        attempt === 1
          ? [
              f.request,
              { ...f.request, question: 'Recompute the same source checksums mechanically.' },
              ...semantic,
            ]
          : complete(),
    });
    const result = await fake.run();
    expect(result.review?.coverage).toBe('complete');
    const native = nativeEvidence(f.store.record!.state);
    expect(native.roots).toHaveLength(1);
    expect(native.leaves).toHaveLength(2);
    expect(
      fake
        .workers()
        .filter(call => call.unit!.kind === 'followup')
        .map(call => call.unit!.question)
        .sort()
    ).toEqual(semantic.map(request => request.question).sort());
    expect(fake.workers()).toHaveLength(4);
    const synthesis = f.store.record!.state.entries.find(entry => entry.kind === 'synthesis')!.data;
    expect(synthesis?.kind === 'synthesis' && synthesis.result.followUps).toHaveLength(3);
  });

  it('reviews more than three units in one call, in bounded waves, before final synthesis/publication', async () => {
    const f = await fixture(8);
    const release = deferred();
    const firstWave = deferred();
    let active = 0;
    let peak = 0;
    const completed = new Set<string>();
    const fake = fakePiAgent(f, {
      unit: async (unit, _attempt, prompt) => {
        active++;
        peak = Math.max(peak, active);
        if (active === 3) {
          firstWave.resolve();
        }
        await release.promise;
        for (const span of unit.spans) {
          expect(prompt).toContain(`+export const value${span.path.match(/file-(\d+)/)![1]} = 1;`);
        }
        active--;
        completed.add(unit.id);
        return reviewed(unit);
      },
      synthesis: async (_attempt, prompt) => {
        expect(completed.size).toBe(8);
        expect(active).toBe(0);
        expect(f.prepared.coverageComplete?.()).toBe(true);
        const evidence = JSON.parse(
          await readFile(join(f.root, 'coverage-evidence.json'), 'utf8')
        ) as { units: { id: string; result: { kind: string; result: ReviewUnitResult } }[] };
        expect(prompt).toContain(join(f.root, 'coverage-evidence.json'));
        expect(evidence.units).toHaveLength(8);
        expect(evidence.units.every(item => item.result.result.status === 'reviewed')).toBe(true);
        expect(new Set(evidence.units.map(item => item.id))).toEqual(completed);
        return complete();
      },
    });
    const pending = fake.run();
    await firstWave.promise;
    expect(fake.workers()).toHaveLength(3);
    expect(fake.syntheses()).toHaveLength(0);
    expect(f.publish).not.toHaveBeenCalled();
    release.resolve();
    const result = await pending;
    expect(result.review).toEqual(complete());
    expect(fake.validationErrors).toEqual([]);
    expect(peak).toBe(3);
    expect(fake.workers()).toHaveLength(8);
    expect(fake.syntheses()).toHaveLength(1);
    expect(f.store.record?.state.phase).toBe('ready');
    expectUsage(result, 9);
    expect(f.publish).not.toHaveBeenCalled();
    const loads = f.store.loads;
    const committed = await commitReview(f.provider, f.prepared, result);
    expect(f.store.loads).toBe(loads + 1);
    expect(committed.state.completedReviews).toBe(1);
    expect(f.publish).toHaveBeenCalledOnce();
    for (const call of fake.calls) {
      expect(call.config.enableReviewSubagents).toBe(false);
      expect(call.config.cwd).toBe(f.prepared.snapshot.headPath);
      expect(call.config.loadedTools).not.toContain('subagent');
      expect(call.config.reviewReadContext?.snapshot).toEqual(f.snapshot);
      expect(call.config.model).toBe(call.unit ? 'unit-reviewer' : 'root-reviewer');
    }
  });

  it.each(['failed', 'partial', 'blocked'] as const)(
    'keeps %s work and its durable attempts out of the canonical ledger',
    async status => {
      const f = await fixture();
      f.seedPrevious();
      const before = f.canonical();
      const fake = fakePiAgent(f, {
        unit: async unit =>
          reviewed(unit, {
            status,
            limitations: ['Required fixture evidence remains uninspected.'],
          }),
      });
      const result = await fake.run();
      const limit = status === 'blocked' ? 1 : 2;
      expect(fake.workers()).toHaveLength(limit);
      expect(fake.syntheses()).toHaveLength(0);
      const item = f.store.record!.state.entries.find(entry => entry.kind === 'unit')!;
      expect(item.status).toBe(status);
      expect(item.attempts).toBe(limit);
      expect(
        f.store.journal.filter(record =>
          record.state.entries.some(entry => entry.status === 'running')
        )
      ).toHaveLength(limit);
      expectUsage(result, limit);
      await expectUnpublished(f, result, before);
    }
  );

  it('limits throwing workers to two attempts per invocation, preserves candidates, and aggregates failed usage', async () => {
    const f = await fixture();
    f.seedPrevious();
    const before = f.canonical();
    const first = fakePiAgent(f, {
      unit: async (unit, attempt) => {
        if (attempt === 2) {
          throw new Error('Provider failed after spending tokens');
        }
        return reviewed(unit, {
          status: 'partial',
          limitations: ['Consumer scope still unread.'],
          findings: [candidate()],
        });
      },
    });
    const result = await first.run();
    expectUsage(result, 2);
    expect(first.workers()).toHaveLength(2);
    expect(result.review?.coverageNotes).toContain('1 uncommitted candidate records');
    const saved = f.store.record!.state.entries.find(entry => entry.kind === 'unit')!;
    expect(saved.attempts).toBe(2);
    expect(saved.data?.kind === 'unit' && saved.data.result.findings).toEqual([candidate()]);
    await expectUnpublished(f, result, before);
    const second = fakePiAgent(f, {
      unit: async () => {
        throw new Error('Still unavailable');
      },
    });
    const retry = await second.run();
    expect(second.workers()).toHaveLength(2);
    expect(f.store.record!.state.entries.find(entry => entry.kind === 'unit')!.attempts).toBe(4);
    expectUsage(retry, 2);
    await expectUnpublished(f, retry, before);
  });

  it('retains partial candidates through a later reviewed attempt for cross-scope synthesis', async () => {
    const f = await fixture();
    const fake = fakePiAgent(f, {
      unit: async (unit, attempt) =>
        reviewed(
          unit,
          attempt === 1
            ? {
                status: 'partial',
                limitations: ['One contract check pending.'],
                findings: [candidate()],
              }
            : {}
        ),
      synthesis: async () => {
        const evidence = await readFile(join(f.root, 'coverage-evidence.json'), 'utf8');
        expect(evidence).toContain(candidate().rootCause);
        return { ...complete(), findings: [candidate()] };
      },
    });
    const result = await fake.run();
    expect(fake.validationErrors).toEqual([]);
    expect(result.review?.findings).toEqual([candidate()]);
    const committed = await commitReview(f.provider, f.prepared, result);
    expect(committed.state.findings[0]?.id).toBe('F1');
    expectUsage(result, 3);
  });

  it('rejects SDK-capture claims that omit assigned spans instead of treating prose as coverage', async () => {
    const f = await fixture();
    const fake = fakePiAgent(f, {
      unit: async unit => reviewed(unit, { coveredSpanIds: [] }),
    });
    const result = await fake.run();
    expect(fake.validationErrors).toHaveLength(2);
    expect(fake.syntheses()).toHaveLength(0);
    await expectUnpublished(f, result);
  });

  it('does not run workers when approved material dependencies are incomplete', async () => {
    const f = await fixture();
    f.prepared.dependencies.complete = false;
    const fake = fakePiAgent(f);
    const result = await fake.run();
    expect(fake.calls).toHaveLength(0);
    expect(result.sessionStats).toBeUndefined();
    await expectUnpublished(f, result);
  });

  it('resumes identical fingerprints without rerunning reviewed units after synthesis failure', async () => {
    const f = await fixture(5);
    const failed = fakePiAgent(f, {
      synthesis: async () => {
        throw new Error('Synthesis failed');
      },
    });
    const first = await failed.run();
    expectUsage(first, 6);
    await expectUnpublished(f, first);
    const fingerprint = f.store.record!.state.fingerprint;
    const recovered = fakePiAgent(f);
    const result = await recovered.run();
    expect(recovered.workers()).toHaveLength(0);
    expect(recovered.syntheses()).toHaveLength(1);
    expect(f.store.record!.state.fingerprint).toBe(fingerprint);
    expect(
      f.store
        .record!.state.entries.filter(entry => entry.kind === 'unit')
        .map(entry => entry.attempts)
    ).toEqual([1, 1, 1, 1, 1]);
    expectUsage(result, 1);
    await commitReview(f.provider, f.prepared, result);
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it('recovers a ready journal after failed publication without reopening any model session', async () => {
    const f = await fixture(4);
    const first = fakePiAgent(f);
    const result = await first.run();
    f.publish.mockRejectedValueOnce(new Error('Publication unavailable'));
    await expect(commitReview(f.provider, f.prepared, result)).rejects.toThrow(
      'Publication unavailable'
    );
    expect(f.canonical()).toBeNull();
    const durable = structuredClone(f.store.record);
    const recovered = fakePiAgent(f);
    const retry = await recovered.run();
    expect(recovered.calls).toHaveLength(0);
    expect(retry.review).toEqual(result.review);
    expect(retry.sessionStats).toBeUndefined();
    expect(f.store.record).toEqual(durable);
    await commitReview(f.provider, f.prepared, retry);
    expect(f.canonical()?.state.completedReviews).toBe(1);
  });

  it.each(['head', 'base', 'intent', 'configuration', 'predecessor'] as const)(
    'invalidates ready work when the %s fingerprint input changes',
    async change => {
      const f = await fixture(2);
      f.seedPrevious();
      await fakePiAgent(f).run();
      const fingerprint = f.store.record!.state.fingerprint;
      if (change === 'head') {
        f.snapshot.headSha = 'f'.repeat(40);
      }
      if (change === 'base') {
        f.snapshot.baseSha = 'f'.repeat(40);
      }
      if (change === 'intent') {
        f.snapshot.intentHash = reviewHash('new declared intent');
      }
      if (change === 'configuration') {
        f.prepared.configurationHash = reviewHash('different reviewer');
      }
      if (change === 'predecessor') {
        f.prepared.previous!.body += '\nNew trusted predecessor';
      }
      await f.inventory();
      const retry = fakePiAgent(f);
      const result = await retry.run();
      expect(result.review?.coverage).toBe('complete');
      expect(retry.validationErrors).toEqual([]);
      expect(retry.workers()).toHaveLength(2);
      expect(retry.syntheses()).toHaveLength(1);
      expect(f.store.record!.state.fingerprint).not.toBe(fingerprint);
      expect(f.store.record!.state.entries.every(entry => entry.attempts === 1)).toBe(true);
    }
  );

  it.each(['missing', 'body', 'comment', 'candidate hash', 'missing scope'] as const)(
    'fresh-load publication gate refuses %s drift',
    async change => {
      const f = await fixture(2);
      const result = await fakePiAgent(f).run();
      const loads = f.store.loads;
      if (change === 'missing') {
        f.store.record = null;
      }
      if (change === 'body') {
        f.store.record!.body += '\nConcurrent edit';
      }
      if (change === 'comment') {
        f.store.record!.commentId++;
      }
      if (change === 'candidate hash') {
        result.review!.coverageNotes += ' Different captured content.';
      }
      if (change === 'missing scope') {
        f.store.record!.state.entries = f.store.record!.state.entries.filter(
          entry => entry.kind === 'synthesis'
        );
      }
      await expect(commitReview(f.provider, f.prepared, result)).rejects.toThrow(
        /coverage|journal|scope/i
      );
      expect(f.store.loads).toBe(loads + 1);
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.canonical()).toBeNull();
    }
  );

  it('refuses a concurrent journal compare/save conflict without admitting synthesis or publishing', async () => {
    const f = await fixture();
    f.store.beforeSave = state => {
      if (state.entries.some(entry => entry.kind === 'unit' && entry.status === 'reviewed')) {
        f.store.record!.body += '\nOther writer';
      }
    };
    const fake = fakePiAgent(f);
    const error = await fake.run().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ReviewCoverageRunError);
    expect((error as Error).message).toContain('compare/save conflict');
    expectUsage({ sessionStats: (error as ReviewCoverageRunError).sessionStats }, 1);
    expect(fake.syntheses()).toHaveLength(0);
    expect(f.prepared.coverageGate).toBeUndefined();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.canonical()).toBeNull();
  });

  it('requires discovered follow-ups and resumes their stable deduplicated scope', async () => {
    const f = await fixture();
    await writeFile(join(f.snapshot.headPath, 'consumer.ts'), 'export const consumer = 1;\n');
    const request = {
      paths: ['consumer.ts', 'src/file-0.ts'],
      question: 'Inspect consumer contract',
    };
    const equivalent = {
      paths: [...request.paths].reverse(),
      question: ' Inspect consumer contract ',
    };
    const first = fakePiAgent(f, {
      unit: async unit =>
        unit.kind === 'diff'
          ? reviewed(unit, { followUps: [request, equivalent] })
          : reviewed(unit, { status: 'partial', limitations: ['Consumer check pending.'] }),
    });
    const incomplete = await first.run();
    expect(first.workers()).toHaveLength(3);
    expect(first.syntheses()).toHaveLength(0);
    await expectUnpublished(f, incomplete);
    const followup = f.store.record!.state.entries.find(
      entry => entry.kind === 'unit' && entry.status === 'partial'
    )!;
    expect(followup.attempts).toBe(2);
    expect(f.store.record!.state.entries.filter(entry => entry.kind === 'unit')).toHaveLength(2);
    const recovered = fakePiAgent(f);
    const result = await recovered.run();
    expect(recovered.validationErrors).toEqual([]);
    expect(recovered.workers().map(call => call.unit!.id)).toEqual([followup.id]);
    expect(f.store.record!.state.entries.find(entry => entry.id === followup.id)!.attempts).toBe(3);
    expect(result.review?.coverage).toBe('complete');
    await commitReview(f.provider, f.prepared, result);
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it.each([96, 2])(
    'runs synthesis-discovered work and stops duplicates with no progress at maxUnits=%i',
    async maxUnits => {
      const f = await fixture(1, { maxUnits });
      const request = { paths: ['src/file-0.ts'], question: 'Inspect cross-scope invariants' };
      const order: string[] = [];
      const fake = fakePiAgent(f, {
        unit: async unit => {
          order.push(unit.kind);
          return reviewed(unit);
        },
        synthesis: async () => {
          order.push('synthesis');
          return [request];
        },
      });
      const result = await fake.run();
      expect(order).toEqual(['diff', 'synthesis', 'followup', 'synthesis']);
      expect(result.review?.coverageNotes).toMatch(/no progress/i);
      expect(fake.validationErrors).toEqual([]);
      expectUsage(result, 4);
      await expectUnpublished(f, result);
    }
  );

  it('finishes synthesis only after newly requested required scope is reviewed', async () => {
    const f = await fixture();
    const fake = fakePiAgent(f, {
      synthesis: async attempt =>
        attempt === 1
          ? [{ paths: ['src/file-0.ts'], question: 'Inspect cross-scope invariants' }]
          : complete(),
    });
    const result = await fake.run();
    expect(fake.validationErrors).toEqual([]);
    expect(fake.workers().map(call => call.unit!.kind)).toEqual(['diff', 'followup']);
    expect(fake.syntheses()).toHaveLength(2);
    expect(result.review?.coverage).toBe('complete');
    const synthesis = f.store.record!.state.entries.find(entry => entry.kind === 'synthesis')!;
    expect(synthesis.data?.kind === 'synthesis' && synthesis.data.result.followUps).toEqual([
      { paths: ['src/file-0.ts'], question: 'Inspect cross-scope invariants' },
    ]);
    const recovered = fakePiAgent(f);
    const retry = await recovered.run();
    expect(recovered.calls).toHaveLength(0);
    expect(retry.review).toEqual(result.review);
    await commitReview(f.provider, f.prepared, retry);
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it('never readies an honest incomplete finalizer or allocates its candidate IDs', async () => {
    const f = await fixture();
    f.seedPrevious();
    const before = f.canonical();
    const fake = fakePiAgent(f, {
      synthesis: async () => ({
        coverage: 'incomplete',
        coverageNotes: 'Material external contract unavailable.',
        findings: [candidate()],
      }),
    });
    const result = await fake.run();
    expect(fake.validationErrors).toEqual([]);
    expect(f.store.record!.state.entries.find(entry => entry.kind === 'synthesis')!.status).toBe(
      'blocked'
    );
    expect(f.store.record!.state.reviewHash).toBeNull();
    await expectUnpublished(f, result, before);
  });

  it('supplies and preserves synthesis-only candidates across retries and follow-up requests', async () => {
    const f = await fixture();
    const original = candidate();
    const first = fakePiAgent(f, {
      synthesis: async () => ({
        coverage: 'incomplete',
        coverageNotes: 'Consumer scope remains.',
        findings: [original],
      }),
    });
    await first.run();
    const later = fakePiAgent(f, {
      synthesis: async attempt => {
        const evidence = JSON.parse(
          await readFile(join(f.root, 'coverage-evidence.json'), 'utf8')
        ) as { previousSynthesis: { review: ReviewSubmission } };
        expect(evidence.previousSynthesis.review.findings).toEqual([original]);
        return attempt === 1
          ? [{ paths: ['src/file-0.ts'], question: 'Check integration.' }]
          : { coverage: 'incomplete', coverageNotes: 'Still unresolved.', findings: [] };
      },
    });
    const result = await later.run();
    expect(result.review?.coverage).toBe('incomplete');
    expect(later.workers()).toHaveLength(1);
    const saved = f.store.record!.state.entries.find(item => item.kind === 'synthesis')!.data;
    expect(saved?.kind === 'synthesis' && saved.result.review?.findings).toEqual([original]);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('keeps long escaped synthesis evidence readable without single-line tool truncation', async () => {
    const f = await fixture();
    const original = { ...candidate(), evidence: '\\'.repeat(27_000) };
    await fakePiAgent(f, {
      synthesis: async () => ({
        coverage: 'incomplete',
        coverageNotes: 'Needs integration.',
        findings: [original],
      }),
    }).run();
    const resumed = fakePiAgent(f, {
      synthesis: async (_attempt, prompt) => {
        const text = await readFile(join(f.root, 'coverage-evidence.json'), 'utf8');
        const evidence = JSON.parse(text) as {
          previousSynthesis: { review: { findings: { evidence: { stringChunks: string[] } }[] } };
        };
        expect(evidence.previousSynthesis.review.findings[0]!.evidence.stringChunks.join('')).toBe(
          original.evidence
        );
        expect(text.split('\n').every(line => Buffer.byteLength(line) < 50 * 1024)).toBe(true);
        expect(prompt).toContain('explicitly refuted');
        return {
          ...complete(),
          coverageNotes:
            'Refuted prior proposal: pinned src/file-0.ts only exports a constant, not the claimed query.',
        };
      },
    });
    const result = await resumed.run();
    expect(resumed.workers()).toHaveLength(0);
    expect(result.review?.coverage).toBe('complete');
    await commitReview(f.provider, f.prepared, result);
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it('rejects unpublishable complete output before persisting a ready journal', async () => {
    const f = await fixture();
    const fake = fakePiAgent(f, {
      synthesis: async () => ({ ...complete(), coverageNotes: 'x'.repeat(30_000) }),
    });
    const result = await fake.run();
    expect(result.review?.coverage).toBe('incomplete');
    expect(String(fake.validationErrors[0])).toContain('comment budget');
    expect(f.store.record!.state.phase).toBe('collecting');
    expect(f.store.record!.state.entries.find(item => item.kind === 'synthesis')!.data).toBeNull();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('rejects synthesis output that cannot fit durable storage before capture', async () => {
    const f = await fixture();
    const oversized = { ...candidate(), evidence: '\\'.repeat(40_000) };
    const fake = fakePiAgent(f, {
      synthesis: async () => ({
        coverage: 'incomplete',
        coverageNotes: 'Still checking.',
        findings: [oversized],
      }),
    });
    const result = await fake.run();
    expect(result.review?.coverage).toBe('incomplete');
    expect(fake.validationErrors).toHaveLength(1);
    expect(String(fake.validationErrors[0])).toContain('durable capacity');
    expect(f.store.record!.state.entries.find(item => item.kind === 'synthesis')!.data).toBeNull();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('does not silently replace invalid UTF-8 patch bytes with reviewed text', async () => {
    const f = await fixture();
    const inventory = JSON.parse(
      await readFile(f.prepared.snapshot.coverageInventoryPath!, 'utf8')
    ) as ReviewCoverageInventory;
    const patch = await readFile(inventory.full[0]!.patchPath);
    patch[patch.indexOf('+export') + 2] = 255;
    await writeFile(inventory.full[0]!.patchPath, patch);
    const fake = fakePiAgent(f);
    const result = await fake.run();
    expect(result.review?.coverage).toBe('incomplete');
    expect(fake.calls).toHaveLength(0);
    expect(f.store.record!.state.entries.find(item => item.kind === 'unit')!.attempts).toBe(2);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('rejects a dependency cycle before capture without poisoning the write queue', async () => {
    const f = await fixture();
    const first = { paths: ['src/file-0.ts'], question: 'Check first contract.' };
    const second = { paths: ['src/file-0.ts'], question: 'Check second contract.' };
    const fake = fakePiAgent(f, {
      unit: async unit =>
        unit.kind === 'diff'
          ? reviewed(unit, { followUps: [first] })
          : reviewed(unit, {
              status: 'partial',
              limitations: ['Dependent contract remains.'],
              followUps: [unit.question === first.question ? second : first],
            }),
    });
    const result = await fake.run();
    expect(result.review?.coverage).toBe('incomplete');
    expect(fake.validationErrors).toHaveLength(2);
    expect(fake.validationErrors.every(error => String(error).includes('dependency cycle'))).toBe(
      true
    );
    expect(f.store.record!.state.entries.filter(item => item.kind === 'unit')).toHaveLength(3);
    expect(f.store.record!.state.entries.some(item => item.status === 'running')).toBe(false);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('runs requested checks before retrying their partial producer and supplies the completed evidence', async () => {
    const f = await fixture();
    const order: string[] = [];
    let checked = false;
    const fake = fakePiAgent(f, {
      unit: async (unit, attempt) => {
        if (unit.kind === 'followup') {
          order.push('check');
          checked = true;
          return reviewed(unit, { assessment: 'Consumer contract verified in pinned source.' });
        }
        order.push(`primary-${attempt}`);
        if (attempt === 1) {
          return reviewed(unit, {
            status: 'partial',
            limitations: ['Consumer check remains.'],
            followUps: [{ paths: ['src/file-0.ts'], question: 'Check consumer contract.' }],
          });
        }
        expect(checked).toBe(true);
        const related = JSON.parse(
          await readFile(join(f.root, `coverage-related-${unit.id}.json`), 'utf8')
        ) as { scopes: { status: string; result: ReviewUnitResult }[] };
        expect(
          related.scopes.some(
            item =>
              item.status === 'reviewed' &&
              item.result.assessment.includes('Consumer contract verified')
          )
        ).toBe(true);
        return reviewed(unit);
      },
    });
    const result = await fake.run();
    expect(order).toEqual(['primary-1', 'check', 'primary-2']);
    expect(result.review?.coverage).toBe('complete');
    expect(fake.syntheses()).toHaveLength(1);
  });

  it('does not admit whole-file integration before its required primary ranges are reviewed', async () => {
    const f = await fixture(1, { maxUnitLines: 1 });
    let first = true;
    const fake = fakePiAgent(f, {
      unit: async unit => {
        expect(unit.kind).toBe('diff');
        if (first) {
          first = false;
          return reviewed(unit, {
            status: 'blocked',
            limitations: ['Required primary evidence unavailable.'],
          });
        }
        return reviewed(unit);
      },
    });
    const result = await fake.run();
    expect(result.review?.coverage).toBe('incomplete');
    expect(fake.workers()).toHaveLength(3);
    expect(fake.workers().some(item => item.unit!.kind === 'followup')).toBe(false);
    expect(
      f.store.record!.state.entries.filter(
        item => item.kind === 'unit' && item.status === 'pending'
      )
    ).toHaveLength(1);
    expect(fake.syntheses()).toHaveLength(0);
  });

  it('validates synthesis capture against canonical IDs rather than accepting unknown root claims', async () => {
    const f = await fixture();
    const fake = fakePiAgent(f, {
      synthesis: async () => ({ ...complete(), findings: [{ ...candidate(), id: 'F999' }] }),
    });
    const result = await fake.run();
    expect(fake.validationErrors).toHaveLength(1);
    expect(String(fake.validationErrors[0])).toContain('Unknown or duplicate finding ID');
    expectUsage(result, 2);
    await expectUnpublished(f, result);
  });

  it('preserves an exact 6 KiB partial result when its retry throws, without overflowing synthetic failure evidence', async () => {
    const f = await fixture();
    f.seedPrevious();
    const before = f.canonical();
    let captured: ReviewUnitResult | undefined;
    const fake = fakePiAgent(f, {
      unit: async (unit, attempt) => {
        if (attempt === 2) {
          throw new Error('Provider failed after the maximum-sized partial capture');
        }
        const result = reviewed(unit, {
          status: 'partial',
          assessment: 'Partial evidence retained.',
          limitations: ['Consumer unread.'],
          findings: [candidate()],
        });
        result.findings[0]!.evidence += 'x'.repeat(
          6 * 1024 - Buffer.byteLength(JSON.stringify(result))
        );
        captured = structuredClone(result);
        return result;
      },
    });
    const result = await fake.run();
    expect(captured).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(captured))).toBe(6 * 1024);
    expect(fake.validationErrors).toEqual([]);
    expect(fake.workers()).toHaveLength(2);
    expect(fake.syntheses()).toHaveLength(0);
    const saved = f.store.record!.state.entries.find(entry => entry.kind === 'unit')!;
    expect(saved.status).toBe('failed');
    expect(saved.attempts).toBe(2);
    expect(saved.data).toEqual({ kind: 'unit', result: captured });
    expect(JSON.stringify(saved.data!.result)).toBe(JSON.stringify(captured));
    expectUsage(result, 2);
    await expectUnpublished(f, result, before);
  });

  it.each(['missing', 'pending'] as const)(
    'rejects ready synthesis history when a required follow-up entry is %s',
    async change => {
      const f = await fixture();
      const fake = fakePiAgent(f, {
        synthesis: async attempt =>
          attempt === 1
            ? [{ paths: ['src/file-0.ts'], question: 'Inspect cross-scope invariants' }]
            : complete(),
      });
      const result = await fake.run();
      expect(fake.validationErrors).toEqual([]);
      const followupId = fake.workers().find(call => call.unit!.kind === 'followup')!.unit!.id;
      const state = f.store.record!.state;
      const synthesis = state.entries.find(entry => entry.kind === 'synthesis')!;
      expect(synthesis.data?.kind === 'synthesis' && synthesis.data.result.followUps).toHaveLength(
        1
      );
      if (change === 'missing') {
        state.entries = state.entries.filter(entry => entry.id !== followupId);
      } else {
        state.entries.find(entry => entry.id === followupId)!.status = 'pending';
      }
      await expect(commitReview(f.provider, f.prepared, result)).rejects.toThrow(/coverage|scope/i);
      const resumed = fakePiAgent(f);
      await expect(resumed.run()).rejects.toThrow(/coverage|scope/i);
      expect(resumed.calls).toHaveLength(0);
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.canonical()).toBeNull();
    }
  );

  it('bounds a never-settling initial journal load and aborts its forwarded signal', async () => {
    const f = await fixture(1, { runTimeoutMs: 150, synthesisReserveMs: 1 });
    f.seedPrevious();
    const before = f.canonical();
    f.store.beforeLoad = async () => new Promise<void>(() => undefined);
    const fake = fakePiAgent(f);
    const started = performance.now();
    const error = await fake.run().catch((error: unknown) => error);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(error).toBeInstanceOf(ReviewCoverageRunError);
    expect((error as Error).message).toMatch(/host.*time budget|deadline/i);
    expect(f.store.loadSignals).toHaveLength(1);
    expect(f.store.loadSignals[0]).toBeInstanceOf(AbortSignal);
    expect(f.store.loadSignals[0]!.aborted).toBe(true);
    expect(f.store.saveSignals).toHaveLength(0);
    expect(f.store.journal).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.canonical()).toEqual(before);
  });

  it('bounds a stalled completion save and aborts, disposes, and drains every other active worker', async () => {
    const f = await fixture(4, { runTimeoutMs: 200, synthesisReserveMs: 1 });
    f.seedPrevious();
    const before = f.canonical();
    const allStarted = deferred();
    const running = new Map<string, ReturnType<typeof deferred<ReviewUnitResult>>>();
    const events: string[] = [];
    let startedWorkers = 0;
    let completedId: string | undefined;
    let stalledSignal: AbortSignal | undefined;
    f.store.beforeSave = async (state, signal) => {
      if (
        state.entries.some(entry => entry.kind === 'unit' && entry.status === 'reviewed') &&
        state.entries.filter(entry => entry.kind === 'unit' && entry.status === 'running')
          .length === 2
      ) {
        stalledSignal = signal;
        events.push('save:stalled');
        return new Promise<void>(() => undefined);
      }
    };
    const fake = fakePiAgent(f, {
      unit: async unit => {
        completedId ??= unit.id;
        startedWorkers++;
        if (startedWorkers === 3) {
          allStarted.resolve();
        }
        if (unit.id === completedId) {
          await allStarted.promise;
          return reviewed(unit);
        }
        const pending = deferred<ReviewUnitResult>();
        running.set(unit.id, pending);
        try {
          return await pending.promise;
        } finally {
          events.push(`drained:${unit.id}`);
        }
      },
      abort: async unit => {
        events.push(`aborted:${unit!.id}`);
      },
      dispose: async unit => {
        events.push(`disposed:${unit!.id}`);
        running.get(unit!.id)?.reject(new Error('Cancelled worker session drained'));
      },
    });
    const started = performance.now();
    const error = await fake.run().catch((error: unknown) => error);
    events.push('host:returned');
    expect(performance.now() - started).toBeLessThan(1000);
    expect(error).toBeInstanceOf(ReviewCoverageRunError);
    expect((error as Error).message).toMatch(/host.*time budget|deadline/i);
    expect(stalledSignal).toBeInstanceOf(AbortSignal);
    expect(stalledSignal!.aborted).toBe(true);
    expect(fake.workers()).toHaveLength(3);
    expect(fake.syntheses()).toHaveLength(0);
    expect(events).toContain('save:stalled');
    expect(running.size).toBe(2);
    for (const id of running.keys()) {
      expect(events).toContain(`aborted:${id}`);
      expect(events).toContain(`disposed:${id}`);
      expect(events).toContain(`drained:${id}`);
      expect(events.indexOf(`drained:${id}`)).toBeLessThan(events.indexOf('host:returned'));
    }
    expect(f.store.journal.every(record => record.state.phase === 'collecting')).toBe(true);
    expect(f.store.record!.state.entries.filter(entry => entry.status === 'running')).toHaveLength(
      3
    );
    expectUsage({ sessionStats: (error as ReviewCoverageRunError).sessionStats }, 3);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.canonical()).toEqual(before);
  });

  it('bounds a stalled fresh publication-gate reload without publishing or reopening sessions', async () => {
    const f = await fixture(2, { runTimeoutMs: 200, synthesisReserveMs: 1 });
    const disposed: string[] = [];
    const fake = fakePiAgent(f, {
      dispose: async unit => {
        disposed.push(unit?.id ?? 'synthesis');
      },
    });
    const result = await fake.run();
    expect(result.review?.coverage).toBe('complete');
    expect(disposed).toHaveLength(3);
    const ready = structuredClone(f.store.record);
    f.store.beforeLoad = async () => new Promise<void>(() => undefined);
    const started = performance.now();
    await expect(commitReview(f.provider, f.prepared, result)).rejects.toThrow(
      /host.*time budget|deadline/i
    );
    expect(performance.now() - started).toBeLessThan(1000);
    const signal = f.store.loadSignals.at(-1);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(true);
    expect(fake.calls).toHaveLength(3);
    expect(disposed).toHaveLength(3);
    expect(f.store.record).toEqual(ready);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.canonical()).toBeNull();
  });

  it('rejects an already-expired invocation before accessing metadata or creating model/journal work', async () => {
    const f = await fixture(1, { runTimeoutMs: 100, synthesisReserveMs: 1 });
    await rm(f.snapshot.coverageInventoryPath!);
    const fake = fakePiAgent(f);
    const started = performance.now();
    await expect(f.run(fake.factory, Date.now() - 101)).rejects.toThrow(/deadline/i);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(f.store.loads).toBe(0);
    expect(f.store.saveSignals).toHaveLength(0);
    expect(f.store.journal).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.canonical()).toBeNull();
  });

  it('refuses replacement workers when cancellation itself fails', async () => {
    const f = await fixture(4, { unitTimeoutMs: 5, runTimeoutMs: 200, synthesisReserveMs: 1 });
    const fake = fakePiAgent(f, {
      unit: async () => new Promise<ReviewUnitResult>(() => {}),
      abort: async () => {
        throw new Error('Cancellation failed');
      },
    });
    await expect(fake.run()).rejects.toThrow('cleanup failed');
    expect(fake.workers()).toHaveLength(3);
    expect(fake.syntheses()).toHaveLength(0);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.store.record!.state.phase).toBe('collecting');
  });

  it('aborts and drains a timed-out worker disposal before admitting its retry', async () => {
    const f = await fixture(2, {
      concurrency: 1,
      unitTimeoutMs: 20,
      runTimeoutMs: 2000,
      synthesisReserveMs: 100,
    });
    const aborted = deferred();
    const allowDrain = deferred();
    const running = deferred<ReviewUnitResult>();
    const events: string[] = [];
    let timedOutId: string | undefined;
    let firstDispose = true;
    const fake = fakePiAgent(f, {
      unit: async (unit, attempt) => {
        timedOutId ??= unit.id;
        events.push(`start:${unit.id}:${attempt}`);
        if (unit.id === timedOutId && attempt === 1) {
          return running.promise;
        }
        return reviewed(unit);
      },
      abort: async () => {
        events.push('abort');
        aborted.resolve();
      },
      dispose: async (unit, attempt) => {
        if (unit?.id === timedOutId && attempt === 1 && firstDispose) {
          firstDispose = false;
          events.push('dispose:start');
          await allowDrain.promise;
          running.reject(new Error('Cancelled SDK session drained'));
          events.push('dispose:drained');
        }
      },
    });
    const pending = fake.run();
    await aborted.promise;
    expect(fake.workers()).toHaveLength(1);
    expect(fake.syntheses()).toHaveLength(0);
    allowDrain.resolve();
    const result = await pending;
    expect(events.indexOf(`start:${timedOutId}:2`)).toBeGreaterThan(
      events.indexOf('dispose:drained')
    );
    expect(fake.workers()).toHaveLength(3);
    expect(fake.syntheses()).toHaveLength(1);
    expect(fake.validationErrors).toEqual([]);
    expect(result.review?.coverage).toBe('complete');
    expectUsage(result, 4);
    expect(f.store.record!.state.entries.find(entry => entry.id === timedOutId)!.attempts).toBe(2);
  });
});
