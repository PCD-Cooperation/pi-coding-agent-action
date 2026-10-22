import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Check } from 'typebox/value';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import {
  createReviewSubmissionCapture,
  createSubmissionReservation,
  FindingInputSchema,
  parseReviewSubmission,
} from './submission';
import type { ReviewSubmissionCapture } from './submission';
import type { ReviewSubmission } from './types';
import { ReviewDigestCheckSchema } from './work-digests';
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
    digestCheck: Type.Optional(ReviewDigestCheckSchema),
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

export interface ReviewReceiptRejection {
  code: string;
  message: string;
}

class ReviewReceiptError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function reviewSpanReferences(unit: ReviewWorkUnit): { ref: string; spanId: string }[] {
  return unit.spans.map((span, index) => ({ ref: `S${index + 1}`, spanId: span.id }));
}

function reviewUnitToolSchema(unit: ReviewWorkUnit) {
  const common = {
    assessment: nonblank(),
    findings: Type.Array(FindingInputSchema),
    followUps: Type.Array(ReviewWorkFollowUpSchema, { maxItems: 8 }),
  };
  const references = reviewSpanReferences(unit);
  return Type.Object(
    {
      ...common,
      status: Type.Union([
        Type.Literal('reviewed'),
        Type.Literal('partial'),
        Type.Literal('blocked'),
        Type.Literal('failed'),
      ]),
      limitations: Type.Array(nonblank()),
      coveredSpans: Type.Optional(
        Type.Array(
          references.length
            ? Type.Union(references.map(({ ref }) => Type.Literal(ref)))
            : Type.String(),
          { uniqueItems: true, ...(references.length ? {} : { maxItems: 0 }) }
        )
      ),
    },
    { additionalProperties: false }
  );
}

function safeReceiptLabels(values: string[], prefix: 'S' | 'F'): string {
  const pattern = prefix === 'S' ? /^S\d{1,6}$/ : /^F\d{1,6}$/;
  return values
    .slice(0, 12)
    .map(value => (pattern.test(value) ? value : '[invalid ID]'))
    .join(', ');
}

export function parseReviewUnitReceipt(value: unknown, unit: ReviewWorkUnit): ReviewUnitResult {
  const references = reviewSpanReferences(unit);
  if (
    value &&
    typeof value === 'object' &&
    'coveredSpans' in value &&
    Array.isArray(value.coveredSpans)
  ) {
    const refs: unknown[] = value.coveredSpans;
    const invalid = refs.filter(
      ref => typeof ref !== 'string' || !references.some(item => item.ref === ref)
    );
    if (invalid.length) {
      throw new ReviewReceiptError(
        'span_scope',
        `Invalid shortrefs: ${
          safeReceiptLabels(
            invalid.filter((ref): ref is string => typeof ref === 'string'),
            'S'
          ) || '[invalid ID]'
        }. Allowed references: ${references.length ? `S1..S${references.length}` : 'none'}.`
      );
    }
    if (new Set(refs).size !== refs.length) {
      throw new ReviewReceiptError(
        'duplicate_spans',
        'Duplicate shortrefs; coveredSpans must be unique.'
      );
    }
  }
  if (!Check(reviewUnitToolSchema(unit), value)) {
    throw new ReviewReceiptError(
      'receipt_shape',
      'Invalid model receipt fields. Reviewed requires empty limitations and no coverage or host IDs; other statuses require coveredSpans and nonempty limitations.'
    );
  }
  if (
    value.status === 'reviewed'
      ? 'coveredSpans' in value || value.limitations.length > 0
      : !Array.isArray(value.coveredSpans) || value.limitations.length === 0
  ) {
    throw new ReviewReceiptError(
      'receipt_coverage',
      'Reviewed must omit coveredSpans and have no limitations; partial, blocked, and failed require coveredSpans and nonempty limitations.'
    );
  }
  const findingIds = value.findings.flatMap(finding => (finding.id === null ? [] : [finding.id]));
  const unknown = findingIds.filter(id => !unit.findingIds.includes(id));
  const missing =
    value.status === 'reviewed' ? unit.findingIds.filter(id => !findingIds.includes(id)) : [];
  if (unknown.length || missing.length) {
    throw new ReviewReceiptError(
      'finding_scope',
      `Finding IDs outside assigned scope: ${safeReceiptLabels(unknown, 'F') || 'none'}; missing explicit findings: ${safeReceiptLabels(missing, 'F') || 'none'}.`
    );
  }
  return parseReviewUnitResult(
    {
      unitId: unit.id,
      status: value.status,
      coveredSpanIds:
        value.status === 'reviewed'
          ? references.map(item => item.spanId)
          : value.coveredSpans!.map(ref => references.find(item => item.ref === ref)!.spanId),
      reconciledFindingIds: findingIds,
      assessment: value.assessment,
      limitations: value.limitations,
      findings: value.findings,
      followUps: value.followUps,
    },
    unit
  );
}

function receiptRejection(error: unknown): ReviewReceiptRejection {
  if (error instanceof ReviewReceiptError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'validation_rejected',
    message: 'Review result rejected by host validation. No result was captured.',
  };
}

export const ReviewFollowUpsSchema = Type.Object(
  { requests: Type.Array(ReviewWorkFollowUpSchema, { minItems: 1, maxItems: 8 }) },
  { additionalProperties: false }
);

