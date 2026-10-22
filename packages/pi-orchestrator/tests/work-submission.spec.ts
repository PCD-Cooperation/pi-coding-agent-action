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
  parseReviewUnitReceipt,
  reviewSpanReferences,
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
const receipt = () => {
  const input = result();
  return {
    status: input.status,
    assessment: input.assessment,
    limitations: input.limitations,
    findings: input.findings,
    followUps: input.followUps,
  };
};
const followUps = () => [{ paths: ['src/query.ts'], question: 'Check caller isolation.' }];
const full = () => ({ coverage: 'complete', coverageNotes: '', findings: [] });

async function harness(factory: ExtensionFactory) {
  const tools = new Map<string, ToolDefinition>();
  const guards: ((event: {
    toolName: string;
    input: Record<string, unknown>;
    parentToolCallId?: string;
  }) => unknown)[] = [];
  await factory({
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    },
    on: (
      name: string,
      handler: (event: { toolName: string; input: Record<string, unknown> }) => unknown
    ) => {
      if (name === 'tool_call') {
        guards.push(handler);
      }
    },
  } as unknown as ExtensionAPI);
  return {
    tools,
    guard: (toolName: string, parentToolCallId?: string, input: Record<string, unknown> = {}) => {
      for (const guard of guards) {
        const blocked = guard({
          toolName,
          input,
          ...(parentToolCallId ? { parentToolCallId } : {}),
        });
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

  test('accepts optional digest checks and validates manifest repository paths', () => {
    const digestCheck = {
      manifestPath: 'data/manifest.json',
      pointer: '/files',
      normalization: 'sha256-raw-v1' as const,
      selection: 'changed' as const,
    };
    const requests = [{ ...followUps()[0]!, digestCheck }];
    expect(parseReviewFollowUps(requests)).toEqual(requests);
    expect(parseReviewUnitResult({ ...result(), followUps: requests }, unit).followUps).toEqual(
      requests
    );
    for (const invalid of [
      { manifestPath: ' ' },
      { manifestPath: '../manifest.json' },
      { manifestPath: '/manifest.json' },
      { manifestPath: 'data\\manifest.json' },
      { manifestPath: 'data/./manifest.json' },
      { normalization: 'md5' },
      { selection: 'none' },
      { pointer: 1 },
      { extra: true },
    ]) {
      const followUp = { ...requests[0]!, digestCheck: { ...digestCheck, ...invalid } };
      expect(() => parseReviewFollowUps([followUp])).toThrow();
      expect(() => parseReviewUnitResult({ ...result(), followUps: [followUp] }, unit)).toThrow();
    }
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

describe('async admission', () => {
  test.each(['worker', 'review', 'followup'])(
    '%s awaits validation and protects new runs',
    async role => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const validate = () =>
        new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
      const capture =
        role === 'worker'
          ? createReviewUnitCapture(unit, validate)
          : createReviewSynthesisCapture(validate, validate);
      const { execute } = await harness(capture.factory);
      const endpoint =
        role === 'worker'
          ? 'submit_review_unit_result'
          : role === 'review'
            ? 'submit_review_result'
            : 'request_review_followup';
      const value =
        role === 'worker' ? receipt() : role === 'review' ? full() : { requests: followUps() };
      const competitor =
        role === 'worker'
          ? endpoint
          : role === 'review'
            ? 'request_review_followup'
            : 'submit_review_result';
      const competingValue =
        role === 'worker' ? value : role === 'review' ? { requests: followUps() } : full();
      const first = execute(endpoint, value);
      await expect(execute(competitor, competingValue)).rejects.toThrow('already');
      reject(new Error('async host failure'));
      await expect(first).rejects.toThrow('async host failure');
      const stale = execute(endpoint, value);
      const finishStale = resolve;
      capture.reset();
      const current = execute(endpoint, value);
      finishStale();
      await expect(stale).rejects.toThrow('reset');
      await expect(execute(competitor, competingValue)).rejects.toThrow('already');
      resolve();
      await expect(current).resolves.toMatchObject({ terminate: true });
    }
  );

  test.each(['worker', 'review', 'followup'])(
    '%s rechecks signals and releases admission',
    async role => {
      let resolve!: () => void;
      const validate = () =>
        new Promise<void>(yes => {
          resolve = yes;
        });
      const capture =
        role === 'worker'
          ? createReviewUnitCapture(unit, validate)
          : createReviewSynthesisCapture(validate, validate);
      const { execute } = await harness(capture.factory);
      const endpoint =
        role === 'worker'
          ? 'submit_review_unit_result'
          : role === 'review'
            ? 'submit_review_result'
            : 'request_review_followup';
      const value =
        role === 'worker' ? receipt() : role === 'review' ? full() : { requests: followUps() };
      for (const context of [false, true]) {
        const controller = new AbortController();
        const pending = execute(
          endpoint,
          value,
          context ? undefined : controller.signal,
          context ? controller.signal : undefined
        );
        controller.abort();
        resolve();
        await expect(pending).rejects.toThrow();
      }
      const retry = execute(endpoint, value);
      resolve();
      await expect(retry).resolves.toMatchObject({ terminate: true });
    }
  );

  test('digest paths share the read budget with codemode and nested reads', async () => {
    const capture = createReviewUnitCapture(unit);
    const { guard } = await harness(capture.factory);
    expect(guard('review_file_digests', undefined, { paths: Array(9).fill('file') })).toMatchObject(
      { block: true }
    );
    expect(guard('codemode')).toBeUndefined();
    for (let index = 0; index < 7; index++) {
      expect(
        guard('review_file_digests', 'nested', { paths: Array(8).fill('file') })
      ).toBeUndefined();
    }
    for (let index = 0; index < 3; index++) {
      expect(guard('read', 'nested')).toBeUndefined();
    }
    expect(guard('review_file_digests', undefined, { paths: ['file'] })).toMatchObject({
      block: true,
      reason: expect.stringContaining('exhausted'),
    });
    expect(guard('submit_review_unit_result')).toBeUndefined();
    capture.reset();
    expect(guard('review_file_digests', undefined, { paths: ['file'] })).toBeUndefined();
  });
});

describe('host-owned worker receipts', () => {
  const assigned = (): ReviewWorkUnit => ({
    ...unit,
    id: 'unit-sha256-host-owned',
    findingIds: ['F1', 'F2'],
    spans: Array.from({ length: 12 }, (_, index) => ({
      ...unit.spans[0]!,
      id: `sha256-${index}-${'a'.repeat(64)}`,
    })),
  });
  const reviewed = () => ({
    ...receipt(),
    findings: ['F1', 'F2'].map(id => ({ ...result().findings[0]!, id })),
  });

  test('reviewed acknowledges twelve assigned spans without model host IDs', async () => {
    const scope = assigned();
    const capture = createReviewUnitCapture(scope);
    const { execute, tools } = await harness(capture.factory);
    expect(tools.get('submit_review_unit_result')!.parameters).toMatchObject({ type: 'object' });
    expect(Check(tools.get('submit_review_unit_result')!.parameters, reviewed())).toBe(true);
    expect(reviewSpanReferences(scope)).toEqual(
      scope.spans.map((span, index) => ({ ref: `S${index + 1}`, spanId: span.id }))
    );
    await execute('submit_review_unit_result', reviewed());
    expect(capture.getResult()).toEqual({
      ...reviewed(),
      unitId: scope.id,
      coveredSpanIds: scope.spans.map(span => span.id),
      reconciledFindingIds: ['F1', 'F2'],
    });
    expect(parseReviewUnitResult(capture.getResult(), scope)).toEqual(capture.getResult());
    expect(() => parseReviewUnitResult(reviewed(), scope)).toThrow();
    expect(() => parseReviewUnitReceipt(capture.getResult(), scope)).toThrow();
  });

  test('zero-span questions use a portable empty-array schema and still require explicit completion', async () => {
    const scope = { ...unit, spans: [], findingIds: [] };
    const capture = createReviewUnitCapture(scope);
    const { execute, tools } = await harness(capture.factory);
    expect(tools.get('submit_review_unit_result')!.parameters).toMatchObject({
      type: 'object',
      properties: {
        coveredSpans: { type: 'array', maxItems: 0, items: { type: 'string' } },
      },
    });
    const partial = {
      ...receipt(),
      status: 'partial',
      coveredSpans: [],
      findings: [],
      limitations: ['The whole-file integration question remains.'],
    };
    await expect(
      execute('submit_review_unit_result', { ...partial, coveredSpans: ['S1'] })
    ).rejects.toThrow('none');
    await execute('submit_review_unit_result', partial);
    expect(capture.getResult()).toMatchObject({ status: 'partial', coveredSpanIds: [] });
  });

  test('invalid refs and duplicate refs reject safely, then partial S1 maps without promotion or union', async () => {
    const scope = assigned();
    const rejections: { code: string; message: string }[] = [];
    const capture = createReviewUnitCapture(scope, undefined, undefined, undefined, error =>
      rejections.push(error)
    );
    const { execute } = await harness(capture.factory);
    const partial = {
      ...reviewed(),
      status: 'partial',
      limitations: ['Only inspected first span.'],
      coveredSpans: ['S1'],
      findings: [],
    };
    for (const refs of [['S13'], ['S1', 'S1'], ['secret source text']]) {
      await expect(
        execute('submit_review_unit_result', { ...partial, coveredSpans: refs })
      ).rejects.toThrow();
      expect(capture.getResult()).toBeUndefined();
    }
    expect(rejections[0]!.message).toContain('S13');
    expect(JSON.stringify(rejections)).not.toContain('secret source text');
    await execute('submit_review_unit_result', partial);
    expect(capture.getResult()).toMatchObject({
      status: 'partial',
      coveredSpanIds: [scope.spans[0]!.id],
      reconciledFindingIds: [],
      findings: [],
    });
    capture.reset();
    await execute('submit_review_unit_result', { ...partial, coveredSpans: [] });
    expect(capture.getResult()!.coveredSpanIds).toEqual([]);
  });

  test('missing and unknown findings have actionable diagnostics and explicit dispositions remain required', async () => {
    const scope = assigned();
    const rejected: { code: string; message: string }[] = [];
    const capture = createReviewUnitCapture(scope, undefined, undefined, undefined, error =>
      rejected.push(error)
    );
    const { execute } = await harness(capture.factory);
    const bad = { ...reviewed(), findings: [{ ...reviewed().findings[0]!, id: 'F9' }] };
    await expect(execute('submit_review_unit_result', bad)).rejects.toThrow('F2');
    expect(rejected[0]!.message).toContain('F9');
    for (const findings of [
      [reviewed().findings[0]!, reviewed().findings[0]!, reviewed().findings[1]!],
      reviewed().findings.map(finding => ({ ...finding, lifecycle: 'risk_accepted' })),
      reviewed().findings.map(finding => ({ ...finding, dispositionReason: '' })),
    ]) {
      await expect(
        execute('submit_review_unit_result', { ...reviewed(), findings })
      ).rejects.toThrow();
    }
    expect(capture.getResult()).toBeUndefined();
    await execute('submit_review_unit_result', reviewed());
    expect(capture.getResult()!.findings).toEqual(reviewed().findings);
  });

  test('rejects expanded host result over 6 KiB even when model input is compact', async () => {
    const scope = assigned();
    scope.spans = scope.spans.map(span => ({ ...span, id: span.id + 'x'.repeat(600) }));
    const capture = createReviewUnitCapture(scope);
    const { execute } = await harness(capture.factory);
    expect(Buffer.byteLength(JSON.stringify(reviewed()))).toBeLessThan(6144);
    await expect(execute('submit_review_unit_result', reviewed())).rejects.toThrow('6144');
    expect(capture.getResult()).toBeUndefined();
  });

  test('strict model schema rejects legacy payloads, extra fields and reviewed shortrefs', async () => {
    const scope = assigned();
    const capture = createReviewUnitCapture(scope);
    const { execute } = await harness(capture.factory);
    for (const extra of [
      { unitId: scope.id },
      { coveredSpanIds: [] },
      { reconciledFindingIds: [] },
      { coveredSpans: [] },
      { arbitrary: true },
    ]) {
      await expect(
        execute('submit_review_unit_result', { ...reviewed(), ...extra })
      ).rejects.toThrow();
    }
    for (const status of ['partial', 'blocked', 'failed']) {
      await expect(
        execute('submit_review_unit_result', {
          ...reviewed(),
          status,
          limitations: ['Unavailable.'],
        })
      ).rejects.toThrow('coveredSpans');
      await expect(
        execute('submit_review_unit_result', { ...reviewed(), status, coveredSpans: [] })
      ).rejects.toThrow('limitations');
    }
    await execute('submit_review_unit_result', reviewed());
  });

  test('diagnostic callback cannot replace original async validator failure or leak its message', async () => {
    const original = new Error('secret validator source');
    const rejected: { code: string; message: string }[] = [];
    let fail = true;
    const capture = createReviewUnitCapture(
      unit,
      async () => {
        if (fail) {
          throw original;
        }
      },
      undefined,
      undefined,
      diagnostic => {
        rejected.push(diagnostic);
        throw new Error('callback failure');
      }
    );
    const { execute } = await harness(capture.factory);
    await expect(execute('submit_review_unit_result', receipt())).rejects.toBe(original);
    expect(JSON.stringify(rejected)).not.toContain('secret');
    expect(capture.getResult()).toBeUndefined();
    fail = false;
    await expect(execute('submit_review_unit_result', receipt())).resolves.toMatchObject({
      terminate: true,
    });
  });
});

describe('worker capture', () => {
  test('reports read exhaustion once per session without closing the submission endpoint', async () => {
    const warnings: number[][] = [];
    const capture = createReviewUnitCapture(unit, undefined, 2, (attempted, limit) => {
      warnings.push([attempted, limit]);
    });
    const { guard, execute } = await harness(capture.factory);
    expect(guard('read')).toBeUndefined();
    expect(guard('review_file_digests', undefined, { paths: ['first', 'second'] })).toMatchObject({
      block: true,
    });
    expect(guard('read')).toMatchObject({ block: true });
    expect(warnings).toEqual([[3, 2]]);
    expect(guard('submit_review_unit_result')).toBeUndefined();
    await execute('submit_review_unit_result', receipt());
    capture.reset();
    guard('read');
    guard('review_file_digests', undefined, { paths: ['first', 'second'] });
    expect(warnings).toEqual([
      [3, 2],
      [3, 2],
    ]);
  });

  test('invalid and oversized UTF-8 output is retryable before capture; no truncation', async () => {
    const capture = createReviewUnitCapture(unit);
    const { execute } = await harness(capture.factory);
    await expect(
      execute('submit_review_unit_result', { ...result(), coveredSpanIds: [] })
    ).rejects.toThrow();
    await expect(
      execute('submit_review_unit_result', { ...receipt(), assessment: 'é'.repeat(3100) })
    ).rejects.toThrow('6144');
    expect(capture.getResult()).toBeUndefined();
    await expect(execute('submit_review_unit_result', receipt())).resolves.toMatchObject({
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
    await expect(execute('submit_review_unit_result', receipt())).rejects.toThrow('host rejected');
    invalid = false;
    await expect(
      execute('submit_review_unit_result', receipt(), AbortSignal.abort())
    ).rejects.toThrow();
    await expect(
      execute('submit_review_unit_result', receipt(), undefined, AbortSignal.abort())
    ).rejects.toThrow();
    const replies = await Promise.allSettled([
      execute('submit_review_unit_result', receipt()),
      execute('submit_review_unit_result', receipt()),
    ]);
    expect(replies.map(reply => reply.status)).toEqual(['fulfilled', 'rejected']);
    capture.reset();
    expect(capture.getResult()).toBeUndefined();
    await expect(execute('submit_review_unit_result', receipt())).resolves.toMatchObject({
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
      ...receipt(),
      status: 'partial',
      limitations: ['Read-tool budget exhausted.'],
      coveredSpans: [],
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
