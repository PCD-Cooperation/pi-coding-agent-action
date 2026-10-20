import { describe, expect, it } from 'vitest';
import { parseReviewWorkState } from '../src/review/work-state';
import { reviewHash } from '../src/review/state';
import type { FindingInput, ReviewSubmission } from '../src/review/types';
import type {
  ReviewSynthesisResult,
  ReviewUnitResult,
  ReviewWorkEntry,
  ReviewWorkState,
} from '../src/review/work-types';

function unitEntry(index = 0): ReviewWorkEntry {
  const id = reviewHash(`unit-${index}`);
  return {
    id,
    kind: 'unit',
    status: 'reviewed',
    attempts: 1,
    data: {
      kind: 'unit',
      result: {
        unitId: id,
        status: 'reviewed',
        coveredSpanIds: [reviewHash(`span-${index}`)],
        reconciledFindingIds: [],
        assessment: 'All assigned changes were inspected against pinned source.',
        limitations: [],
        findings: [],
        followUps: [],
      },
    },
  };
}
function ready(): ReviewWorkState {
  const review: ReviewSubmission = {
    coverage: 'complete',
    coverageNotes: 'Complete pinned review.',
    findings: [],
  };
  return {
    version: 1,
    fingerprint: reviewHash('generation'),
    revision: 4,
    phase: 'ready',
    reviewHash: reviewHash(review),
    entries: [
      unitEntry(),
      {
        id: reviewHash('synthesis'),
        kind: 'synthesis',
        status: 'reviewed',
        attempts: 1,
        data: { kind: 'synthesis', result: { review, followUps: [] } },
      },
    ],
  };
}
function collecting(): ReviewWorkState {
  return { ...ready(), phase: 'collecting', reviewHash: null };
}
function result(value: ReviewWorkState): ReviewUnitResult {
  return value.entries.find(entry => entry.kind === 'unit')!.data!.result as ReviewUnitResult;
}
function synthesis(value: ReviewWorkState): ReviewSynthesisResult {
  return value.entries.find(entry => entry.kind === 'synthesis')!.data!
    .result as ReviewSynthesisResult;
}
function finding(lifecycle: FindingInput['lifecycle'] = 'open'): FindingInput {
  return {
    id: 'F1',
    rootCause: 'Wrong eligibility predicate.',
    origin: 'pr_introduced',
    lifecycle,
    material: true,
    location: 'src/eligibility.ts:7',
    evidence: 'Pinned call site passes an unchecked value.',
    originEvidence: 'Pinned baseline guarded that same value.',
    dispositionReason: lifecycle === 'open' ? '' : 'Explicit disposition evidence.',
  };
}

