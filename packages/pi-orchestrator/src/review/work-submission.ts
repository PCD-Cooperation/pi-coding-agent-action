import { Type } from 'typebox';
import { Check } from 'typebox/value';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import {
  createReviewSubmissionCapture,
  FindingInputSchema,
  parseReviewSubmission,
} from './submission';
import type { ReviewSubmissionCapture } from './submission';
import type { ReviewSubmission } from './types';
import type { ReviewUnitResult, ReviewWorkFollowUp, ReviewWorkUnit } from './work-types';

const nonblank = () => Type.String({ pattern: '\\S' });

export const ReviewWorkFollowUpSchema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
    }),
    question: Type.String({ pattern: '\\S', maxLength: 1000 }),
  },
  { additionalProperties: false }
);

export function reviewUnitResultSchema(unit?: ReviewWorkUnit) {
  return Type.Object(
    {
      unitId: unit ? Type.Literal(unit.id) : nonblank(),
      status: Type.Union([
        Type.Literal('reviewed'),
        Type.Literal('partial'),
        Type.Literal('blocked'),
        Type.Literal('failed'),
      ]),
      coveredSpanIds: Type.Array(nonblank(), { uniqueItems: true }),
      reconciledFindingIds: Type.Array(nonblank(), { uniqueItems: true }),
      assessment: nonblank(),
      limitations: Type.Array(nonblank()),
      findings: Type.Array(FindingInputSchema),
      followUps: Type.Array(ReviewWorkFollowUpSchema, { maxItems: 8 }),
    },
    { additionalProperties: false }
  );
}

export const ReviewFollowUpsSchema = Type.Object(
  { requests: Type.Array(ReviewWorkFollowUpSchema, { minItems: 1, maxItems: 8 }) },
  { additionalProperties: false }
);

function requireBudget(value: unknown, bytes: number): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > bytes) {
    throw new Error(
      `Review output exceeds ${bytes} UTF-8 JSON bytes; shorten and resubmit. No result was captured.`
    );
  }
}

function validateFollowUpPaths(requests: ReviewWorkFollowUp[]): void {
  for (const request of requests) {
    for (const path of request.paths) {
      if (
        path.trim() !== path ||
        path.includes('\\') ||
        path.includes(':') ||
        Array.from(path).some(char => {
          const code = char.charCodeAt(0);
          return code < 32 || (code >= 127 && code <= 159);
        }) ||
        path.startsWith('/') ||
        path.split('/').some(part => !part || part === '.' || part === '..')
      ) {
        throw new Error(
          'Follow-up paths must be repository-relative paths without traversal or controls.'
        );
      }
    }
  }
}

export function parseReviewFollowUps(value: unknown): ReviewWorkFollowUp[] {
  if (!Check(Type.Array(ReviewWorkFollowUpSchema, { maxItems: 8 }), value)) {
    throw new Error('Invalid review follow-up requests.');
  }
  const requests = value;
  requireBudget({ requests }, 16 * 1024);
  validateFollowUpPaths(requests);
  return structuredClone(requests);
}

export function parseReviewUnitResult(value: unknown, unit?: ReviewWorkUnit): ReviewUnitResult {
  if (!Check(reviewUnitResultSchema(unit), value)) {
    throw new Error('Invalid review unit result: required fields, IDs, or evidence are invalid.');
  }
  requireBudget(value, 6 * 1024);
  const result = value;
  parseReviewSubmission({ coverage: 'complete', coverageNotes: '', findings: result.findings });
  validateFollowUpPaths(result.followUps);
  const findingIds = result.findings.flatMap(finding => (finding.id === null ? [] : [finding.id]));
  if (new Set(findingIds).size !== findingIds.length) {
    throw new Error('Review finding IDs must be unique.');
  }
  if (result.findings.some(finding => finding.lifecycle === 'risk_accepted')) {
    throw new Error('Workers cannot accept risk.');
  }
  if (
    result.status === 'reviewed' ? result.limitations.length > 0 : result.limitations.length === 0
  ) {
    throw new Error(
      'Reviewed units cannot have limitations; partial, blocked, and failed units require limitations.'
    );
  }
  if (unit) {
    const spans = new Set(unit.spans.map(span => span.id));
    const findings = new Set(unit.findingIds);
    if (
      result.coveredSpanIds.some(id => !spans.has(id)) ||
      result.reconciledFindingIds.some(id => !findings.has(id) || !findingIds.includes(id)) ||
      findingIds.some(id => !findings.has(id))
    ) {
      throw new Error('Review unit result contains IDs outside its assigned scope.');
    }
    if (
      result.status === 'reviewed' &&
      (result.coveredSpanIds.length !== spans.size ||
        result.reconciledFindingIds.length !== findings.size)
    ) {
      throw new Error('Reviewed units must cover exactly all assigned span and finding IDs.');
    }
  }
  return structuredClone(result);
}

