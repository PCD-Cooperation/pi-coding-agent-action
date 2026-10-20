import { parseReviewSubmission } from './submission';
import { reviewHash } from './state';
import { followUpWorkDefinition } from './work-plan';
import { parseReviewFollowUps, parseReviewUnitResult } from './work-submission';
import type { ReviewWorkEntry, ReviewWorkState, ReviewSynthesisResult } from './work-types';

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))
  ) {
    throw new Error('Invalid coverage work record shape');
  }
  return value as Record<string, unknown>;
}

function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function parseReviewWorkState(value: unknown): ReviewWorkState {
  const data = object(value, [
    'version',
    'fingerprint',
    'revision',
    'phase',
    'reviewHash',
    'entries',
  ]);
  if (
    data.version !== 1 ||
    !hash(data.fingerprint) ||
    !Number.isSafeInteger(data.revision) ||
    (data.revision as number) < 1 ||
    typeof data.phase !== 'string' ||
    !['collecting', 'ready'].includes(data.phase) ||
    (data.reviewHash !== null && !hash(data.reviewHash)) ||
    !Array.isArray(data.entries) ||
    data.entries.length > 97
  ) {
    throw new Error('Invalid coverage work record');
  }
  const entries: ReviewWorkEntry[] = [];
  const ids = new Set<string>();
  for (const raw of data.entries) {
    const entry = object(raw, ['id', 'kind', 'status', 'attempts', 'data']);
    if (
      !hash(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.kind !== 'string' ||
      !['unit', 'synthesis'].includes(entry.kind) ||
      typeof entry.status !== 'string' ||
      !['pending', 'running', 'reviewed', 'partial', 'blocked', 'failed'].includes(entry.status) ||
      !Number.isSafeInteger(entry.attempts) ||
      (entry.attempts as number) < 0 ||
      (entry.status === 'reviewed' && (entry.attempts as number) < 1)
    ) {
      throw new Error('Invalid coverage work entry');
    }
    ids.add(entry.id);
    let result: ReviewWorkEntry['data'] = null;
    if (entry.data !== null) {
      const captured = object(entry.data, ['kind', 'result']);
      if (captured.kind !== entry.kind || Buffer.byteLength(JSON.stringify(captured)) > 64 * 1024) {
        throw new Error('Invalid coverage result envelope');
      }
      if (captured.kind === 'unit') {
        const unitResult = parseReviewUnitResult(captured.result);
        if (
          unitResult.unitId !== entry.id ||
          (entry.status === 'reviewed' && unitResult.status !== 'reviewed')
        ) {
          throw new Error('Coverage unit result identity mismatch');
        }
        result = { kind: 'unit', result: unitResult };
      } else {
        const synthesis = object(captured.result, ['review', 'followUps']);
        const review = synthesis.review === null ? null : parseReviewSubmission(synthesis.review);
        if (review?.findings.some(finding => finding.lifecycle === 'risk_accepted')) {
          throw new Error('Coverage synthesis cannot accept risk');
        }
        if (
          !Array.isArray(synthesis.followUps) ||
          synthesis.followUps.length > 96 ||
          Buffer.byteLength(JSON.stringify(synthesis.followUps)) > 16 * 1024
        ) {
          throw new Error('Invalid durable follow-up inventory');
        }
        const followUps = [];
        for (let i = 0; i < synthesis.followUps.length; i += 8) {
          followUps.push(...parseReviewFollowUps(synthesis.followUps.slice(i, i + 8)));
        }
        result = { kind: 'synthesis', result: { review, followUps } };
      }
    }
    if (entry.status === 'reviewed' && !result) {
      throw new Error('Reviewed coverage entry has no evidence');
    }
    entries.push({
      id: entry.id,
      kind: entry.kind as ReviewWorkEntry['kind'],
      status: entry.status as ReviewWorkEntry['status'],
      attempts: entry.attempts as number,
      data: result,
    });
  }
  const synthesis = entries.filter(entry => entry.kind === 'synthesis');
  if (synthesis.length !== 1 || entries.filter(entry => entry.kind === 'unit').length > 96) {
    throw new Error('Coverage work inventory exceeds unit/synthesis bounds');
  }
  if (data.phase === 'ready') {
    const result = synthesis[0]?.data?.result as ReviewSynthesisResult | undefined;
    if (
      !data.reviewHash ||
      entries.some(entry => entry.kind === 'unit' && entry.status !== 'reviewed') ||
      synthesis[0]?.status !== 'reviewed' ||
      result?.review?.coverage !== 'complete' ||
      result.followUps.some(
        request =>
          !(['full', 'incremental'] as const).some(basis =>
            entries.some(
              entry =>
                entry.id === followUpWorkDefinition(request, basis).id &&
                entry.kind === 'unit' &&
                entry.status === 'reviewed'
            )
          )
      ) ||
      reviewHash(result.review) !== data.reviewHash
    ) {
      throw new Error('Coverage completion gate is not satisfied');
    }
  } else if (data.reviewHash !== null) {
    throw new Error('Unfinished work cannot have a completed review hash');
  }
  return structuredClone({
    version: 1,
    fingerprint: data.fingerprint,
    revision: data.revision,
    phase: data.phase,
    reviewHash: data.reviewHash,
    entries,
  }) as ReviewWorkState;
}
