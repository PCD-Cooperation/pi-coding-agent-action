import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Check } from 'typebox/value';
import type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionToolContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  createReviewSynthesisCapture,
  createReviewUnitCapture,
  parseReviewFollowUps,
  parseReviewUnitResult,
} from '../src/review/work-submission';
import type { ReviewUnitResult, ReviewWorkUnit } from '../src/review/work-types';

const unit: ReviewWorkUnit = {
  id: 'unit-1',
  kind: 'reconcile',
  basis: 'full',
  question: 'Verify query scope',
  paths: ['src/query.ts'],
  findingIds: ['finding-1'],
  spans: [
    {
      id: 'span-1',
      fileId: 'file-1',
      path: 'src/query.ts',
      previousPath: null,
      status: 'modified',
      binary: false,
      oldBlob: 'base',
      newBlob: 'head',
      patchPath: '/patch',
      patchStartLine: 1,
      patchEndLine: 10,
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
    },
  ],
};
const result = (): ReviewUnitResult => ({
  unitId: unit.id,
  status: 'reviewed',
  coveredSpanIds: ['span-1'],
  reconciledFindingIds: ['finding-1'],
  assessment: 'The tenant predicate now covers the query.',
  limitations: [],
  followUps: [],
  findings: [
    {
      id: 'finding-1',
      rootCause: 'Missing tenant predicate',
      origin: 'pr_introduced',
      lifecycle: 'fixed',
      material: true,
      location: 'src/query.ts:2',
      evidence: 'HEAD filters tenant IDs.',
      originEvidence: 'BASE selected all tenants.',
      dispositionReason: 'HEAD restores filtering.',
    },
  ],
});
const followUps = () => [{ paths: ['src/query.ts'], question: 'Check caller isolation.' }];
const full = () => ({ coverage: 'complete', coverageNotes: '', findings: [] });

async function harness(factory: ExtensionFactory) {
  const tools = new Map<string, ToolDefinition>();
  const guards: ((event: { toolName: string; parentToolCallId?: string }) => unknown)[] = [];
  await factory({
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    },
    on: (name: string, handler: (event: { toolName: string }) => unknown) => {
      if (name === 'tool_call') {
        guards.push(handler);
      }
    },
  } as unknown as ExtensionAPI);
  return {
    tools,
    guard: (toolName: string, parentToolCallId?: string) => {
      for (const guard of guards) {
        const blocked = guard({ toolName, ...(parentToolCallId ? { parentToolCallId } : {}) });
        if (blocked) {
          return blocked;
        }
      }
      return undefined;
    },
    execute: (name: string, value: unknown, signal?: AbortSignal, contextSignal?: AbortSignal) =>
      tools.get(name)!.execute('call', value, signal, undefined, {
        signal: contextSignal,
      } as ExtensionToolContext),
  };
}