export const REVIEW_WORK_READ_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'get_issue_or_pr_thread',
  'codemode',
]);

function readOnlyGuard(endpoints: string[], budget = 60) {
  let calls = 0;
  const limit = Number.isFinite(budget) ? Math.max(0, Math.min(60, Math.floor(budget))) : 60;
  return {
    reset: () => {
      calls = 0;
    },
    factory: (pi => {
      pi.on('tool_call', event => {
        if (endpoints.includes(event.toolName)) {
          return undefined;
        }
        if (!REVIEW_WORK_READ_TOOLS.has(event.toolName)) {
          return {
            block: true,
            reason:
              'Review work permits only read-only tools; child agents and mutations are forbidden.',
          };
        }
        if (++calls > limit) {
          return {
            block: true,
            reason:
              'Review read-tool budget exhausted. Submit an honest partial or blocked result with limitations.',
          };
        }
        return undefined;
      });
    }) satisfies ExtensionFactory,
  };
}

export interface ReviewUnitCapture {
  factory: ExtensionFactory;
  getResult(): ReviewUnitResult | undefined;
  reset(): void;
}

export function createReviewUnitCapture(
  assignedUnit: ReviewWorkUnit,
  validate?: (result: ReviewUnitResult) => void,
  toolBudget?: number
): ReviewUnitCapture {
  const unit = structuredClone(assignedUnit);
  let result: ReviewUnitResult | undefined;
  const guard = readOnlyGuard(['submit_review_unit_result'], toolBudget);
  return {
    getResult: () => (result ? structuredClone(result) : undefined),
    reset: () => {
      result = undefined;
      guard.reset();
    },
    factory: pi => {
      guard.factory(pi);
      pi.registerTool({
        name: 'submit_review_unit_result',
        label: 'Submit review unit result',
        exposure: 'model-only',
        description:
          'Capture exactly one result for the assigned unit (maximum 6 KiB JSON). Report limitations honestly. Only the host publishes results.',
        parameters: reviewUnitResultSchema(unit),
        execute: async (_id, params, signal, _update, ctx) => {
          signal?.throwIfAborted();
          ctx.signal?.throwIfAborted();
          if (result) {
            throw new Error('Review unit result has already been submitted.');
          }
          const candidate = parseReviewUnitResult(params, unit);
          validate?.(structuredClone(candidate));
          result = candidate;
          return {
            content: [{ type: 'text', text: 'Review unit result captured for host validation.' }],
            details: undefined,
            terminate: true,
          };
        },
      });
    },
  };
}

export interface ReviewSynthesisCapture extends ReviewSubmissionCapture {
  getFollowUps(): ReviewWorkFollowUp[] | undefined;
}

export function createReviewSynthesisCapture(
  validateReview?: (result: ReviewSubmission) => void,
  validateFollowUps?: (requests: ReviewWorkFollowUp[]) => void,
  toolBudget?: number
): ReviewSynthesisCapture {
  let requests: ReviewWorkFollowUp[] | undefined;
  const submission = createReviewSubmissionCapture(
    () => false,
    candidate => {
      if (requests) {
        throw new Error('Review follow-up requests have already been submitted.');
      }
      validateReview?.(candidate);
    }
  );
  const guard = readOnlyGuard(['submit_review_result', 'request_review_followup'], toolBudget);
  return {
    getSubmission: submission.getSubmission,
    getFollowUps: () => (requests ? structuredClone(requests) : undefined),
    reset: () => {
      requests = undefined;
      submission.reset();
      guard.reset();
    },
    factory: async pi => {
      await submission.factory(pi);
      guard.factory(pi);
      pi.registerTool({
        name: 'request_review_followup',
        label: 'Request review follow-up',
        exposure: 'model-only',
        description:
          'Request required review scope instead of submitting a full review. Capture at most eight requests (16 KiB JSON); only the host schedules work.',
        parameters: ReviewFollowUpsSchema,
        execute: async (_id, params, signal, _update, ctx) => {
          signal?.throwIfAborted();
          ctx.signal?.throwIfAborted();
          if (requests || submission.getSubmission()) {
            throw new Error('A review result or follow-up request has already been submitted.');
          }
          if (!Check(ReviewFollowUpsSchema, params)) {
            throw new Error('Invalid review follow-up requests.');
          }
          const candidate = parseReviewFollowUps(params.requests);
          validateFollowUps?.(structuredClone(candidate));
          requests = candidate;
          return {
            content: [
              { type: 'text', text: 'Review follow-up requests captured for host validation.' },
            ],
            details: undefined,
            terminate: true,
          };
        },
      });
    },
  };
}
