import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { FindingInputSchema, parseReviewSubmission } from './submission';
import type {
  FindingInput,
  ReviewFinding,
  ReviewIdentity,
  ReviewSnapshot,
  ReviewState,
  ReviewSubmission,
} from './types';

export const REVIEW_STATE_MARKER = '<!-- pi-stateful-review:v1 -->';
const STATE_PREFIX = '<!-- pi-stateful-review-data:';
const SHA = Type.String({ pattern: '^[0-9a-f]{40}$' });
const Text = Type.String({ minLength: 1 });
const Counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const IdentitySchema = Type.Object(
  {
    repository: Text,
    pullNumber: Type.Integer({ minimum: 1 }),
    headSha: SHA,
    baseSha: SHA,
    mergeBaseSha: SHA,
    baseRef: Text,
    intentHash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  },
  { additionalProperties: false }
);
const StateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    revision: Type.Integer({ minimum: 1 }),
    snapshot: IdentitySchema,
    configurationHash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    operationKey: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    completedReviews: Type.Integer({ minimum: 1 }),
    reviewMode: Type.Union([Type.Literal('full'), Type.Literal('incremental')]),
    fallbackReason: Type.Union([Type.String(), Type.Null()]),
    coverageNotes: Type.String(),
    actionableRounds: Counter,
    needsHuman: Type.Boolean(),
    nextFindingId: Type.Integer({ minimum: 1 }),
    findings: Type.Array(
      Type.Object(
        {
          ...FindingInputSchema.properties,
          id: Type.String({ pattern: '^F[1-9][0-9]*$' }),
          firstReportedHead: SHA,
        },
        { additionalProperties: false }
      )
    ),
    intervention: Type.Union([
      Type.Null(),
      Type.Object(
        {
          actor: Text,
          control: Type.Union([
            Type.Literal('bootstrap'),
            Type.Literal('resume'),
            Type.Literal('full'),
          ]),
          reason: Text,
        },
        { additionalProperties: false }
      ),
    ]),
  },
  { additionalProperties: false }
);
const StateValidator = Compile(StateSchema);

export function reviewHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function reviewIdentity(snapshot: ReviewSnapshot): ReviewIdentity {
  const { repository, pullNumber, headSha, baseSha, mergeBaseSha, baseRef, intentHash } = snapshot;
  return { repository, pullNumber, headSha, baseSha, mergeBaseSha, baseRef, intentHash };
}

export function parseReviewState(value: unknown): ReviewState {
  if (!StateValidator.Check(value)) {
    throw new Error('Invalid stateful review state; human recovery is required.');
  }
  const state = value as ReviewState;
  const ids = new Set(state.findings.map(finding => finding.id));
  const highestId = Math.max(0, ...state.findings.map(finding => Number(finding.id.slice(1))));
  if (
    ids.size !== state.findings.length ||
    state.nextFindingId <= highestId ||
    state.actionableRounds > state.completedReviews ||
    state.revision !== state.completedReviews
  ) {
    throw new Error('Inconsistent stateful review ledger; human recovery is required.');
  }
  return state;
}

export function parseReviewComment(body: string): ReviewState {
  if (!body.startsWith(`${REVIEW_STATE_MARKER}\n`) || body.split(STATE_PREFIX).length !== 2) {
    throw new Error('Malformed canonical review comment; human recovery is required.');
  }
  const encoded = body.slice(body.indexOf(STATE_PREFIX) + STATE_PREFIX.length);
  const match = /^([A-Za-z0-9+/]+={0,2}) -->\s*$/.exec(encoded);
  if (!match) {
    throw new Error('Missing or malformed canonical review payload.');
  }
  return parseReviewState(JSON.parse(Buffer.from(match[1]!, 'base64').toString('utf8')));
}

export function isOpen(finding: Pick<FindingInput, 'lifecycle'>): boolean {
  return finding.lifecycle === 'open' || finding.lifecycle === 'reintroduced';
}

export function isBlocker(finding: FindingInput): boolean {
  return (
    isOpen(finding) &&
    finding.material &&
    (finding.origin === 'pr_introduced' || finding.origin === 'pre_existing_worsened')
  );
}

