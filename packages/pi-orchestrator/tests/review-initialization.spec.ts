import { describe, expect, it, vi } from 'vitest';
import { prepareReview } from '../src/review/runner';
import type { PlatformProvider } from '../src/platform';
import type { PiConfig } from '../src/types';
import type { ReviewSnapshot, ReviewStateRecord } from '../src/review/types';

vi.mock('../src/review/dependencies', () => ({
  prepareReviewDependencies: vi.fn(async () => ({
    policyVersion: 1,
    complete: true,
    contexts: [],
  })),
}));

function fixture() {
  const snapshot: ReviewSnapshot = {
    repository: 'owner/repo',
    pullNumber: 1,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    mergeBaseSha: 'c'.repeat(40),
    baseRef: 'main',
    intentHash: 'intent',
    mode: 'full',
    fallbackReason: null,
    headPath: '/head',
    basePath: '/base',
    previousPath: null,
    fullDiffPath: '/diff',
    incrementalDiffPath: null,
  };
  const context = {
    eventName: 'pull_request_target',
    payload: { action: 'ready_for_review' },
    runAttempt: 1,
  };
  const platform = {
    loadState: vi.fn(async (): Promise<ReviewStateRecord | null> => null),
    canInitializeFromDraft: vi.fn(async () => true),
    snapshot: vi.fn(async () => snapshot),
    authorizeControl: vi.fn(),
    publish: vi.fn(),
  };
  const provider = {
    type: 'github',
    statefulReview: platform,
    getContext: () => context,
  } as unknown as PlatformProvider;
  const config = { cwd: '/nonexistent-review-policy', reviewControl: 'none' } as PiConfig;
  return { platform, provider, context, config };
}

describe('static review coverage guidance', () => {
  it('separates deployment prerequisites without waiving security or incomplete evidence', async () => {
    const f = fixture();
    const { prompt } = await prepareReview(f.provider, f.config, 'Review');
    expect(prompt).toContain('A breaking-change label or PR intent never waives authorization');
    expect(prompt).toContain('Never certify readiness or waive a hold');
    expect(prompt).toContain('basePath is the historical merge-base M');
    expect(prompt).toContain('targetPath, when present, is the actual target-ref tip B');
    expect(prompt).toContain('Ordinary none does not universally require manual bootstrap');
    expect(prompt).toContain(
      'Missing external source requires incomplete coverage when a material implementation decision'
    );
    expect(prompt).toContain('The host reports it as non-passing without advancing the checkpoint');
  });
});

describe('automatic first draft readiness initialization', () => {
  it('initializes with control none only after provider proof', async () => {
    const f = fixture();
    const result = await prepareReview(f.provider, f.config, 'Review');
    expect(result.previous).toBeNull();
    expect(result.intervention).toBeNull();
    expect(f.platform.canInitializeFromDraft).toHaveBeenCalledOnce();
    expect(f.platform.snapshot).toHaveBeenCalledWith(null);
    expect(f.platform.authorizeControl).not.toHaveBeenCalled();
  });
  it.each(['rerun', 'manual', 'wrong action', 'resume', 'full', 'missing proof', 'negative proof'])(
    'does not infer missing history for %s',
    async change => {
      const f = fixture();
      if (change === 'rerun') {
        f.context.runAttempt = 2;
      }
      if (change === 'manual') {
        f.context.eventName = 'workflow_dispatch';
      }
      if (change === 'wrong action') {
        f.context.payload.action = 'synchronize';
      }
      if (change === 'resume' || change === 'full') {
        f.config.reviewControl = change;
        f.config.reviewControlReason = 'Authorized intervention';
      }
      if (change === 'missing proof') {
        delete f.provider.statefulReview!.canInitializeFromDraft;
      }
      if (change === 'negative proof') {
        f.platform.canInitializeFromDraft.mockResolvedValue(false);
      }
      await expect(prepareReview(f.provider, f.config, 'Review')).rejects.toThrow('checkpoint');
      expect(f.platform.snapshot).not.toHaveBeenCalled();
      if (!['missing proof', 'negative proof'].includes(change)) {
        expect(f.platform.canInitializeFromDraft).not.toHaveBeenCalled();
      }
    }
  );
  it.each(['corrupt', 'duplicate'])('never bypasses %s ledger errors', async error => {
    const f = fixture();
    f.platform.loadState.mockRejectedValue(new Error(error));
    await expect(prepareReview(f.provider, f.config, 'Review')).rejects.toThrow(error);
    expect(f.platform.canInitializeFromDraft).not.toHaveBeenCalled();
    expect(f.platform.snapshot).not.toHaveBeenCalled();
  });
  it('preserves a paused existing checkpoint without consulting readiness proof', async () => {
    const f = fixture();
    const state = {
      schemaVersion: 1,
      revision: 7,
      snapshot: await f.platform.snapshot(),
      configurationHash: 'old',
      operationKey: 'old',
      completedReviews: 6,
      reviewMode: 'full',
      fallbackReason: null,
      coverageNotes: '',
      actionableRounds: 3,
      needsHuman: true,
      nextFindingId: 12,
      findings: [],
      intervention: null,
    } as const;
    const record = { commentId: 42, body: 'ledger', state } as unknown as ReviewStateRecord;
    f.platform.loadState.mockResolvedValue(record);
    const result = await prepareReview(f.provider, f.config, 'Review');
    expect(result.previous).toBe(record);
    expect(result.skip).toBe('needs_human');
    expect(f.platform.canInitializeFromDraft).not.toHaveBeenCalled();
    expect(f.platform.snapshot).toHaveBeenLastCalledWith(record.state);
    expect(record.state.revision).toBe(7);
    expect(record.state.nextFindingId).toBe(12);
  });
  it.each(['opened', 'bootstrap'])('preserves existing %s initialization behavior', async mode => {
    const f = fixture();
    if (mode === 'opened') {
      f.context.payload.action = 'opened';
    } else {
      f.config.reviewControl = 'bootstrap';
      f.config.reviewControlReason = 'Initialize explicitly';
    }
    await prepareReview(f.provider, f.config, 'Review');
    expect(f.platform.canInitializeFromDraft).not.toHaveBeenCalled();
    expect(f.platform.snapshot).toHaveBeenCalledWith(null);
  });
});
