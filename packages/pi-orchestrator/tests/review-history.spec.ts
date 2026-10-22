import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  appendReviewHistory,
  reviewHistoryParent,
  reviewParentDescriptor,
} from '../src/review/history';
import { advanceReview, parseReviewComment, renderReviewComment } from '../src/review/state';
import type { ReviewSnapshot } from '../src/review/types';

const snapshot: ReviewSnapshot = {
  repository: 'owner/repo',
  pullNumber: 1,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  mergeBaseSha: 'c'.repeat(40),
  baseRef: 'main',
  intentHash: 'd'.repeat(64),
  mode: 'full',
  fallbackReason: null,
  headPath: '/H',
  basePath: '/M',
  previousPath: null,
  fullDiffPath: '/full.diff',
  incrementalDiffPath: null,
};
const result = {
  coverage: 'complete',
  coverageNotes: 'Pinned static review complete.',
  findings: [],
};
function first() {
  return advanceReview(null, snapshot, result, '1'.repeat(64), '2'.repeat(64), 0);
}

describe('append-only review links', () => {
  it('preserves legacy rendering and embeds a versioned new root without changing the state schema', () => {
    const state = first();
    const legacy = renderReviewComment(state);
    expect(reviewHistoryParent(legacy)).toBeUndefined();
    const root = renderReviewComment(state, null);
    expect(reviewHistoryParent(root)).toBeNull();
    expect(parseReviewComment(root)).toEqual(state);
    expect(parseReviewComment(legacy)).toEqual(state);
  });

  it('binds the exact previous comment body and identity while keeping the canonical payload parseable', () => {
    const state = first();
    const record = { commentId: 42, body: renderReviewComment(state, null), state };
    const next = advanceReview(
      state,
      { ...snapshot, headSha: 'e'.repeat(40) },
      result,
      '1'.repeat(64),
      '3'.repeat(64),
      0
    );
    const child = renderReviewComment(next, record);
    expect(reviewHistoryParent(child)).toEqual({
      commentId: 42,
      revision: 1,
      operationKey: state.operationKey,
      bodyHash: createHash('sha256').update(record.body).digest('hex'),
    });
    expect(parseReviewComment(child)).toEqual(next);
    expect(child).toContain('[revision 1](#issuecomment-42)');
    expect(reviewParentDescriptor(record).bodyHash).not.toBe(
      reviewParentDescriptor({ ...record, body: record.body + '\n' }).bodyHash
    );
  });

  it.each(['bad-json', 'extra-field', 'bad-id', 'bad-version', 'duplicate', 'moved'])(
    'rejects malformed %s parent metadata',
    kind => {
      const original = renderReviewComment(first(), null);
      const match = /<!-- pi-stateful-review-parent:v1:([A-Za-z0-9+/=]+) -->/.exec(original)!;
      let replacement = match[0];
      if (kind === 'duplicate') {
        replacement += '\n' + replacement;
      } else if (kind === 'moved') {
        replacement += '\nUnexpected text';
      } else {
        const value =
          kind === 'extra-field'
            ? { version: 1, parent: null, extra: true }
            : kind === 'bad-id'
              ? {
                  version: 1,
                  parent: {
                    commentId: 0,
                    revision: 1,
                    bodyHash: '0'.repeat(64),
                    operationKey: '0'.repeat(64),
                  },
                }
              : kind === 'bad-version'
                ? { version: 2, parent: null }
                : undefined;
        const bytes = value ? JSON.stringify(value) : '{';
        replacement = `<!-- pi-stateful-review-parent:v1:${Buffer.from(bytes).toString('base64')} -->`;
      }
      expect(() => reviewHistoryParent(original.replace(match[0], replacement))).toThrow(
        'Invalid review history link'
      );
    }
  );

  it('counts link metadata against the complete comment budget before capture', () => {
    const legacy = renderReviewComment(first());
    const padded = legacy.replace(
      '## Findings',
      'x'.repeat(59_999 - Buffer.byteLength(legacy)) + '## Findings'
    );
    expect(Buffer.byteLength(padded)).toBe(59_999);
    expect(() => appendReviewHistory(padded, null)).toThrow('comment budget');
  });
});