function normalizeRoot(root: string): string {
  return root.trim().toLowerCase().replace(/\s+/g, ' ');
}

function reconcileFindings(
  previous: ReviewState | null,
  result: ReviewSubmission,
  headSha: string
): { findings: ReviewFinding[]; nextFindingId: number } {
  const prior = new Map((previous?.findings ?? []).map(finding => [finding.id, finding]));
  const seen = new Set<string>();
  let nextFindingId = previous?.nextFindingId ?? 1;
  const findings = result.findings.map(input => {
    const old = input.id === null ? undefined : prior.get(input.id);
    if (input.id !== null && (!old || seen.has(input.id))) {
      throw new Error(
        `Unknown or duplicate finding ID: ${input.id}. New findings must use id=null; existing findings must reuse their exact ledger ID.`
      );
    }
    if (!old && input.lifecycle !== 'open') {
      throw new Error('A new finding must start open.');
    }
    if (input.lifecycle === 'risk_accepted' && old?.lifecycle !== 'risk_accepted') {
      throw new Error("The reviewer cannot accept risk on a human's behalf.");
    }
    if (old && old.lifecycle !== input.lifecycle && !input.dispositionReason.trim()) {
      throw new Error(`A lifecycle transition needs a reason: ${old.id}`);
    }
    if (old && !isOpen(old) && isOpen(input) && input.lifecycle !== 'reintroduced') {
      throw new Error(`Reopening ${old.id} must be classified as reintroduced.`);
    }
    const id = old?.id ?? `F${nextFindingId++}`;
    seen.add(id);
    return { ...input, id, firstReportedHead: old?.firstReportedHead ?? headSha };
  });
  for (const finding of prior.values()) {
    if (seen.has(finding.id)) {
      continue;
    }
    if (isOpen(finding)) {
      throw new Error(`Missing explicit reconciliation of ${finding.id}.`);
    }
    findings.push(finding);
  }
  const roots = findings.map(finding => normalizeRoot(finding.rootCause));
  if (new Set(roots).size !== roots.length) {
    throw new Error('Duplicate root cause; reuse the existing finding ID.');
  }
  return { findings, nextFindingId };
}

export function advanceReview(
  previous: ReviewState | null,
  snapshot: ReviewSnapshot,
  rawResult: unknown,
  configurationHash: string,
  operationKey: string,
  maxRounds: number,
  intervention: ReviewState['intervention'] = null
): ReviewState {
  const result = parseReviewSubmission(rawResult);
  if (result.coverage !== 'complete') {
    throw new Error(`Incomplete review; cursor unchanged: ${result.coverageNotes}`);
  }
  if (previous?.needsHuman && intervention?.control !== 'resume') {
    throw new Error('Human reassessment is required before further automatic review.');
  }
  const { findings, nextFindingId } = reconcileFindings(previous, result, snapshot.headSha);
  const blockers = findings.filter(isBlocker);
  const previousRounds = intervention?.control === 'resume' ? 0 : (previous?.actionableRounds ?? 0);
  const sameFixRevision =
    previousRounds > 0 &&
    previous?.snapshot.headSha === snapshot.headSha &&
    intervention?.control !== 'resume';
  const actionableRounds = blockers.length ? previousRounds + (sameFixRevision ? 0 : 1) : 0;
  const uncertain = findings.some(
    finding => isOpen(finding) && finding.material && finding.origin === 'uncertain'
  );
  return parseReviewState({
    schemaVersion: 1,
    revision: (previous?.revision ?? 0) + 1,
    snapshot: reviewIdentity(snapshot),
    configurationHash,
    operationKey,
    completedReviews: (previous?.completedReviews ?? 0) + 1,
    reviewMode: snapshot.mode,
    fallbackReason: snapshot.fallbackReason,
    coverageNotes: result.coverageNotes,
    actionableRounds,
    needsHuman: uncertain || actionableRounds >= maxRounds,
    nextFindingId,
    findings,
    intervention: intervention ?? previous?.intervention ?? null,
  });
}

function display(value: string): string {
  return value
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n]+/g, ' ');
}

