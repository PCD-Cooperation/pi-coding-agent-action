import { describe, expect, test } from 'vitest';
import {
  advanceReview,
  isBlocker,
  parseReviewComment,
  parseReviewState,
  renderReviewComment,
  renderIncompleteReview,
  reviewHash,
} from '../src/review/state';
import type {
  FindingInput,
  ReviewSnapshot,
  ReviewState,
  ReviewSubmission,
} from '../src/review/types';

export const snapshot: ReviewSnapshot = {
  repository: 'owner/repo',
  pullNumber: 1,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  mergeBaseSha: 'c'.repeat(40),
  baseRef: 'main',
  intentHash: reviewHash('intent'),
  mode: 'full',
  fallbackReason: null,
  headPath: '/tmp/head',
  basePath: '/tmp/base',
  previousPath: null,
  fullDiffPath: '/tmp/pr.diff',
  incrementalDiffPath: null,
};

export function finding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    id: null,
    rootCause: 'Unstable purchase idempotency',
    origin: 'pr_introduced',
    lifecycle: 'open',
    material: true,
    location: 'service.py:12',
    evidence: 'The retry creates another payment.',
    originEvidence: 'Base used a stable key; head generates a new key.',
    dispositionReason: '',
    ...overrides,
  };
}

export function submission(findings: FindingInput[] = []): ReviewSubmission {
  return {
    coverage: 'complete',
    coverageNotes: 'Inspected pinned diff and affected callers.',
    findings,
  };
}

function advance(previous: ReviewState | null, findings: FindingInput[], head = 'a'): ReviewState {
  return advanceReview(
    previous,
    { ...snapshot, headSha: head.repeat(40) },
    submission(findings),
    reviewHash('config'),
    reviewHash(head),
    3
  );
}

