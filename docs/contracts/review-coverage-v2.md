# Stateful coverage contract v2

This immutable `review_coverage: true` contract supersedes immutable
[v1](review-coverage-v1.md). It is not source certification or merge approval.

## Authority and inventory

Coverage requires `stateful_review: true`, canonical comment publication and
serialized per-PR writers. `review_work_concurrency` defaults to 3 (range 1–3);
`review_work_max_units` to 96 (range 1–96). Worker model/thinking reuse
`review_subagent_model`/`review_subagent_thinking_level`. No self-dispatch,
continuation workflow, extra permissions, session exports/sharing, model-owned
publication or worker delegation is supported. Non-coverage behavior remains.

Pinned H (head), M (merge-base), B (target tip), P (previous successful head) retain
complete Git inventories: every hunk, rename, deletion, copy, binary/empty file and
mode change. Full scope is M→H; incremental is P→H with M for attribution.
Target/intent/configuration changes or authorized reassessment force full scope.
Existing snapshot/path protections remain.

## Admission and completion

ONE invocation partitions primary inspection, runs bounded parallel waves, admits
required follow-ups and synthesizes. Split artifacts receive whole-file integration
after primary inspection; open findings receive reconciliation units. Partial
producers wait for requested checks. Related evidence feeds integration/retries.

Submission reserves its endpoint before awaiting asynchronous preflight. Worker
and synthesis requests resolve pinned sources, prepare the entire required plan
and validate capacity before capture/termination. Failed validation releases the
slot for correction. Abort/reset cannot capture stale validation. Concurrent
admissions reserve capacity; serialized commit rechecks it, saves prospective
state, then installs scope additions. No partial admission or phantom scope is
allowed. Real storage/history conflicts remain fatal, not swallowed validation.

A reviewed worker result covers ALL assigned spans/findings with evidence-backed
dispositions and no limitations. Material consumer, global, generator and dependency
checks become required units. Read receipts or hashes do not prove semantic
coverage. Synthesis integrates ALL evidence and prior proposals, verifies material
candidates, deduplicates causes and reconciles stable IDs. Omitted proposals need
evidence-backed refutation in coverage notes. Synthesis can request additional
scope without repeating completed primary inspection. Missing material evidence,
exhaustion, cycles or no progress cannot establish completion.

## Native digest checks

Ordinary follow-ups retain `paths`/`question`. Optional exact `digestCheck` fields:

```json
{
  "manifestPath": "inventory.json",
  "pointer": "/files",
  "normalization": "sha256-utf8-lf-v1",
  "selection": "changed"
}
```

Recipe `paths=[manifestPath]`. Paths are bounded, repository-relative, contained
and symlink-free. The bounded pointer selects a plain path→SHA-256 map in H.
Unknown fields, invalid evidence and missing essential source fail closed.

`selection` is `changed` or `all`. Changed selection compares manifest entries and
source changes against the FULL M→H inventory, not merely P→H. Missing inventory
conservatively selects all entries. Absent M manifests permit a new manifest;
malformed baselines are not ignored. Unrecomputed unchanged hashes alone are not
an unread static-review scope; broader checks require a concrete material reason.
Generator, schema, set/invariant and consumer semantic review remain separate.

Mechanical IDs derive from the recipe, pinned content and deterministic selection,
not question wording. Distinct semantic questions are not collapsed by path alone.
The host partitions exact items into children bounded by eight files AND result
size. Root/children count against the existing unit cap before capture. Native
children compute comparisons without model sessions. Machine-readable per-path
receipts in assessment JSON bind H SHA, path, algorithm, normalization, bytes,
expected/actual digest and outcome; roots bind child evidence hashes. Recovery
validates exact receipts, not aggregate prose counts. Missing, failed or mismatched
partitions cannot be promoted to success or silently omitted.

`review_file_digests` also exposes bounded native receipts for 1–8 files in pinned
H/M/B/P. It uses trusted host cryptography over source bytes, never rendered or
paginated read output, PR imports/scripts, shell, installations or arbitrary host
evaluation. Calls charge each file against the model's read budget, including
codemode nesting. Byte/output/deadline bounds apply. Equality proves only the
specified mechanical comparison, not semantics, provenance, safety or live state.

Normalization is explicit and versioned:
- `sha256-raw-v1`: exact bytes, including binary data.
- `sha256-utf8-lf-v1`: strict UTF-8, preserving BOM, converting CRLF and lone CR to
  LF, preserving other whitespace and trailing-newline presence. No trimming,
  Unicode normalization or JSON reserialization.

## Unchanged limits

Workers/synthesis allow read-only inspection/data processing and model-only result
endpoints. Shell, mutations, delegation, ambient extensions/MCP and codemode model
globals are unavailable. Only the host writes metadata; PR code/tests never run.

- 96 required units, concurrency 3, 2 attempts/unit/invocation.
- 5 minutes and 60 read calls/model session, including nested and native file reads.
- Primary units: 96 KiB patch bytes, 1,800 lines, 8 files, 24 spans; UTF-8-safe slices.
- 6 KiB unit-result JSON; no truncation to pass a gate.
- 22 minutes from invocation start, reserving 4 for synthesis; at most 3 synthesis
  attempts. The caller job deadline is authoritative.
- Host operations: 60 seconds; storage requests: cancellable 15 seconds.
- Manifest: 60,000 bytes; inline data: 8 KiB; immutable parts: 18 KiB; entry: 64 KiB;
  retained synthesis follow-ups: 16 KiB with final-review capacity reserved.
- 2,500 counted storage calls/invocation. Provider quota may be lower; limits are
  neither a quota guarantee nor a dollar-cost ceiling.

## Durability, compatibility and publication

The work wire envelope remains v1: `pi-stateful-review-work:v1`, immutable evidence
`pi-stateful-review-work-evidence:v1` and independent label
`pi-stateful-review:coverage-v1`. Legacy follow-ups decode; newer optional recipes
are strict. Older rollback source must fail closed on unsupported recipes, not
remove witnesses or rewrite evidence. The plan discriminator `coverage-work-v2`
invalidates old WORK reuse, never canonical history or initialization authority.

Recovery requires exact snapshot, intent, configuration, plan and canonical
predecessor fingerprints. Reviewed units/ready synthesis can be reused; partial
unit/synthesis candidates remain retained. Attempts stay cumulative within that
fingerprint; a failed-action retry gets only its bounded invocation allowance.
Identically blocked scopes do not automatically repeat.

One updated work comment shows persisted counts/synthesis, not live CI status.
`collecting`/`ready`/stored `running` may outlive a failed job; none is approval or
a canonical checkpoint. Untrusted questions are not rendered as Markdown.

Evidence is immutable and repository/PR/fingerprint/entry/hash-bound. Fresh
publication verifies every referenced blob. Admission/fresh loads check eligibility;
canonical publication checks it again. Missing witnesses, corrupt/ambiguous history,
conflicts, lost parts or failed verification refuse publication. Preserve all
metadata and labels on source-only rollback.

Only ALL reviewed required units, successful synthesis and a fresh durable gate
binding the exact review hash permit canonical publication, new F-IDs or success
cursor advancement. Incomplete/error work cannot resolve findings, advance success
counters or resume pauses. Canonical schema v1, stable findings, initialization,
strict legacy bootstrap, lifecycle transitions, actionable-round budgets, pauses
and lost-history protections are unchanged. Preserve unverified operational holds;
static coverage never accepts human risk or certifies deployment readiness.