export function renderIncompleteReview(
  snapshot: ReviewSnapshot,
  rawResult: unknown,
  checkpoint: ReviewState | null
): string {
  const result = parseReviewSubmission(rawResult);
  if (result.coverage !== 'incomplete') {
    throw new Error('An incomplete report requires incomplete coverage.');
  }
  const lines = [
    '## Incomplete review',
    `Attempted head: \`${snapshot.headSha}\`; target tip: \`${snapshot.baseSha}\`; merge-base: \`${snapshot.mergeBaseSha}\`.`,
    `Coverage gap: ${display(result.coverageNotes)}`,
    checkpoint
      ? `Successful checkpoint remains revision ${checkpoint.revision} at \`${checkpoint.snapshot.headSha}\`.`
      : 'No successful checkpoint exists; none was created.',
    'No finding disposition, review counter, or escalation state was changed. This is not a clean review or an approval.',
    '',
    '## Uncommitted evidence candidates',
  ];
  if (!result.findings.length) {
    lines.push('No candidates were submitted; incomplete coverage is not evidence of no defects.');
  }
  result.findings.forEach((finding, index) => {
    lines.push(
      '',
      `### Candidate ${index + 1}: ${display(finding.rootCause)}`,
      `- Claimed ID: ${display(finding.id ?? '(unassigned)')}; origin: ${finding.origin}; lifecycle claim: ${finding.lifecycle}.`,
      `- Location: ${display(finding.location)}`,
      `- Evidence: ${display(finding.evidence)}`,
      `- Origin evidence: ${display(finding.originEvidence)}`,
      `- Disposition claim (not applied): ${display(finding.dispositionReason || '(none)')}`
    );
  });
  lines.push('', 'INCOMPLETE: coverage gap remains; successful review state was not advanced.');
  const body = lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') > 60_000) {
    throw new Error(
      'Incomplete review report exceeds the output budget. Shorten the reason/candidate evidence and resubmit with coverage=incomplete; checkpoint unchanged.'
    );
  }
  return body;
}

export function renderReviewComment(state: ReviewState): string {
  parseReviewState(state);
  const blockers = state.findings.filter(isBlocker);
  const observations = state.findings.filter(finding => isOpen(finding) && !isBlocker(finding));
  const lines = [
    REVIEW_STATE_MARKER,
    '## Findings',
    `${blockers.length} material PR regression(s); ${observations.length} non-blocking observation(s).`,
    `Reviewed head: \`${state.snapshot.headSha}\`; base: \`${state.snapshot.baseSha}\`.`,
    `Completed review ${state.completedReviews}; active review/fix round ${state.actionableRounds}.`,
    `Mode: ${state.reviewMode}${state.fallbackReason ? ` (${display(state.fallbackReason)})` : ''}.`,
    `Coverage: ${display(state.coverageNotes)}`,
  ];
  for (const finding of [...blockers, ...observations]) {
    lines.push(
      '',
      `### ${finding.id}: ${display(finding.rootCause)}`,
      `- Origin: ${finding.origin}; lifecycle: ${finding.lifecycle}`,
      `- Location: ${display(finding.location)}`,
      `- Evidence: ${display(finding.evidence)}`,
      `- Origin evidence: ${display(finding.originEvidence)}`
    );
  }
  lines.push('', '## Notes');
  for (const finding of state.findings.filter(finding => !isOpen(finding))) {
    lines.push(`- ${finding.id}: ${finding.lifecycle}. ${display(finding.dispositionReason)}`);
  }
  if (state.intervention) {
    lines.push(
      `- Human intervention by ${display(state.intervention.actor)}: ${state.intervention.control}. ${display(state.intervention.reason)}`
    );
  }
  lines.push('', '## Review Outcome');
  lines.push(
    state.needsHuman
      ? 'NEEDS_HUMAN: reassess unresolved review/fix churn or uncertain material origin; automatic review is paused.'
      : blockers.length
        ? 'FINDINGS: material PR regressions remain unresolved.'
        : 'PASS: no material PR regressions found.'
  );
  lines.push(
    '',
    `${STATE_PREFIX}${Buffer.from(JSON.stringify(state), 'utf8').toString('base64')} -->`
  );
  const body = lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') > 60_000) {
    throw new Error(
      'Canonical review state exceeds the comment budget; human recovery is required.'
    );
  }
  return body;
}