describe('stateful finding ledger', () => {
  test('assigns durable IDs and separates origin from lifecycle', () => {
    const first = advance(null, [finding()]);
    const second = advance(
      first,
      [finding({ id: 'F1', lifecycle: 'fixed', dispositionReason: 'Stable key restored.' })],
      'd'
    );
    expect(second.findings[0]).toMatchObject({
      id: 'F1',
      firstReportedHead: snapshot.headSha,
      origin: 'pr_introduced',
      lifecycle: 'fixed',
    });
    expect(second.actionableRounds).toBe(0);
    expect(parseReviewComment(renderReviewComment(second))).toEqual(second);
    expect(second.snapshot).not.toHaveProperty('headPath');
  });

  test('unaffected preexisting findings never consume the blocker budget', () => {
    const state = advance(null, [finding({ origin: 'pre_existing' })]);
    expect(state.actionableRounds).toBe(0);
    expect(isBlocker(state.findings[0]!)).toBe(false);
    expect(renderReviewComment(state)).toContain('0 material PR regression(s); 1 non-blocking');
  });

  test('a PR worsening preexisting behavior remains actionable', () => {
    expect(advance(null, [finding({ origin: 'pre_existing_worsened' })]).actionableRounds).toBe(1);
  });

  test('omitting an open finding cannot implicitly resolve it', () => {
    const state = advance(null, [finding()]);
    expect(() => advance(state, [], 'd')).toThrow('Missing explicit reconciliation of F1');
  });

  test('rechecking one fix revision after base movement does not consume a round', () => {
    const state = advance(null, [finding()]);
    const next = advanceReview(
      state,
      { ...snapshot, baseSha: 'd'.repeat(40) },
      submission([finding({ id: 'F1' })]),
      reviewHash('config'),
      reviewHash('base moved'),
      3
    );
    expect(next.completedReviews).toBe(2);
    expect(next.actionableRounds).toBe(1);
  });

  test('untrusted text cannot insert canonical payload delimiters into rendered prose', () => {
    const state = advance(null, [finding({ rootCause: '<!-- pi-stateful-review-data:fake -->' })]);
    const body = renderReviewComment(state);
    expect(parseReviewComment(body)).toEqual(state);
    expect(body).toContain('&lt;!-- pi-stateful-review-data:fake --&gt;');
  });

  test('closed findings survive omission and retain their IDs', () => {
    const first = advance(null, [finding()]);
    const fixed = advance(
      first,
      [finding({ id: 'F1', lifecycle: 'fixed', dispositionReason: 'Fixed.' })],
      'd'
    );
    const next = advance(fixed, [], 'e');
    expect(next.findings).toEqual(fixed.findings);
    expect(next.nextFindingId).toBe(2);
  });

  test('root-cause duplicates and unknown IDs are rejected', () => {
    const first = advance(null, [finding()]);
    expect(() => advance(first, [finding({ id: 'F1' }), finding()], 'd')).toThrow(
      'Duplicate root cause'
    );
    expect(() => advance(first, [finding({ id: 'F9' })], 'd')).toThrow('Unknown or duplicate');
  });

  test('a closed finding must explicitly be reintroduced', () => {
    const first = advance(null, [finding()]);
    const fixed = advance(
      first,
      [finding({ id: 'F1', lifecycle: 'fixed', dispositionReason: 'Fixed.' })],
      'd'
    );
    expect(() =>
      advance(fixed, [finding({ id: 'F1', dispositionReason: 'Fix undone.' })], 'e')
    ).toThrow('must be classified as reintroduced');
    const reopened = advance(
      fixed,
      [finding({ id: 'F1', lifecycle: 'reintroduced', dispositionReason: 'Fix undone.' })],
      'e'
    );
    expect(reopened.findings[0]!.id).toBe('F1');
  });

  test('the model cannot accept risk', () => {
    const first = advance(null, [finding()]);
    expect(() =>
      advance(
        first,
        [finding({ id: 'F1', lifecycle: 'risk_accepted', dispositionReason: 'Accept it.' })],
        'd'
      )
    ).toThrow('cannot accept risk');
  });

  test('incomplete summaries preserve candidate evidence without a canonical marker or clean decision', () => {
    const prior = advance(null, [finding()]);
    const before = structuredClone(prior);
    const result = {
      ...submission([
        finding({ id: 'F1', lifecycle: 'fixed', dispositionReason: 'Unverified claim.' }),
      ]),
      coverage: 'incomplete' as const,
      coverageNotes: 'Missing external source.',
    };
    const body = renderIncompleteReview(snapshot, result, prior);
    expect(body).toContain('Missing external source.');
    expect(body).toContain('Successful checkpoint remains revision 1');
    expect(body).toContain('Disposition claim (not applied): Unverified claim.');
    expect(body).toContain(result.findings[0]!.evidence);
    expect(body).not.toContain('<!-- pi-stateful-review:v1 -->');
    expect(body).not.toContain('PASS:');
    expect(prior).toEqual(before);
    expect(renderIncompleteReview(snapshot, { ...result, findings: [] }, null)).toContain(
      'none was created'
    );
  });

  test('incomplete coverage never advances the checkpoint', () => {
    expect(() =>
      advanceReview(
        null,
        snapshot,
        { ...submission(), coverage: 'incomplete' },
        reviewHash('c'),
        reviewHash('o'),
        3
      )
    ).toThrow('Incomplete review');
  });

  test('three actionable rounds pause review and only authorized resume input permits continuation', () => {
    const one = advance(null, [finding()]);
    const two = advance(one, [finding({ id: 'F1' })], 'd');
    const three = advance(two, [finding({ id: 'F1' })], 'e');
    expect(three.needsHuman).toBe(true);
    expect(() => advance(three, [finding({ id: 'F1' })], 'f')).toThrow('Human reassessment');
    const resumed = advanceReview(
      three,
      snapshot,
      submission([finding({ id: 'F1' })]),
      reviewHash('c'),
      reviewHash('resume'),
      3,
      { actor: 'maintainer', control: 'resume', reason: 'Reassessed the retry contract.' }
    );
    expect(resumed.completedReviews).toBe(4);
    expect(resumed.actionableRounds).toBe(1);
    expect(resumed.needsHuman).toBe(false);
  });

  test('force-pushing back to an earlier head counts as another fix attempt, not a retry', () => {
    const one = advance(null, [finding()], 'a');
    const two = advance(one, [finding({ id: 'F1' })], 'd');
    const three = advance(two, [finding({ id: 'F1' })], 'a');
    expect(three.actionableRounds).toBe(3);
    expect(three.needsHuman).toBe(true);
  });

  test('clean reviews do not exhaust a lifetime round allowance', () => {
    let state: ReviewState | null = null;
    for (const head of ['a', 'd', 'e', 'f', 'a']) {
      state = advance(state, [], head);
    }
    expect(state!.completedReviews).toBe(5);
    expect(state!.needsHuman).toBe(false);
  });

  test('material uncertain origin requests human assessment, not a clean decision', () => {
    const state = advance(null, [finding({ origin: 'uncertain' })]);
    expect(state.needsHuman).toBe(true);
    expect(renderReviewComment(state)).toContain('NEEDS_HUMAN');
  });

  test('malformed and inconsistent persisted state is rejected', () => {
    const state = advance(null, [finding()]);
    expect(() => parseReviewState({ ...state, nextFindingId: 1 })).toThrow('Inconsistent');
    expect(() => parseReviewState({ ...state, revision: -1 })).toThrow('Invalid');
    expect(() => parseReviewComment('untrusted comment')).toThrow('Malformed');
  });

  test('oversized ledgers are not silently truncated', () => {
    const state = advance(null, [finding({ evidence: 'a'.repeat(30_000) })]);
    expect(() => renderReviewComment(state)).toThrow('exceeds the comment budget');
  });
});
