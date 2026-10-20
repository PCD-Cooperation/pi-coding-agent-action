import type { FindingInput, ReviewIdentity, ReviewSubmission } from './types';

export interface ReviewChangedHunk {
  index: number;
  patchStartLine: number;
  patchEndLine: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface ReviewChangedFile {
  id: string;
  path: string;
  previousPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed';
  oldBlob: string | null;
  newBlob: string | null;
  oldMode: string | null;
  newMode: string | null;
  binary: boolean;
  patchBytes: number;
  patchPath: string;
  hunks: ReviewChangedHunk[];
}

export interface ReviewCoverageInventory {
  version: 1;
  identity: ReviewIdentity;
  previousHeadSha: string | null;
  full: ReviewChangedFile[];
  incremental: ReviewChangedFile[] | null;
}

export interface ReviewWorkSpan {
  id: string;
  fileId: string;
  path: string;
  previousPath: string | null;
  status: ReviewChangedFile['status'];
  binary: boolean;
  oldBlob: string | null;
  newBlob: string | null;
  oldMode?: string | null;
  newMode?: string | null;
  patchPath: string;
  patchStartByte?: number;
  patchEndByte?: number;
  partialLine?: boolean;
  patchStartLine: number;
  patchEndLine: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface ReviewWorkUnit {
  id: string;
  kind: 'diff' | 'followup' | 'reconcile';
  basis: 'full' | 'incremental';
  question: string;
  paths: string[];
  spans: ReviewWorkSpan[];
  findingIds: string[];
}

export interface ReviewWorkFollowUp {
  paths: string[];
  question: string;
}

export interface ReviewUnitResult {
  unitId: string;
  status: 'reviewed' | 'partial' | 'blocked' | 'failed';
  coveredSpanIds: string[];
  reconciledFindingIds: string[];
  assessment: string;
  limitations: string[];
  findings: FindingInput[];
  followUps: ReviewWorkFollowUp[];
}

export interface ReviewSynthesisResult {
  review: ReviewSubmission | null;
  followUps: ReviewWorkFollowUp[];
}

export type ReviewWorkData =
  { kind: 'unit'; result: ReviewUnitResult } | { kind: 'synthesis'; result: ReviewSynthesisResult };

export interface ReviewWorkEntry {
  id: string;
  kind: 'unit' | 'synthesis';
  status: 'pending' | 'running' | 'reviewed' | 'partial' | 'blocked' | 'failed';
  attempts: number;
  data: ReviewWorkData | null;
}

export interface ReviewWorkState {
  version: 1;
  fingerprint: string;
  revision: number;
  phase: 'collecting' | 'ready';
  reviewHash: string | null;
  entries: ReviewWorkEntry[];
}

export interface ReviewWorkRecord {
  commentId: number;
  body: string;
  state: ReviewWorkState;
}

export interface ReviewWorkStore {
  load(signal?: AbortSignal): Promise<ReviewWorkRecord | null>;
  save(
    expected: ReviewWorkRecord | null,
    state: ReviewWorkState,
    signal?: AbortSignal
  ): Promise<ReviewWorkRecord>;
}

export interface ReviewCoverageOptions {
  concurrency: number;
  maxUnits: number;
  maxAttempts: number;
  unitTimeoutMs: number;
  runTimeoutMs: number;
  synthesisReserveMs: number;
  maxSynthesisAttempts: number;
  maxUnitBytes: number;
  maxUnitLines: number;
  maxUnitFiles: number;
  maxUnitSpans: number;
}