describe('coverage work journal validation', () => {
  it('accepts complete ready claims only with the exact captured review hash and returns independent data', () => {
    const original = ready();
    const parsed = parseReviewWorkState(original);
    expect(parsed).toEqual(original);
    parsed.entries[0]!.attempts++;
    (parsed.entries[0]!.data!.result as ReviewUnitResult).assessment = 'Changed by caller';
    expect(original).toEqual(ready());
    expect(parseReviewWorkState(collecting()).phase).toBe('collecting');
  });

  it('permits pending/running and honestly partial/blocked/failed entries during collection, never as completed coverage', () => {
    for (const status of ['pending', 'running', 'partial', 'blocked', 'failed'] as const) {
      const value = collecting();
      value.entries[0]!.status = status;
      if (status === 'pending' || status === 'running') {
        value.entries[0]!.data = null;
        value.entries[0]!.attempts = status === 'pending' ? 0 : 1;
      } else {
        result(value).status = status;
        result(value).limitations = ['Required evidence is unavailable.'];
      }
      expect(parseReviewWorkState(value).entries[0]!.status).toBe(status);
      value.phase = 'ready';
      value.reviewHash = reviewHash(synthesis(value).review);
      expect(() => parseReviewWorkState(value)).toThrow();
    }
  });

  it.each([
    (value: ReviewWorkState) => {
      value.version = 2 as 1;
    },
    (value: ReviewWorkState) => {
      value.fingerprint = 'unbound';
    },
    (value: ReviewWorkState) => {
      value.revision = 0;
    },
    (value: ReviewWorkState) => {
      value.revision = 1.5;
    },
    (value: ReviewWorkState) => {
      value.revision = Number.MAX_SAFE_INTEGER + 1;
    },
    (value: ReviewWorkState) => {
      value.reviewHash = 'not a hash';
    },
    (value: ReviewWorkState) => {
      value.phase = 'unknown' as 'ready';
    },
    (value: ReviewWorkState) => {
      Object.assign(value, { nextFindingId: 1 });
    },
    (value: ReviewWorkState) => {
      value.entries[0]!.id = 'not a hash';
    },
    (value: ReviewWorkState) => {
      value.entries[0]!.attempts = -1;
    },
    (value: ReviewWorkState) => {
      value.entries[0]!.attempts = Number.NaN;
    },
    (value: ReviewWorkState) => {
      value.entries[0]!.attempts = Number.MAX_SAFE_INTEGER + 1;
    },
    (value: ReviewWorkState) => {
      Object.assign(value.entries[0]!, { cursor: 'not work state' });
    },
    (value: ReviewWorkState) => {
      value.entries.push(structuredClone(value.entries[0]!));
    },
    (value: ReviewWorkState) => {
      value.entries[0]!.kind = 'other' as 'unit';
    },
    (value: ReviewWorkState) => {
      value.entries[0]!.status = 'complete' as 'reviewed';
    },
  ])('rejects malformed journal structure, hashes and counters (%#)', mutate => {
    const value = ready();
    mutate(value);
    expect(() => parseReviewWorkState(value)).toThrow();
  });

  it.each([
    (value: ReviewWorkState) => {
      value.entries[0]!.attempts = 0;
    },
    (value: ReviewWorkState) => {
      value.entries[0]!.data = null;
    },
    (value: ReviewWorkState) => {
      result(value).unitId = reviewHash('another unit');
    },
    (value: ReviewWorkState) => {
      value.entries[0]!.data!.kind = 'synthesis';
    },
    (value: ReviewWorkState) => {
      result(value).status = 'partial';
      result(value).limitations = ['Only part was inspected.'];
    },
    (value: ReviewWorkState) => {
      result(value).limitations = ['Uninspected changes remain.'];
    },
    (value: ReviewWorkState) => {
      result(value).coveredSpanIds.push(result(value).coveredSpanIds[0]!);
    },
    (value: ReviewWorkState) => {
      result(value).assessment = '';
    },
    (value: ReviewWorkState) => {
      Object.assign(result(value), { extraClaim: true });
    },
    (value: ReviewWorkState) => {
      result(value).followUps = [{ paths: ['../outside'], question: 'Inspect' }];
    },
  ])('rejects unsupported reviewed-unit evidence or inconsistent journal claims (%#)', mutate => {
    const value = collecting();
    mutate(value);
    expect(() => parseReviewWorkState(value)).toThrow();
  });

  it.each([
    (value: ReviewWorkState) => {
      value.entries = value.entries.filter(entry => entry.kind !== 'synthesis');
    },
    (value: ReviewWorkState) => {
      synthesis(value).review = null;
    },
    (value: ReviewWorkState) => {
      synthesis(value).review!.coverage = 'incomplete';
      synthesis(value).review!.coverageNotes = 'Evidence still missing.';
      value.reviewHash = reviewHash(synthesis(value).review);
    },
    (value: ReviewWorkState) => {
      value.entries.find(entry => entry.kind === 'synthesis')!.status = 'partial';
    },
    (value: ReviewWorkState) => {
      value.reviewHash = reviewHash('different review');
    },
    (value: ReviewWorkState) => {
      value.reviewHash = null;
    },
    (value: ReviewWorkState) => {
      synthesis(value).review!.coverageNotes = 'Changed after hashing.';
    },
  ])('rejects completion without the exact complete synthesis and completed units (%#)', mutate => {
    const value = ready();
    mutate(value);
    expect(() => parseReviewWorkState(value)).toThrow();
  });

  it('rejects a collecting journal that claims a completed review hash', () => {
    const value = collecting();
    value.reviewHash = ready().reviewHash;
    expect(() => parseReviewWorkState(value)).toThrow();
  });

  it('rejects duplicate synthesis entries even when their IDs differ', () => {
    const value = collecting();
    const another = structuredClone(value.entries.find(entry => entry.kind === 'synthesis')!);
    another.id = reviewHash('another synthesis');
    value.entries.push(another);
    expect(() => parseReviewWorkState(value)).toThrow('synthesis');
  });

  it.each(['unit', 'synthesis'] as const)(
    'never grants risk acceptance to %s model results',
    kind => {
      const value = collecting();
      if (kind === 'unit') {
        result(value).findings = [finding('risk_accepted')];
      } else {
        synthesis(value).review!.findings = [finding('risk_accepted')];
      }
      expect(() => parseReviewWorkState(value)).toThrow(/risk/i);
    }
  );

  it('permits ordinary open/fixed finding evidence without allocating or rewriting canonical IDs', () => {
    const value = ready();
    result(value).findings = [finding('open')];
    synthesis(value).review!.findings = [finding('fixed')];
    value.reviewHash = reviewHash(synthesis(value).review);
    expect(parseReviewWorkState(value)).toEqual(value);
    expect(result(value).findings[0]!.id).toBe('F1');
  });

  it('enforces the worker-result parser at exactly 6 KiB of UTF-8 JSON, not the larger storage envelope limit', () => {
    const value = ready();
    const captured = result(value);
    captured.assessment = '';
    const remaining = 6 * 1024 - Buffer.byteLength(JSON.stringify(captured));
    captured.assessment = 'é'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2);
    expect(Buffer.byteLength(JSON.stringify(captured))).toBe(6 * 1024);
    expect(parseReviewWorkState(value)).toEqual(value);
    captured.assessment += 'é';
    expect(() => parseReviewWorkState(value)).toThrow(/6144/);
  });

  it('bounds synthesis data to 64 KiB before accepting a valid ready hash', () => {
    const value = ready();
    const entry = value.entries.find(entry => entry.kind === 'synthesis')!;
    const review = synthesis(value).review!;
    review.coverageNotes = '';
    review.coverageNotes = 'x'.repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(entry.data)));
    expect(Buffer.byteLength(JSON.stringify(entry.data))).toBe(64 * 1024);
    value.reviewHash = reviewHash(review);
    expect(parseReviewWorkState(value)).toEqual(value);
    review.coverageNotes += 'x';
    value.reviewHash = reviewHash(review);
    expect(() => parseReviewWorkState(value)).toThrow('envelope');
  });

  it('accepts the maximal 96-unit journal plus its single synthesis', () => {
    const value = ready();
    value.entries = [
      ...Array.from({ length: 96 }, (_, index) => unitEntry(index)),
      value.entries[1]!,
    ];
    expect(parseReviewWorkState(value)).toEqual(value);
    value.entries.push(unitEntry(96));
    expect(() => parseReviewWorkState(value)).toThrow();
  });

  it('rejects a 97th unit even when no synthesis entry has been written yet', () => {
    const value = collecting();
    value.entries = Array.from({ length: 97 }, (_, index) => unitEntry(index));
    expect(() => parseReviewWorkState(value)).toThrow();
  });

  it('rejects a ready synthesis that simultaneously leaves required follow-up work outstanding', () => {
    const value = ready();
    synthesis(value).followUps = [
      { paths: ['src/other.ts'], question: 'Check the outstanding integration contract.' },
    ];
    expect(() => parseReviewWorkState(value)).toThrow();
  });
});