describe('review work parsing', () => {
  test('owns accepted results and enforces an assigned literal unit ID', async () => {
    const candidate = result();
    const parsed = parseReviewUnitResult(candidate, unit);
    candidate.findings.length = 0;
    expect(parsed.findings).toHaveLength(1);
    const capture = createReviewUnitCapture(unit);
    const { tools } = await harness(capture.factory);
    const tool = tools.get('submit_review_unit_result')!;
    expect(tool.exposure).toBe('model-only');
    expect(Check(tool.parameters, { ...result(), unitId: 'wrong' })).toBe(false);
  });

  test.each(Object.keys(result()))('rejects missing field %s', key => {
    const value = result() as unknown as Record<string, unknown>;
    delete value[key];
    expect(() => parseReviewUnitResult(value, unit)).toThrow();
  });

  test.each([
    { unitId: 'wrong' },
    { extra: true },
    { assessment: '  ' },
    { status: 'complete' },
    { coveredSpanIds: [] },
    { coveredSpanIds: ['wrong'] },
    { coveredSpanIds: ['span-1', 'extra'] },
    { coveredSpanIds: ['span-1', 'span-1'] },
    { reconciledFindingIds: [] },
    { reconciledFindingIds: ['wrong'] },
    { reconciledFindingIds: ['finding-1', 'finding-1'] },
    { findings: [] },
    { limitations: ['Could not inspect caller.'] },
  ])('rejects invalid complete coverage %j', invalid => {
    expect(() => parseReviewUnitResult({ ...result(), ...invalid }, unit)).toThrow();
  });

  test.each(['partial', 'blocked', 'failed'] as const)(
    'accepts honest %s without pretending coverage',
    status => {
      const candidate = {
        ...result(),
        status,
        coveredSpanIds: [],
        reconciledFindingIds: [],
        findings: [],
        limitations: ['Pinned source is unavailable.'],
      };
      expect(parseReviewUnitResult(candidate, unit)).toEqual(candidate);
      expect(() => parseReviewUnitResult({ ...candidate, limitations: [] }, unit)).toThrow(
        'require limitations'
      );
      expect(() =>
        parseReviewUnitResult({ ...candidate, coveredSpanIds: ['invented'] }, unit)
      ).toThrow('outside');
    }
  );

  test('rejects invented finding IDs, duplicate finding IDs, risk acceptance, and invalid dispositions', () => {
    const candidate = result();
    candidate.findings[0]!.id = 'invented';
    expect(() => parseReviewUnitResult(candidate, unit)).toThrow('outside');
    candidate.findings[0]!.id = 'finding-1';
    candidate.findings.push({ ...candidate.findings[0]! });
    expect(() => parseReviewUnitResult(candidate, unit)).toThrow('unique');
    candidate.findings.pop();
    candidate.findings[0]!.lifecycle = 'risk_accepted';
    expect(() => parseReviewUnitResult(candidate, unit)).toThrow('accept risk');
    candidate.findings[0]!.lifecycle = 'refuted';
    candidate.findings[0]!.dispositionReason = '';
    expect(() => parseReviewUnitResult(candidate, unit)).toThrow('dispositionReason');
  });

  test('accepts null IDs for new findings', () => {
    const candidate = result();
    candidate.findings.push({
      ...candidate.findings[0]!,
      id: null,
      lifecycle: 'open',
      rootCause: 'Another cause',
      dispositionReason: '',
    });
    expect(parseReviewUnitResult(candidate, unit).findings[1]!.id).toBeNull();
  });

  test.each([
    '/absolute',
    '../file',
    'src/../file',
    'src/./file',
    'src\\file',
    'C:/file',
    'src\u0000file',
    'src\nfile',
    '//server/file',
    'src//file',
    '',
  ])('rejects unsafe path %j', path => {
    expect(() => parseReviewFollowUps([{ paths: [path], question: 'Verify contract' }])).toThrow();
    expect(() =>
      parseReviewUnitResult(
        { ...result(), followUps: [{ paths: [path], question: 'Verify contract' }] },
        unit
      )
    ).toThrow();
  });

  test('bounds request shapes, counts, and questions without changing data', () => {
    expect(parseReviewFollowUps(followUps())).toEqual(followUps());
    expect(parseReviewFollowUps([])).toEqual([]);
    for (const invalid of [
      Array(9).fill(followUps()[0]),
      [{ ...followUps()[0], extra: true }],
      [{ paths: Array(9).fill('src/file'), question: 'Verify' }],
      [{ paths: ['file'], question: ' ' }],
      [{ paths: ['file'], question: 'q'.repeat(1001) }],
    ]) {
      expect(() => parseReviewFollowUps(invalid)).toThrow();
    }
    const requests = Array.from({ length: 8 }, () => ({
      paths: ['x'.repeat(1000), 'y'.repeat(1000)],
      question: 'q'.repeat(1000),
    }));
    expect(() => parseReviewFollowUps(requests)).toThrow('16384');
  });
});

describe('worker capture', () => {
  test('invalid and oversized UTF-8 output is retryable before capture; no truncation', async () => {
    const capture = createReviewUnitCapture(unit);
    const { execute } = await harness(capture.factory);
    await expect(
      execute('submit_review_unit_result', { ...result(), coveredSpanIds: [] })
    ).rejects.toThrow();
    await expect(
      execute('submit_review_unit_result', { ...result(), assessment: 'é'.repeat(3100) })
    ).rejects.toThrow('6144');
    expect(capture.getResult()).toBeUndefined();
    await expect(execute('submit_review_unit_result', result())).resolves.toMatchObject({
      terminate: true,
    });
    const received = capture.getResult()!;
    received.findings.length = 0;
    expect(capture.getResult()?.findings).toHaveLength(1);
  });

  test('rejects concurrent duplicates, honors validator and aborts, resets between runs', async () => {
    let invalid = true;
    const capture = createReviewUnitCapture(unit, () => {
      if (invalid) {
        throw new Error('host rejected');
      }
    });
    const { execute } = await harness(capture.factory);
    await expect(execute('submit_review_unit_result', result())).rejects.toThrow('host rejected');
    invalid = false;
    await expect(
      execute('submit_review_unit_result', result(), AbortSignal.abort())
    ).rejects.toThrow();
    await expect(
      execute('submit_review_unit_result', result(), undefined, AbortSignal.abort())
    ).rejects.toThrow();
    const replies = await Promise.allSettled([
      execute('submit_review_unit_result', result()),
      execute('submit_review_unit_result', result()),
    ]);
    expect(replies.map(reply => reply.status)).toEqual(['fulfilled', 'rejected']);
    capture.reset();
    expect(capture.getResult()).toBeUndefined();
    await expect(execute('submit_review_unit_result', result())).resolves.toMatchObject({
      terminate: true,
    });
  });

  test('guards direct and nested mutations/children; ceiling still allows an honest final submission', async () => {
    const capture = createReviewUnitCapture(unit, undefined, 1000);
    const { guard, execute, tools } = await harness(capture.factory);
    expect([...tools.keys()]).toEqual(['submit_review_unit_result']);
    for (const name of [
      'write',
      'edit',
      'bash',
      'subagent',
      'wait_subagents',
      'submit_review_result',
      'request_review_followup',
      'tool_search',
      'create_pr',
    ]) {
      expect(guard(name, 'codemode/1')).toMatchObject({ block: true });
    }
    expect(guard('codemode')).toBeUndefined();
    for (let index = 0; index < 59; index++) {
      expect(guard('read', 'codemode/1')).toBeUndefined();
    }
    expect(guard('read')).toMatchObject({ block: true });
    expect(guard('submit_review_unit_result')).toBeUndefined();
    const partial = {
      ...result(),
      status: 'partial',
      limitations: ['Read-tool budget exhausted.'],
      coveredSpanIds: [],
    };
    await expect(execute('submit_review_unit_result', partial)).resolves.toMatchObject({
      terminate: true,
    });
    capture.reset();
    expect(guard('read')).toBeUndefined();
  });
});

