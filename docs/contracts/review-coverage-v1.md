# Stateful coverage contract v1

This immutable, versioned interface contract accompanies `review_coverage: true`.
It describes the action's behavior, not certification that a PR, deployment, external
system, generated corpus, or dependency implementation is correct. Review proposed
changes to this implementation against their pinned source normally.

## Inputs and authority

Coverage is opt-in and requires `stateful_review: true` and canonical comment
publication. `review_work_concurrency` defaults to 3 (range 1–3);
`review_work_max_units` defaults to 96 (range 1–96). No session exports/sharing,
model-owned publication, additional workflow permissions, self-dispatch, or
continuation workflow are supported. Worker model/thinking reuse the existing
`review_subagent_model`/`review_subagent_thinking_level` inputs, but workers cannot
spawn children. Legacy non-coverage behavior remains available.

The host stages immutable H (head), M (merge-base), B (actual target tip), and P
(previous successful head), and inventories every changed file and hunk. Renames,
deletions, copies, empty files, binary resources, and mode-only changes remain
explicit work. Full reviews use M→H; incremental reviews use P→H with M retained
for attribution. Configuration/full-reassessment changes, target movement and changed PR intent
force full coverage scope.

## One invocation

The host partitions primary inspection by bytes, lines, files and spans, then
runs bounded parallel waves within ONE action invocation. Split artifacts also
receive whole-file integration checks after their primary units are reviewed.
Related peer evidence feeds integration and retries; a partial producer waits for
its requested checks instead of immediately repeating the same unfinished work. Prior open findings receive explicit
reconciliation units. Discovered material consumer/global/dependency checks become
additional required units, not exclusions. Workers return structured unit results;
IDs, scope claims and output sizes are host-validated. A reviewed unit must cover
all assigned spans and reconcile every assigned finding with a disposition.
Tool-read receipts alone do not establish semantic coverage.

Bounds: 96 total required units, 3 concurrent workers, 2 attempts per unit per
invocation, 5 minutes and 60 read-tool calls per session; primary units are at most
96 KiB/1,800 patch lines/8 files/24 spans. Coverage work has a 22-minute admission window measured from
invocation start, reserving 4 minutes for synthesis, with at most 3 synthesis
attempts. Durable follow-up history is limited to 16 KiB, reserving space for the
final review. Host storage operations have 60-second bounds; requests have 15-second
bounds and propagate cancellation. The caller's job deadline remains authoritative.
Exhaustion, missing material evidence and no-progress results are non-passing.
No sampling, truncation, or forced completion can satisfy the host gate.

Workers and synthesis permit only read-only inspection/data processing and their
model-only result endpoints. Shell, mutations, delegation, ambient extensions/MCP,
and codemode model-generation globals are unavailable. Only the host writes review
metadata. The final synthesizer integrates ALL unit evidence, verifies material
candidates, deduplicates causes and reconciles stable prior IDs; it need not repeat
all completed primary inspections. It may request more required scope instead.

## Durable work and publication

Bot work comments use `pi-stateful-review-work:v1` plus an independent persistent
`pi-stateful-review:coverage-v1` label. `collecting`/`ready` are work phases, NOT
successful canonical review checkpoints. A manifest is bounded to 60,000 bytes,
inline evidence to 8 KiB, raw blob parts to 18 KiB and entry data to 64 KiB; storage
caps counted storage calls at 2,500 per invocation; provider quota can be lower.
Eligibility is checked on admission and fresh loads, not redundantly for every
progress checkpoint. The canonical publisher still rechecks live eligibility. Evidence is identity/hash bound and immutable;
fresh publication verification reads all referenced evidence. Missing witnessed
history, corruption, ambiguity, conflicts or failed verification refuse publication.

Exact snapshot, intent, configuration, plan and canonical-predecessor fingerprints
permit recovery after a failed invocation without repeating reviewed units. Prior
incomplete synthesis candidates are supplied again and retained through follow-up
requests and further incomplete results. Final synthesis must explicitly refute
omitted prior proposals with pinned evidence in its coverage notes; proposals are
not accepted findings. Rendered and durable output capacity is checked before capture.
Changed inputs invalidate work reuse, never the canonical ledger. Cumulative
attempt counts remain monotonic within that fingerprint; failed-action retries have a bounded new invocation
allowance. Identically blocked scopes are not automatically repeated. All required
units plus successful synthesis and a fresh durable gate are necessary before the
existing canonical publisher may assign new F-IDs or advance a successful cursor.

Initialization receipts, strict legacy bootstrap, stable findings, canonical schema
v1, actionable-round budgets, pauses and lost-history protections are unchanged.
Incomplete/error work never resolves findings, advances success counters or resumes
a pause. Static coverage is not merge approval, risk acceptance, or deployment
readiness; preserve unverified operational holds explicitly.
