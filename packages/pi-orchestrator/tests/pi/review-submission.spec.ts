import { describe, expect, test } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  createReviewSubmissionCapture,
  parseReviewSubmission,
  ReviewSubmissionSchema,
} from '../../src/review/submission';
import type { ReviewSubmission, ReviewSnapshot } from '../../src/review/types';
import { advanceReview, reviewHash } from '../../src/review/state';

const validSubmission = (): ReviewSubmission => ({
  coverage: 'complete',
  coverageNotes: '',
  findings: [
    {
      id: null,
      rootCause: 'Missing tenant predicate',
      origin: 'pr_introduced',
      lifecycle: 'open',
      material: true,
      location: 'src/query.ts:42',
      evidence: 'The query selects all tenants at HEAD.',
      originEvidence: 'The pinned base query has a tenant predicate.',
      dispositionReason: '',
    },
  ],
});

async function setup(
  hasChildren = () => false,
  validateTransition?: (submission: ReviewSubmission) => void
) {
  const capture = createReviewSubmissionCapture(hasChildren, validateTransition);
  let tool!: ToolDefinition<typeof ReviewSubmissionSchema>;
  const handlers = new Map<string, (event: { toolName: string }) => unknown>();
  await capture.factory({
    registerTool: registered => {
      tool = registered as unknown as typeof tool;
    },
    on: (name, handler) => {
      handlers.set(name, handler as never);
    },
  } as ExtensionAPI);
  const execute = (value: unknown, signal?: AbortSignal, contextSignal?: AbortSignal) =>
    tool.execute('submission', value as ReviewSubmission, signal, undefined, {
      signal: contextSignal,
    } as ExtensionToolContext);
  return { capture, tool, execute, handlers };
}

describe('strict review submission validation', () => {
  test('accepts a complete result and returns an owned copy', () => {
    const value = validSubmission();
    const result = parseReviewSubmission(value);
    expect(result).toEqual(value);
    expect(result).not.toBe(value);
    expect(parseReviewSubmission({ ...value, findings: [] }).findings).toEqual([]);
  });

  test.each(Object.keys(validSubmission()))('rejects missing top-level field %s', key => {
    const value: Record<string, unknown> = validSubmission() as unknown as Record<string, unknown>;
    delete value[key];
    expect(() => parseReviewSubmission(value)).toThrow();
  });

  test.each(Object.keys(validSubmission().findings[0]!))(
    'rejects missing finding field %s',
    key => {
      const value = validSubmission();
      delete (value.findings[0] as unknown as Record<string, unknown>)[key];
      expect(() => parseReviewSubmission(value)).toThrow();
    }
  );

  test.each([
    null,
    [],
    true,
    'result',
    { ...validSubmission(), extra: true },
    { ...validSubmission(), coverage: 'partial' },
    { ...validSubmission(), coverageNotes: 1 },
    { ...validSubmission(), findings: {} },
    { ...validSubmission(), findings: [null] },
  ])('rejects invalid submission %j', value => {
    expect(() => parseReviewSubmission(value)).toThrow();
  });

  test.each([
    ['id', 1],
    ['id', '  '],
    ['rootCause', false],
    ['rootCause', ' \n'],
    ['material', 'true'],
    ['material', 0],
    ['origin', 'new'],
    ['lifecycle', 'resolved'],
    ['location', ''],
    ['evidence', '\t'],
    ['originEvidence', ' '],
    ['dispositionReason', null],
    ['extra', true],
  ])('rejects invalid finding %s=%j', (key, invalid) => {
    const value = validSubmission();
    Object.assign(value.findings[0]!, { [key]: invalid });
    expect(() => parseReviewSubmission(value)).toThrow();
  });

  test('requires notes for incomplete coverage and reasons for closed findings', () => {
    const value = validSubmission();
    value.coverage = 'incomplete';
    expect(() => parseReviewSubmission(value)).toThrow('coverageNotes');
    value.coverageNotes = 'Could not inspect generated sources.';
    value.findings[0]!.lifecycle = 'fixed';
    expect(() => parseReviewSubmission(value)).toThrow('dispositionReason');
    value.findings[0]!.dispositionReason = 'HEAD restores the tenant predicate.';
    expect(parseReviewSubmission(value)).toEqual(value);
  });
});

describe('submission extension', () => {
  test('registers schema and captures exactly one successful result', async () => {
    const { capture, tool, execute } = await setup();
    expect(tool.parameters).toBe(ReviewSubmissionSchema);
    expect(capture.getSubmission()).toBeUndefined();
    await expect(execute({})).rejects.toThrow('Invalid review submission');
    expect(capture.getSubmission()).toBeUndefined();
    const value = validSubmission();
    await execute(value);
    value.findings.length = 0;
    expect(capture.getSubmission()?.findings).toHaveLength(1);
    await expect(execute(validSubmission())).rejects.toThrow('already been submitted');
    expect(capture.getSubmission()?.findings).toHaveLength(1);
  });

  test('invalid ledger IDs are correctable inside the tool before capture or termination', async () => {
    const snapshot: ReviewSnapshot = {
      repository: 'owner/repo',
      pullNumber: 1,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      mergeBaseSha: 'c'.repeat(40),
      baseRef: 'main',
      intentHash: reviewHash('intent'),
      mode: 'full',
      fallbackReason: null,
      headPath: '/head',
      basePath: '/base',
      previousPath: null,
      fullDiffPath: '/full.diff',
      incrementalDiffPath: null,
    };
    const validate = (candidate: ReviewSubmission) => {
      advanceReview(null, snapshot, candidate, reviewHash('config'), reviewHash('operation'), 3);
    };
    const { execute, capture } = await setup(() => false, validate);
    const invalid = validSubmission();
    invalid.findings[0]!.id = 'invented-by-model';
    await expect(execute(invalid)).rejects.toThrow('New findings must use id=null');
    expect(capture.getSubmission()).toBeUndefined();
    const accepted = await execute(validSubmission());
    expect(accepted.terminate).toBe(true);
    expect(capture.getSubmission()).toEqual(validSubmission());
  });

  test('rejects concurrent duplicate calls without overwriting the first', async () => {
    const { execute, capture } = await setup();
    const results = await Promise.allSettled([
      execute(validSubmission()),
      execute(validSubmission()),
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(capture.getSubmission()).toEqual(validSubmission());
  });

  test('rejects aborted calls, including an aborted context signal', async () => {
    const { capture, execute } = await setup();
    await expect(execute(validSubmission(), AbortSignal.abort())).rejects.toThrow();
    await expect(execute(validSubmission(), undefined, AbortSignal.abort())).rejects.toThrow();
    expect(capture.getSubmission()).toBeUndefined();
  });

  test('requires collection of all children before capturing', async () => {
    let uncollected = true;
    const { capture, execute } = await setup(() => uncollected);
    await expect(execute(validSubmission())).rejects.toThrow('child findings were not collected');
    expect(capture.getSubmission()).toBeUndefined();
    uncollected = false;
    await execute(validSubmission());
    expect(capture.getSubmission()).toEqual(validSubmission());
  });

  test('blocks unsafe nested calls as well as direct calls', async () => {
    const { handlers } = await setup();
    const guard = handlers.get('tool_call')!;
    for (const toolName of ['bash', 'write', 'edit', 'get_pr_diff', 'create_pr', 'tool_search']) {
      expect(guard({ toolName })).toMatchObject({ block: true });
    }
    for (const toolName of ['read', 'codemode', 'submit_review_result', 'wait_subagents']) {
      expect(guard({ toolName })).toBeUndefined();
    }
  });
});
