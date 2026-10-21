import { createHash } from 'node:crypto';
import type {
  ReviewWorkData,
  ReviewWorkRecord,
  ReviewWorkState,
  ReviewWorkStore,
} from '@alexanderfortin/pi-orchestrator';
import type { GitHubModuleDeps } from './types';

const PREFIX = '<!-- pi-stateful-review-work:v1 -->';
const BLOB_PREFIX = '<!-- pi-stateful-review-work-evidence:v1 -->';
const LABEL = 'pi-stateful-review:coverage-v1';
const COMMENT_BYTES = 60000;
const INLINE_BYTES = 8 * 1024;
const DATA_BYTES = 64 * 1024;
const PART_BYTES = 18 * 1024;
const API_CALLS = 2500;
const HASH = /^[a-f0-9]{64}$/;
const STATUSES = ['pending', 'running', 'reviewed', 'partial', 'blocked', 'failed'];

type Descriptor = { hash: string; inline: ReviewWorkData } | { hash: string; blobIds: number[] };
type WireEntry = Omit<ReviewWorkState['entries'][number], 'data'> & { data: Descriptor | null };
interface Manifest {
  version: 1;
  repository: string;
  pullNumber: number;
  state: Omit<ReviewWorkState, 'entries'> & { entries: WireEntry[] };
}
interface Part {
  id: string;
  hash: string;
  index: number;
  count: number;
  partHash: string;
  payload: string;
}
interface Blob {
  version: 1;
  repository: string;
  pullNumber: number;
  fingerprint: string;
  parts: Part[];
}
interface Stored {
  record: ReviewWorkRecord;
  manifest: Manifest;
}
interface Comment {
  id: number;
  body?: string | null;
  issue_url?: string;
  user: { login: string; type: string } | null;
}

