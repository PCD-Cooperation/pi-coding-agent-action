import { Type } from 'typebox';
import { Check } from 'typebox/value';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ReviewSubmission } from './types';

const nonblank = () => Type.String({ pattern: '\\S' });

export const FindingInputSchema = Type.Object(
  {
    id: Type.Union([nonblank(), Type.Null()], {
      description:
        'For a new finding use null. Reuse only an exact ID from the provided ledger; never invent an ID.',
    }),
    rootCause: nonblank(),
    origin: Type.Union([
      Type.Literal('pr_introduced'),
      Type.Literal('pre_existing'),
      Type.Literal('pre_existing_worsened'),
      Type.Literal('uncertain'),
    ]),
    lifecycle: Type.Union([
      Type.Literal('open'),
      Type.Literal('fixed'),
      Type.Literal('refuted'),
      Type.Literal('risk_accepted'),
      Type.Literal('reintroduced'),
    ]),
    material: Type.Boolean(),
    location: nonblank(),
    evidence: nonblank(),
    originEvidence: nonblank(),
    dispositionReason: Type.String(),
  },
  { additionalProperties: false }
);

export const ReviewSubmissionSchema = Type.Object(
  {
    coverage: Type.Union([Type.Literal('complete'), Type.Literal('incomplete')]),
    coverageNotes: Type.String(),
    findings: Type.Array(FindingInputSchema),
  },
  { additionalProperties: false }
);

/** Validate without coercion, defaults, or removal of unknown properties. */
export function parseReviewSubmission(value: unknown): ReviewSubmission {
  if (!Check(ReviewSubmissionSchema, value)) {
    throw new Error('Invalid review submission: required fields, types, or evidence are invalid.');
  }
  if (value.coverage === 'incomplete' && !value.coverageNotes.trim()) {
    throw new Error('Incomplete coverage requires coverageNotes.');
  }
  for (const finding of value.findings) {
    if (
      ['fixed', 'refuted', 'risk_accepted'].includes(finding.lifecycle) &&
      !finding.dispositionReason.trim()
    ) {
      throw new Error('A closed finding requires a dispositionReason.');
    }
  }
  // Own the captured data: callers cannot mutate an already accepted submission.
  return structuredClone(value);
}

export interface ReviewSubmissionCapture {
  factory: ExtensionFactory;
  getSubmission(): ReviewSubmission | undefined;
  reset(): void;
}

export function createSubmissionReservation() {
  let active: object | undefined;
  return {
    reset: () => {
      active = undefined;
    },
    reserve: (message: string) => {
      if (active) {
        throw new Error(message);
      }
      const token = {};
      active = token;
      return {
        assertCurrent: () => {
          if (active !== token) {
            throw new Error(
              'Review submission was reset during validation; resubmit for the current run.'
            );
          }
        },
        release: () => {
          if (active === token) {
            active = undefined;
          }
        },
      };
    },
  };
}

/** Capture one validated result in memory; publication belongs exclusively to the host. */
export function createReviewSubmissionCapture(
  hasUncollectedChildren: () => boolean = () => false,
  validateTransition?: (submission: ReviewSubmission) => void | Promise<void>,
  reservation = createSubmissionReservation()
): ReviewSubmissionCapture {
  let submission: ReviewSubmission | undefined;
  return {
    getSubmission: () => (submission ? structuredClone(submission) : undefined),
    reset: () => {
      submission = undefined;
      reservation.reset();
    },
    factory: pi => {
      // Also guard nested calls (e.g. codemode), not just model declarations.
      pi.on('tool_call', event => {
        if (!STATEFUL_REVIEW_TOOLS.has(event.toolName)) {
          return { block: true, reason: 'Stateful review permits only read-only review tools.' };
        }
        return undefined;
      });
      pi.registerTool({
        name: 'submit_review_result',
        label: 'Submit review result',
        exposure: 'model-only',
        description:
          'Submit exactly one structured review result after collecting all child findings. This captures data only; the host validates and publishes it after the session settles.',
        parameters: ReviewSubmissionSchema,
        execute: async (_id, params, signal, _update, ctx) => {
          signal?.throwIfAborted();
          ctx.signal?.throwIfAborted();
          const ticket = reservation.reserve(
            'Review result has already been submitted or is being validated.'
          );
          try {
            if (hasUncollectedChildren()) {
              throw new Error('Incomplete review: child findings were not collected.');
            }
            const candidate = parseReviewSubmission(params);
            await validateTransition?.(structuredClone(candidate));
            signal?.throwIfAborted();
            ctx.signal?.throwIfAborted();
            ticket.assertCurrent();
            submission = candidate;
          } catch (error) {
            ticket.release();
            throw error;
          }
          return {
            content: [{ type: 'text', text: 'Review result captured for host validation.' }],
            details: undefined,
            terminate: true,
          };
        },
      });
    },
  };
}

export const STATEFUL_REVIEW_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'review_file_digests',
  'grep',
  'find',
  'ls',
  'get_issue_or_pr_thread',
  'codemode',
  'subagent',
  'wait_subagents',
  'submit_review_result',
  'request_review_followup',
]);
