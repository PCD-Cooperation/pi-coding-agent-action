import { createHash } from 'node:crypto';
import type { ReviewStateRecord } from './types';

const PREFIX = '<!-- pi-stateful-review-parent:v1:';
const DATA = '<!-- pi-stateful-review-data:';

export interface ReviewHistoryParent {
  commentId: number;
  bodyHash: string;
  revision: number;
  operationKey: string;
}

function fail(): never {
  throw new Error('Invalid review history link; refusing ambiguous or lost history.');
}

function isParent(value: unknown): value is ReviewHistoryParent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    ['commentId', 'bodyHash', 'revision', 'operationKey'].every(key =>
      Object.hasOwn(record, key)
    ) &&
    Number.isSafeInteger(record.commentId) &&
    (record.commentId as number) > 0 &&
    Number.isSafeInteger(record.revision) &&
    (record.revision as number) > 0 &&
    typeof record.bodyHash === 'string' &&
    /^[a-f0-9]{64}$/.test(record.bodyHash) &&
    typeof record.operationKey === 'string' &&
    /^[a-f0-9]{64}$/.test(record.operationKey)
  );
}

export function reviewParentDescriptor(record: ReviewStateRecord): ReviewHistoryParent {
  const parent = {
    commentId: record.commentId,
    bodyHash: createHash('sha256').update(record.body, 'utf8').digest('hex'),
    revision: record.state.revision,
    operationKey: record.state.operationKey,
  };
  if (!isParent(parent)) {
    fail();
  }
  return parent;
}

export function reviewHistoryParent(body: string): ReviewHistoryParent | null | undefined {
  if (Buffer.byteLength(body, 'utf8') > 60_000) {
    fail();
  }
  if (!body.includes(PREFIX)) {
    return undefined;
  }
  if (body.split(PREFIX).length !== 2 || body.split(DATA).length !== 2) {
    fail();
  }
  const metadata = body.slice(body.indexOf(PREFIX), body.indexOf(DATA));
  const encoded = /^<!-- pi-stateful-review-parent:v1:([A-Za-z0-9+/]+={0,2}) -->\n\n$/.exec(
    metadata
  )?.[1];
  if (!encoded) {
    return fail();
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    fail();
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail();
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    record.version !== 1 ||
    !Object.hasOwn(record, 'parent') ||
    JSON.stringify(value) !== bytes.toString('utf8') ||
    (record.parent !== null && !isParent(record.parent))
  ) {
    fail();
  }
  return structuredClone<ReviewHistoryParent | null>(record.parent);
}

export function appendReviewHistory(body: string, previous?: ReviewStateRecord | null): string {
  if (previous === undefined) {
    return body;
  }
  if (
    !body.startsWith('<!-- pi-stateful-review:v1 -->\n') ||
    body.includes(PREFIX) ||
    body.split(DATA).length !== 2
  ) {
    fail();
  }
  const parent = previous ? reviewParentDescriptor(previous) : null;
  const encoded = Buffer.from(JSON.stringify({ version: 1, parent }), 'utf8').toString('base64');
  const note = parent
    ? `Previous completed review: [revision ${parent.revision}](#issuecomment-${parent.commentId}).`
    : 'Review history: first completed review.';
  const result = body.replace(DATA, `${note}\n\n${PREFIX}${encoded} -->\n\n${DATA}`);
  if (Buffer.byteLength(result, 'utf8') > 60_000) {
    throw new Error('Review history exceeds the comment budget; shorten the review and resubmit.');
  }
  return result;
}