function requireBudget(value: unknown, bytes: number): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > bytes) {
    throw new ReviewReceiptError(
      'output_budget',
      `Review output exceeds ${bytes} UTF-8 JSON bytes; shorten and resubmit. No result was captured.`
    );
  }
}

function validateFollowUpPaths(requests: ReviewWorkFollowUp[]): void {
  for (const request of requests) {
    for (const path of [
      ...request.paths,
      ...(request.digestCheck ? [request.digestCheck.manifestPath] : []),
    ]) {
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
    throw new ReviewReceiptError('duplicate_findings', 'Review finding IDs must be unique.');
  }
  if (result.findings.some(finding => finding.lifecycle === 'risk_accepted')) {
    throw new ReviewReceiptError('risk_acceptance', 'Workers cannot accept risk.');
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
  'review_file_digests',
  'grep',
  'find',
  'ls',
  'get_issue_or_pr_thread',
  'codemode',
]);

function readOnlyGuard(
  endpoints: string[],
  budget = 60,
  onExhausted?: (attempted: number, limit: number) => void
) {
  let calls = 0;
  let warned = false;
  const limit = Number.isFinite(budget) ? Math.max(0, Math.min(60, Math.floor(budget))) : 60;
  return {
    reset: () => {
      calls = 0;
      warned = false;
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
        let cost = 1;
        if (event.toolName === 'review_file_digests') {
          const paths = event.input.paths;
          if (!Array.isArray(paths) || paths.length < 1 || paths.length > 8) {
            return {
              block: true,
              reason: 'Review file digests require between one and eight paths.',
            };
          }
          cost = paths.length;
        }
        calls += cost;
        if (calls > limit) {
          if (!warned) {
            warned = true;
            onExhausted?.(calls, limit);
          }
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
  validate?: (result: ReviewUnitResult) => void | Promise<void>,
  toolBudget?: number,
  onReadBudgetExhausted?: (attempted: number, limit: number) => void,
  onRejected?: (rejection: ReviewReceiptRejection) => void
): ReviewUnitCapture {
  const unit = structuredClone(assignedUnit);
  let result: ReviewUnitResult | undefined;
  const reservation = createSubmissionReservation();
  const guard = readOnlyGuard(['submit_review_unit_result'], toolBudget, onReadBudgetExhausted);
  const parameters = reviewUnitToolSchema(unit);
  const reportRejection = (error: unknown) => {
    try {
      onRejected?.(receiptRejection(error));
    } catch {
      // Diagnostics must not replace the original validation failure.
    }
  };
  return {
    getResult: () => (result ? structuredClone(result) : undefined),
    reset: () => {
      result = undefined;
      reservation.reset();
      guard.reset();
    },
    factory: pi => {
      guard.factory(pi);
      pi.registerTool({
        name: 'submit_review_unit_result',
        label: 'Submit review unit result',
        exposure: 'model-only',
        description:
          'Submit one full snapshot for the assigned unit (expanded host result maximum 6 KiB JSON). Reviewed explicitly acknowledges the whole assigned unit; omit coveredSpans and report every prior finding disposition. Other statuses require unique assigned shortrefs in coveredSpans (possibly empty) and nonempty limitations. Only the host assigns coverage IDs and publishes results.',
        parameters,
        // The SDK validates arguments before execute; diagnose without capturing.
        prepareArguments: args => {
          try {
            parseReviewUnitReceipt(args, unit);
            return args as Static<typeof parameters>;
          } catch (error) {
            reportRejection(error);
            throw error;
          }
        },
        execute: async (_id, params, signal, _update, ctx) => {
          signal?.throwIfAborted();
          ctx.signal?.throwIfAborted();
          const ticket = reservation.reserve(
            'Review unit result has already been submitted or is being validated.'
          );
          try {
            const candidate = parseReviewUnitReceipt(params, unit);
            await validate?.(structuredClone(candidate));
            signal?.throwIfAborted();
            ctx.signal?.throwIfAborted();
            ticket.assertCurrent();
            result = candidate;
          } catch (error) {
            ticket.release();
            reportRejection(error);
            throw error;
          }
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
  validateReview?: (result: ReviewSubmission) => void | Promise<void>,
  validateFollowUps?: (requests: ReviewWorkFollowUp[]) => void | Promise<void>,
  toolBudget?: number,
  onReadBudgetExhausted?: (attempted: number, limit: number) => void
): ReviewSynthesisCapture {
  let requests: ReviewWorkFollowUp[] | undefined;
  const reservation = createSubmissionReservation();
  const submission = createReviewSubmissionCapture(() => false, validateReview, reservation);
  const guard = readOnlyGuard(
    ['submit_review_result', 'request_review_followup'],
    toolBudget,
    onReadBudgetExhausted
  );
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
          const ticket = reservation.reserve(
            'A review result or follow-up request has already been submitted or is being validated.'
          );
          try {
            if (!Check(ReviewFollowUpsSchema, params)) {
              throw new Error('Invalid review follow-up requests.');
            }
            const candidate = parseReviewFollowUps(params.requests);
            await validateFollowUps?.(structuredClone(candidate));
            signal?.throwIfAborted();
            ctx.signal?.throwIfAborted();
            ticket.assertCurrent();
            requests = candidate;
          } catch (error) {
            ticket.release();
            throw error;
          }
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