function fail(): never {
  throw new Error('Review work history missing, corrupt, changed, or ambiguous; refusing reset');
}
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
  );
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function hash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}
function strings(value: unknown, hashes = false): boolean {
  return (
    Array.isArray(value) &&
    value.length <= DATA_BYTES &&
    value.every(item => (hashes ? hash(item) : typeof item === 'string'))
  );
}
function digestCheck(value: unknown): boolean {
  return (
    shape(value, ['manifestPath', 'pointer', 'normalization', 'selection']) &&
    typeof value.manifestPath === 'string' &&
    value.manifestPath.length > 0 &&
    value.manifestPath.length <= 512 &&
    typeof value.pointer === 'string' &&
    value.pointer.length <= 1024 &&
    ['sha256-raw-v1', 'sha256-utf8-lf-v1'].includes(value.normalization as string) &&
    ['changed', 'all'].includes(value.selection as string)
  );
}
function followUps(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= DATA_BYTES &&
    value.every(
      item =>
        (shape(item, ['paths', 'question']) ||
          (shape(item, ['paths', 'question', 'digestCheck']) && digestCheck(item.digestCheck))) &&
        strings(item.paths) &&
        typeof item.question === 'string'
    )
  );
}
function findings(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= DATA_BYTES &&
    value.every(
      item =>
        shape(item, [
          'id',
          'rootCause',
          'origin',
          'lifecycle',
          'material',
          'location',
          'evidence',
          'originEvidence',
          'dispositionReason',
        ]) &&
        (item.id === null || typeof item.id === 'string') &&
        typeof item.origin === 'string' &&
        ['pr_introduced', 'pre_existing', 'pre_existing_worsened', 'uncertain'].includes(
          item.origin
        ) &&
        typeof item.lifecycle === 'string' &&
        ['open', 'fixed', 'refuted', 'risk_accepted', 'reintroduced'].includes(item.lifecycle) &&
        typeof item.material === 'boolean' &&
        ['rootCause', 'location', 'evidence', 'originEvidence', 'dispositionReason'].every(
          key => typeof item[key] === 'string'
        )
    )
  );
}
function data(value: unknown): value is ReviewWorkData {
  if (!shape(value, ['kind', 'result'])) {
    return false;
  }
  const result = value.result;
  if (value.kind === 'unit') {
    return (
      shape(result, [
        'unitId',
        'status',
        'coveredSpanIds',
        'reconciledFindingIds',
        'assessment',
        'limitations',
        'findings',
        'followUps',
      ]) &&
      hash(result.unitId) &&
      typeof result.status === 'string' &&
      STATUSES.slice(2).includes(result.status) &&
      strings(result.coveredSpanIds, true) &&
      strings(result.reconciledFindingIds) &&
      typeof result.assessment === 'string' &&
      strings(result.limitations) &&
      findings(result.findings) &&
      followUps(result.followUps)
    );
  }
  return (
    value.kind === 'synthesis' &&
    shape(result, ['review', 'followUps']) &&
    followUps(result.followUps) &&
    (result.review === null ||
      (shape(result.review, ['coverage', 'coverageNotes', 'findings']) &&
        ['complete', 'incomplete'].includes(result.review.coverage as string) &&
        typeof result.review.coverageNotes === 'string' &&
        findings(result.review.findings)))
  );
}
function json(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    if (typeof result !== 'string') {
      fail();
    }
    return result;
  } catch {
    return fail();
  }
}
function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function clone<T>(value: T): T {
  return JSON.parse(json(value)) as T;
}
function validateState(value: unknown, wire = false): void {
  if (
    !shape(value, ['version', 'fingerprint', 'revision', 'phase', 'reviewHash', 'entries']) ||
    value.version !== 1 ||
    !hash(value.fingerprint) ||
    !positive(value.revision) ||
    !['collecting', 'ready'].includes(value.phase as string) ||
    !(value.reviewHash === null || hash(value.reviewHash)) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 97
  ) {
    fail();
  }
  const ids = new Set<string>();
  let units = 0;
  let syntheses = 0;
  let inlineBytes = 0;
  for (const entry of value.entries) {
    if (
      !shape(entry, ['id', 'kind', 'status', 'attempts', 'data']) ||
      !hash(entry.id) ||
      ids.has(entry.id) ||
      !['unit', 'synthesis'].includes(entry.kind as string) ||
      !STATUSES.includes(entry.status as string) ||
      !Number.isSafeInteger(entry.attempts) ||
      (entry.attempts as number) < 0
    ) {
      fail();
    }
    ids.add(entry.id);
    units += Number(entry.kind === 'unit');
    syntheses += Number(entry.kind === 'synthesis');
    if (entry.data === null) {
      continue;
    }
    let contents: unknown = entry.data;
    if (wire) {
      const item = entry.data;
      if (
        shape(item, ['hash', 'blobIds']) &&
        hash(item.hash) &&
        Array.isArray(item.blobIds) &&
        item.blobIds.length > 0 &&
        item.blobIds.length <= Math.ceil(DATA_BYTES / PART_BYTES) &&
        item.blobIds.every(positive) &&
        new Set(item.blobIds).size === item.blobIds.length
      ) {
        continue;
      }
      if (!shape(item, ['hash', 'inline']) || !hash(item.hash)) {
        fail();
      }
      contents = item.inline;
      const serialized = json(contents);
      inlineBytes += Buffer.byteLength(serialized);
      if (digest(serialized) !== item.hash) {
        fail();
      }
    }
    if (
      !data(contents) ||
      contents.kind !== entry.kind ||
      Buffer.byteLength(json(contents)) > DATA_BYTES
    ) {
      fail();
    }
  }
  if (units > 96 || syntheses > 1 || (wire && inlineBytes > INLINE_BYTES)) {
    fail();
  }
}
function transition(previous: ReviewWorkState | null, next: ReviewWorkState): void {
  if (next.revision !== (previous ? previous.revision + 1 : 1)) {
    fail();
  }
  if (previous?.fingerprint !== next.fingerprint) {
    return;
  }
  for (const old of previous.entries) {
    const current = next.entries.find(entry =>
      old.kind === 'synthesis' ? entry.kind === 'synthesis' : entry.id === old.id
    );
    if (current?.kind !== old.kind || current.attempts < old.attempts) {
      fail();
    }
  }
}
function encode(prefix: string, summary: string, value: unknown): string {
  const body = `${prefix}\n${summary}\n\n<!-- pi-review-work-payload:${Buffer.from(json(value)).toString('base64')} -->`;
  if (Buffer.byteLength(body) > COMMENT_BYTES) {
    throw new Error('Review work exceeds bounded comment capacity');
  }
  return body;
}
function decode(body: string, prefix: string): unknown {
  if (Buffer.byteLength(body) > COMMENT_BYTES || !body.startsWith(`${prefix}\n`)) {
    fail();
  }
  const payload = /\n\n<!-- pi-review-work-payload:([A-Za-z0-9+/]+={0,2}) -->$/.exec(body)?.[1];
  if (!payload) {
    fail();
  }
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.toString('base64') !== payload) {
    fail();
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail();
  }
  if (json(value) !== bytes.toString('utf8')) {
    fail();
  }
  return value;
}
function renderManifest(manifest: Manifest): string {
  const units = manifest.state.entries.filter(entry => entry.kind === 'unit');
  const counts = STATUSES.map(
    status => `${status}: ${units.filter(entry => entry.status === status).length}`
  ).join(', ');
  const synthesis = manifest.state.entries.find(entry => entry.kind === 'synthesis');
  return encode(
    PREFIX,
    `Review coverage work — ${manifest.state.phase}, revision ${manifest.state.revision}.\nUnits — ${counts}. Synthesis: ${synthesis?.status ?? 'not started'}.\nPersisted progress, not live job status or a canonical completion checkpoint.`,
    manifest
  );
}
function renderBlob(blob: Blob): string {
  return encode(
    BLOB_PREFIX,
    `Immutable review coverage evidence: ${blob.parts.length} data part(s). Not a completion checkpoint.`,
    blob
  );
}
function errorStatus(error: unknown): unknown {
  return error && typeof error === 'object' && 'status' in error ? error.status : undefined;
}