describe('synthesis capture', () => {
  test.each([true, false])(
    'competing parallel endpoints cannot both capture (follow-up first: %s)',
    async firstFollowUp => {
      const capture = createReviewSynthesisCapture();
      const { execute, guard, tools } = await harness(capture.factory);
      expect([...tools.keys()]).toEqual(['submit_review_result', 'request_review_followup']);
      expect(tools.get('request_review_followup')?.exposure).toBe('model-only');
      expect(guard('request_review_followup')).toBeUndefined();
      expect(guard('subagent', 'nested')).toMatchObject({ block: true });
      const calls: [string, unknown][] = [
        ['request_review_followup', { requests: followUps() }],
        ['submit_review_result', full()],
      ];
      if (!firstFollowUp) {
        calls.reverse();
      }
      const replies = await Promise.allSettled(calls.map(([name, value]) => execute(name, value)));
      expect(replies.map(reply => reply.status)).toEqual(['fulfilled', 'rejected']);
      expect(Boolean(capture.getSubmission())).toBe(!firstFollowUp);
      expect(Boolean(capture.getFollowUps())).toBe(firstFollowUp);
      capture.reset();
      await expect(execute('submit_review_result', full())).resolves.toMatchObject({
        terminate: true,
      });
    }
  );

  test('follow-up validation is retryable, strict, signal-aware, and cannot be captured twice', async () => {
    let reject = true;
    const capture = createReviewSynthesisCapture(undefined, () => {
      if (reject) {
        throw new Error('out of scope');
      }
    });
    const { execute } = await harness(capture.factory);
    await expect(execute('request_review_followup', { requests: followUps() })).rejects.toThrow(
      'out of scope'
    );
    reject = false;
    await expect(execute('request_review_followup', { requests: [] })).rejects.toThrow();
    await expect(
      execute('request_review_followup', { requests: followUps(), extra: true })
    ).rejects.toThrow();
    await expect(
      execute('request_review_followup', { requests: followUps() }, undefined, AbortSignal.abort())
    ).rejects.toThrow();
    expect(capture.getFollowUps()).toBeUndefined();
    await expect(
      execute('request_review_followup', { requests: followUps() })
    ).resolves.toMatchObject({ terminate: true });
    await expect(execute('request_review_followup', { requests: followUps() })).rejects.toThrow(
      'already'
    );
    expect(capture.getSubmission()).toBeUndefined();
    const received = capture.getFollowUps()!;
    received[0]!.paths.push('mutated');
    expect(capture.getFollowUps()).toEqual(followUps());
  });
});

test.each(['worker', 'synthesis'])(
  'real SDK %s captures data with a role-only read-only loadout',
  role => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-work-sdk-'));
    try {
      const stdout = execFileSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          join(import.meta.dirname, 'pi/fixtures/work-sdk-entry.ts'),
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            FIXTURE_DIR: directory,
            FIXTURE_ROLE: role,
            PI_CODING_AGENT_DIR: directory,
            PI_OFFLINE: '1',
          },
        }
      );
      const report = JSON.parse(stdout.trim().split('\n').at(-1)!) as {
        result: {
          reviewUnit?: ReviewUnitResult;
          reviewFollowUps?: unknown;
          sessionStats?: { totalTokens: number };
        };
        toolSets: string[][];
        requests: number;
        readSucceeded: boolean;
      };
      expect(report.requests).toBe(2);
      expect(report.readSucceeded).toBe(true);
      expect(report.result.sessionStats?.totalTokens).toBeGreaterThan(0);
      const endpoints =
        role === 'worker'
          ? ['submit_review_unit_result']
          : ['submit_review_result', 'request_review_followup'];
      for (const names of report.toolSets) {
        expect(names.sort()).toEqual(['read', ...endpoints].sort());
      }
      if (role === 'worker') {
        expect(report.result.reviewUnit?.unitId).toBe('unit-1');
      } else {
        expect(report.result.reviewFollowUps).toEqual([
          { paths: ['evidence.txt'], question: 'Verify the external caller contract.' },
        ]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  35_000
);
