export type FindingOrigin =
  'pr_introduced' | 'pre_existing' | 'pre_existing_worsened' | 'uncertain';
export type FindingLifecycle = 'open' | 'fixed' | 'refuted' | 'risk_accepted' | 'reintroduced';
export type ReviewControl = 'none' | 'bootstrap' | 'resume' | 'full';

export interface ReviewIdentity {
  repository: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  baseRef: string;
  intentHash: string;
}

export interface ReviewSnapshot extends ReviewIdentity {
  mode: 'full' | 'incremental';
  fallbackReason: string | null;
  headPath: string;
  basePath: string;
  previousPath: string | null;
  fullDiffPath: string;
  incrementalDiffPath: string | null;
}

export interface FindingInput {
  id: string | null;
  rootCause: string;
  origin: FindingOrigin;
  lifecycle: FindingLifecycle;
  material: boolean;
  location: string;
  evidence: string;
  originEvidence: string;
  dispositionReason: string;
}

export interface ReviewSubmission {
  coverage: 'complete' | 'incomplete';
  coverageNotes: string;
  findings: FindingInput[];
}

export interface ReviewFinding extends Omit<FindingInput, 'id'> {
  id: string;
  firstReportedHead: string;
}

export interface ReviewState {
  schemaVersion: 1;
  revision: number;
  snapshot: ReviewIdentity;
  configurationHash: string;
  operationKey: string;
  completedReviews: number;
  reviewMode: 'full' | 'incremental';
  fallbackReason: string | null;
  coverageNotes: string;
  actionableRounds: number;
  needsHuman: boolean;
  nextFindingId: number;
  findings: ReviewFinding[];
  intervention: { actor: string; control: ReviewControl; reason: string } | null;
}

export interface ReviewStateRecord {
  commentId: number;
  body: string;
  state: ReviewState;
}

export interface StatefulReviewPlatform {
  loadState(): Promise<ReviewStateRecord | null>;
  snapshot(previous: ReviewState | null): Promise<ReviewSnapshot>;
  authorizeControl(): Promise<void>;
  publish(
    expected: ReviewStateRecord | null,
    snapshot: ReviewSnapshot,
    state: ReviewState,
    body: string
  ): Promise<void>;
}