// GitHub has no CAS. All cooperating writers must be serialized per PR by the caller.
export function createReviewWorkStore(
  deps: GitHubModuleDeps,
  assertEligible: (signal?: AbortSignal) => Promise<void>
): ReviewWorkStore {
  const { octokit, context } = deps;
  const repo = { ...context.repo };
  const issue_number = context.issue.number;
  const repository = `${repo.owner}/${repo.repo}`;
  let calls = 0;
  let known = false;
  let poisoned = false;
  let eligible = false;
  let cached: Stored | null = null;
  interface RequestOptions {
    timeout: number;
    signal?: AbortSignal;
  }
  let active: { signal: AbortSignal | undefined; writesStarted: boolean } | null = null;
  async function operate<T>(
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
    freshEligibility = false
  ): Promise<T> {
    // A deadline race can finish before an aborted transport settles; never replace its context.
    if (active) {
      fail();
    }
    const operation = { signal, writesStarted: false };
    active = operation;
    try {
      signal?.throwIfAborted();
      // GITHUB_TOKEN quotas are shared; progress reuses admission until a fresh publication load.
      if (freshEligibility || !eligible) {
        eligible = false;
        await assertEligible(signal);
        signal?.throwIfAborted();
        eligible = true;
      }
      signal?.throwIfAborted();
      const result = await action();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (operation.writesStarted) {
        poisoned = true;
      }
      throw error;
    } finally {
      if (active === operation) {
        active = null;
      }
    }
  }
  async function api<T>(
    request: (options: RequestOptions) => Promise<T>,
    writing = false
  ): Promise<T> {
    const operation = active ?? fail();
    const { signal } = operation;
    signal?.throwIfAborted();
    if (calls >= API_CALLS) {
      throw new Error('Review work API call budget exhausted; refusing incomplete verification');
    }
    calls++;
    operation.writesStarted ||= writing;
    try {
      return await request({ timeout: 15000, ...(signal ? { signal } : {}) });
    } finally {
      signal?.throwIfAborted();
      if (active !== operation) {
        fail();
      }
    }
  }
  async function* discover<T>(
    read: (
      page: number,
      request: RequestOptions
    ) => Promise<{ data: T[]; headers?: { link?: string } }>
  ): AsyncGenerator<T> {
    for (let page = 1; page <= 100; page++) {
      const { data, headers } = await api(request => read(page, request));
      if (!Array.isArray(data) || data.length > 100) {
        fail();
      }
      yield* data;
      if (data.length < 100 && !headers?.link?.includes('rel="next"')) {
        return;
      }
    }
    fail();
  }
  function owned(comment: Comment): boolean {
    return comment.user?.login === 'github-actions[bot]' && comment.user.type === 'Bot';
  }
  function associated(comment: Comment): void {
    if (!positive(comment.id) || !owned(comment) || typeof comment.issue_url !== 'string') {
      fail();
    }
    let url: URL;
    try {
      url = new URL(comment.issue_url);
    } catch {
      return fail();
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !url.pathname
        .toLowerCase()
        .endsWith(`/repos/${repository}/issues/${issue_number}`.toLowerCase()) ||
      url.search ||
      url.hash
    ) {
      fail();
    }
  }
  function association(value: Record<string, unknown>): void {
    if (
      value.version !== 1 ||
      value.repository !== repository ||
      value.pullNumber !== issue_number
    ) {
      fail();
    }
  }
  function parseManifest(body: string): Manifest {
    const value = decode(body, PREFIX);
    if (!shape(value, ['version', 'repository', 'pullNumber', 'state'])) {
      fail();
    }
    association(value);
    validateState(value.state, true);
    const manifest = value as unknown as Manifest;
    if (renderManifest(manifest) !== body) {
      fail();
    }
    return manifest;
  }
  function parseBlob(body: string): Blob {
    const value = decode(body, BLOB_PREFIX);
    if (!shape(value, ['version', 'repository', 'pullNumber', 'fingerprint', 'parts'])) {
      fail();
    }
    association(value);
    if (
      !hash(value.fingerprint) ||
      !Array.isArray(value.parts) ||
      !value.parts.length ||
      value.parts.length > 32
    ) {
      fail();
    }
    const identities = new Set<string>();
    let rawBytes = 0;
    for (const part of value.parts) {
      if (
        !shape(part, ['id', 'hash', 'index', 'count', 'partHash', 'payload']) ||
        !hash(part.id) ||
        !hash(part.hash) ||
        !hash(part.partHash) ||
        !positive(part.count) ||
        part.count > Math.ceil(DATA_BYTES / PART_BYTES) ||
        !Number.isSafeInteger(part.index) ||
        (part.index as number) < 0 ||
        (part.index as number) >= part.count ||
        typeof part.payload !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(part.payload)
      ) {
        fail();
      }
      const bytes = Buffer.from(part.payload, 'base64');
      const identity = `${part.id}:${part.index}`;
      if (
        !bytes.length ||
        bytes.length > PART_BYTES ||
        bytes.toString('base64') !== part.payload ||
        digest(bytes) !== part.partHash ||
        identities.has(identity)
      ) {
        fail();
      }
      identities.add(identity);
      rawBytes += bytes.length;
    }
    if (rawBytes > PART_BYTES) {
      fail();
    }
    const blob = value as unknown as Blob;
    if (renderBlob(blob) !== body) {
      fail();
    }
    return blob;
  }
  async function get(id: number): Promise<Comment> {
    const { data: comment } = await api(request =>
      octokit.rest.issues.getComment({ ...repo, comment_id: id, request })
    );
    associated(comment);
    if (comment.id !== id) {
      fail();
    }
    return comment;
  }
  async function resolve(comment: Comment, manifest: Manifest): Promise<Stored> {
    const blobs = new Map<number, Blob>();
    const entries: ReviewWorkState['entries'] = [];
    for (const entry of manifest.state.entries) {
      const descriptor = entry.data;
      let contents: ReviewWorkData | null = null;
      if (descriptor && 'inline' in descriptor) {
        contents = descriptor.inline;
      } else if (descriptor) {
        const buffers: Buffer[] = [];
        for (const [index, id] of descriptor.blobIds.entries()) {
          let blob = blobs.get(id);
          if (!blob) {
            const item = await get(id);
            blob = parseBlob(item.body ?? '');
            blobs.set(id, blob);
          }
          if (blob.fingerprint !== manifest.state.fingerprint) {
            fail();
          }
          const matching = blob.parts.filter(part => part.id === entry.id && part.index === index);
          const part = matching[0];
          if (
            matching.length !== 1 ||
            part?.hash !== descriptor.hash ||
            part.count !== descriptor.blobIds.length
          ) {
            fail();
          }
          buffers.push(Buffer.from(part.payload, 'base64'));
        }
        const bytes = Buffer.concat(buffers);
        if (bytes.length > DATA_BYTES || digest(bytes) !== descriptor.hash) {
          fail();
        }
        try {
          contents = JSON.parse(bytes.toString('utf8')) as ReviewWorkData;
        } catch {
          return fail();
        }
        if (json(contents) !== bytes.toString('utf8')) {
          fail();
        }
      }
      entries.push({ ...entry, data: contents });
    }
    const state: ReviewWorkState = { ...manifest.state, entries };
    validateState(state);
    return { record: { commentId: comment.id, body: comment.body!, state }, manifest };
  }
  async function scanManifest(): Promise<Comment | null> {
    let found: Comment | null = null;
    for await (const comment of discover((page, request) =>
      octokit.rest.issues.listComments({ ...repo, issue_number, per_page: 100, page, request })
    )) {
      if (!owned(comment) || !comment.body?.startsWith(PREFIX)) {
        continue;
      }
      associated(comment);
      if (found) {
        fail();
      }
      parseManifest(comment.body);
      found = comment;
    }
    if (found) {
      known = true;
    } else if (known) {
      fail();
    }
    return found;
  }
  async function tracked(): Promise<boolean> {
    let present = false;
    for await (const label of discover((page, request) =>
      octokit.rest.issues.listLabelsOnIssue({ ...repo, issue_number, per_page: 100, page, request })
    )) {
      if (!label || typeof label.name !== 'string' || !label.name) {
        fail();
      }
      present ||= label.name.toLowerCase() === LABEL;
    }
    return present;
  }
  async function repairLabel(present: boolean): Promise<void> {
    if (present) {
      return;
    }
    try {
      await api(request => octokit.rest.issues.getLabel({ ...repo, name: LABEL, request }));
    } catch (error) {
      if (errorStatus(error) !== 404) {
        throw error;
      }
      try {
        await api(
          request =>
            octokit.rest.issues.createLabel({
              ...repo,
              name: LABEL,
              color: '808080',
              description: 'Persistent review coverage witness; do not delete to reset work.',
              request,
            }),
          true
        );
      } catch {
        await api(request => octokit.rest.issues.getLabel({ ...repo, name: LABEL, request }));
      }
    }
    try {
      await api(
        request =>
          octokit.rest.issues.addLabels({ ...repo, issue_number, labels: [LABEL], request }),
        true
      );
    } catch (error) {
      if (!(await tracked())) {
        throw error;
      }
      return;
    }
    if (!(await tracked())) {
      fail();
    }
  }
  async function load(): Promise<Stored | null> {
    const comment = await scanManifest();
    const present = await tracked();
    if (!comment) {
      if (present) {
        fail();
      }
      cached = null;
      return null;
    }
    const stored = await resolve(comment, parseManifest(comment.body!));
    await repairLabel(present);
    cached = stored;
    return stored;
  }
  async function reconcile(body: string, prefix: string): Promise<Comment> {
    let found: Comment | null = null;
    for await (const comment of discover((page, request) =>
      octokit.rest.issues.listComments({ ...repo, issue_number, per_page: 100, page, request })
    )) {
      if (!owned(comment) || !comment.body?.startsWith(prefix)) {
        continue;
      }
      if (prefix === PREFIX || comment.body === body) {
        associated(comment);
        if (comment.body !== body || found) {
          fail();
        }
        found = comment;
      }
    }
    return found ?? fail();
  }
  async function create(body: string, prefix: string): Promise<Comment> {
    let id: number;
    try {
      const response = await api(
        request => octokit.rest.issues.createComment({ ...repo, issue_number, body, request }),
        true
      );
      id = response.data.id;
    } catch {
      // A lost response is not permission to allocate a replacement comment.
      const committed = await reconcile(body, prefix);
      id = committed.id;
    }
    if (prefix === PREFIX) {
      const committed = await reconcile(body, prefix);
      if (committed.id !== id) {
        fail();
      }
    }
    const actual = await get(id);
    if (actual.body !== body) {
      fail();
    }
    return actual;
  }
  function plan(state: ReviewWorkState, previous: Stored | null) {
    const manifest: Manifest = {
      version: 1,
      repository,
      pullNumber: issue_number,
      state: { ...state, entries: state.entries.map(entry => ({ ...entry, data: null })) },
    };
    const prior =
      previous?.record.state.fingerprint === state.fingerprint ? previous.manifest : null;
    let bytes = 0;
    const pending = new Set<string>();
    for (const [index, entry] of state.entries.entries()) {
      if (!entry.data) {
        continue;
      }
      const serialized = json(entry.data);
      const hash = digest(serialized);
      const old = prior?.state.entries.find(item => item.id === entry.id)?.data;
      let descriptor: Descriptor;
      if (old?.hash === hash && 'blobIds' in old) {
        descriptor = clone(old);
      } else if (Buffer.byteLength(serialized) > INLINE_BYTES) {
        descriptor = { hash, blobIds: [] };
        pending.add(entry.id);
      } else {
        descriptor = { hash, inline: entry.data };
        bytes += Buffer.byteLength(serialized);
      }
      manifest.state.entries[index]!.data = descriptor;
    }
    // Batch all old inline results on overflow, amortizing evidence writes across units.
    const oldInline = new Set(
      bytes > INLINE_BYTES
        ? prior?.state.entries
            .filter(entry => entry.data && 'inline' in entry.data)
            .map(entry => entry.id)
        : []
    );
    const order = [
      ...manifest.state.entries.filter(entry => oldInline.has(entry.id)),
      ...manifest.state.entries,
    ];
    for (const item of order) {
      if (bytes <= INLINE_BYTES && !oldInline.has(item.id)) {
        break;
      }
      const entry = manifest.state.entries.find(entry => entry.id === item.id);
      if (entry?.data && 'inline' in entry.data) {
        bytes -= Buffer.byteLength(json(entry.data.inline));
        entry.data = { hash: entry.data.hash, blobIds: [] };
        pending.add(entry.id);
      }
    }
    const groups: { blob: Blob; rawBytes: number; entries: string[] }[] = [];
    for (const entry of manifest.state.entries) {
      if (!pending.has(entry.id)) {
        continue;
      }
      const contents = state.entries.find(item => item.id === entry.id)!.data;
      const raw = Buffer.from(json(contents));
      const count = Math.ceil(raw.length / PART_BYTES);
      for (let index = 0; index < count; index++) {
        const bytes = raw.subarray(index * PART_BYTES, (index + 1) * PART_BYTES);
        const part: Part = {
          id: entry.id,
          hash: entry.data!.hash,
          index,
          count,
          partHash: digest(bytes),
          payload: bytes.toString('base64'),
        };
        let group = groups.at(-1);
        if (!group || group.rawBytes + bytes.length > PART_BYTES || group.blob.parts.length >= 32) {
          group = {
            blob: {
              version: 1,
              repository,
              pullNumber: issue_number,
              fingerprint: state.fingerprint,
              parts: [],
            },
            rawBytes: 0,
            entries: [],
          };
          groups.push(group);
        }
        group.blob.parts.push(part);
        group.rawBytes += bytes.length;
        group.entries.push(entry.id);
        (entry.data as { blobIds: number[] }).blobIds.push(Number.MAX_SAFE_INTEGER);
      }
    }
    // Admission uses worst-case IDs before the first immutable write.
    renderManifest(manifest);
    for (const group of groups) {
      renderBlob(group.blob);
    }
    const referenced = new Set(
      manifest.state.entries.flatMap(entry =>
        entry.data && 'blobIds' in entry.data ? entry.data.blobIds : []
      )
    );
    if (calls + groups.length * 2 + 12 + referenced.size + groups.length > API_CALLS) {
      throw new Error('Review work API call budget cannot safely admit this checkpoint');
    }
    return { manifest, groups, pending };
  }
  return {
    async load(signal): Promise<ReviewWorkRecord | null> {
      return operate(
        signal,
        async () => {
          const stored = await load();
          return stored ? clone(stored.record) : null;
        },
        true
      );
    },
    async save(expected, input, signal): Promise<ReviewWorkRecord> {
      return operate(signal, async () => {
        if (poisoned) {
          fail();
        }
        validateState(input);
        const state = clone(input);
        let previous = cached;
        if (
          !expected ||
          previous?.record.commentId !== expected.commentId ||
          previous.record.body !== expected.body
        ) {
          previous = await load();
        }
        if (
          previous?.record.commentId !== expected?.commentId ||
          previous?.record.body !== expected?.body ||
          (expected && json(previous?.record.state) !== json(expected.state))
        ) {
          fail();
        }
        transition(previous?.record.state ?? null, state);
        const { manifest, groups, pending } = plan(state, previous);
        for (const entry of manifest.state.entries) {
          if (pending.has(entry.id)) {
            (entry.data as { blobIds: number[] }).blobIds = [];
          }
        }
        let actual: Comment;
        try {
          for (const group of groups) {
            const comment = await create(renderBlob(group.blob), BLOB_PREFIX);
            for (const id of group.entries) {
              const entry = manifest.state.entries.find(entry => entry.id === id)!;
              (entry.data as { blobIds: number[] }).blobIds.push(comment.id);
            }
          }
          const body = renderManifest(manifest);
          parseManifest(body);
          if (previous) {
            // Recheck after chunk writes: they never authorize overwriting a changed checkpoint.
            if ((await get(previous.record.commentId)).body !== previous.record.body) {
              fail();
            }
            try {
              await api(
                request =>
                  octokit.rest.issues.updateComment({
                    ...repo,
                    comment_id: previous.record.commentId,
                    body,
                    request,
                  }),
                true
              );
            } catch {
              // Only the same exact committed body can reconcile an ambiguous update.
            }
            actual = await get(previous.record.commentId);
            if (actual.body !== body) {
              fail();
            }
          } else {
            known = true;
            actual = await create(body, PREFIX);
          }
          const stored: Stored = {
            record: { commentId: actual.id, body, state },
            manifest,
          };
          cached = stored;
          if (!previous) {
            await repairLabel(false);
          }
          return clone(stored.record);
        } catch (error) {
          poisoned = true;
          throw error;
        }
      });
    },
  };
}
