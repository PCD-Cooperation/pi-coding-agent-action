# Stateful PR review (opt-in)

`stateful_review: true` switches the action from prose comments to a canonical
finding ledger. Stateless users are unchanged. This is GitHub-only and supports
same-repository, open, non-draft PRs with the standard `GITHUB_TOKEN`; PAT/App
publication identities are not supported in this first version. No formal GitHub
approval, required check, or merge-policy change is created.

## Caller contract

Grant repository reads and issue-comment writes. Serialize **every** automatic
and manual writer with one workflow-level group, for example:

```yaml
concurrency:
  group: pi-stateful-review-${{ github.repository }}-${{ github.event.pull_request.number || inputs.pr_number }}
  cancel-in-progress: false
```

GitHub concurrency is not a durable FIFO queue. A later invocation reviews the
current live snapshot, so dropped pending events do not advance the review cursor.
All state writers must cooperate: GitHub comment updates have no compare-and-swap,
and the PR read plus comment update cannot be an atomic transaction. Results name
the exact reviewed SHAs; they are never an approval of an unspecified future head.

Use trusted default-branch workflow/policy code, an immutable action SHA containing
the rebuilt `dist/`, and a dedicated `PI_CODING_AGENT_DIR`. Never check out or execute
PR code in the privileged review job. A trusted `REVIEW.md` in the action working
directory contributes to both the prompt and configuration fingerprint.

Inputs:

| Input | Default | Behavior |
| --- | --- | --- |
| `stateful_review` | `false` | Enable the protocol; requires `publish_comment: true` |
| `review_max_rounds` | `3` | Actionable fix revisions per episode before human reassessment |
| `review_control` | `none` | `none`, `bootstrap`, `resume`, or `full` |
| `review_control_reason` | empty | Required for every non-`none` control |
| `pr_number` | event PR | Set explicitly for manual dispatch |

Controls authorize the triggering actor through repository collaborator permission
(`write`, `maintain`, or `admin`), not through PR text, a comment, or PR authorship.
Only attempt 1 of a new `opened` event may establish the first checkpoint
automatically. Replaying the original event after state deletion cannot reset the
budget. An existing PR without a checkpoint requires explicit `bootstrap` and a reason; bootstrap
cannot replace an existing ledger. Invalid state requires deliberate operator
recovery, not an automatic reset. Deleting state is not a supported reset procedure.

`full` requests whole-PR discovery but does not unpause escalation or erase findings.
`resume` records human reassessment and starts another bounded episode. It never
marks a finding fixed or accepts risk. Do not use repeated resumes to automate
around the limit. Only the most recent intervention is retained in the current
checkpoint; use external run artifacts/history if a full intervention audit is needed.

## Review flow

1. Read the dedicated bot-owned comment, validating schema, identity and ledger.
2. Capture head `H`, base tip `B`, merge-base `M`, PR intent and configuration.
3. Stage immutable source trees and complete diff files using trusted host Git.
   The first pass uses `M -> H`. Incremental passes use the exact endpoint diff
   `P -> H`, where `P` is the last successfully published reviewed head. This is
   deliberately not a triple-dot comparison after a force-push.
4. Reconcile every open finding, then inspect changes and affected dependencies.
   A changed merge-base/base ref or unavailable old head causes an explicit full
   fallback, preserving the ledger and active budget. Reviewer configuration
   changes and the `full` control also trigger full discovery.
5. Submit one schema-validated `submit_review_result` call. The host assigns IDs,
   validates transitions, checks current head/base/intent and prior state, and
   publishes the rendered summary and payload in one comment update.
6. Verify the written checkpoint. A publication error is never a reason to create
   replacement state. Ambiguous write timeouts are reconciled by operation key.

Snapshot extraction rejects symlinks/submodules, unsafe paths and case-colliding
names. It materializes raw, non-executable blobs without attributes/filters/hooks.
The current limits are 10,000 files and 128 MiB per tree/output. Limit failures
stop the run; no source or diff is silently truncated. `diff_max_lines`,
`diff_max_bytes` and ignore patterns belong to the live stateless diff tool and do
not truncate these pinned files. Readers must paginate their own bounded output.
Temporary snapshots remain until runner cleanup; use ephemeral runners or clean
job-owned temp directories on persistent runners.

## Findings and convergence

Origin is independent of lifecycle:

- `pr_introduced`: a regression introduced by the PR.
- `pre_existing`: unchanged existing behavior; advisory, never a PR blocker.
- `pre_existing_worsened`: the PR makes old faulty behavior reachable or worse;
  actionable when the causal regression is evidenced.
- `uncertain`: origin cannot be established; material uncertainty requests human
  reassessment rather than a clean pass.

A bug missed in the first review can still be PR-introduced. Incremental discovery
starts with the new delta and follows affected dependencies; it does not repeatedly
mine unchanged PR code for unrelated late findings. A material reason to revisit
the whole approach requires explicit full reassessment.

IDs survive moves, renames and lifecycle changes. Open findings cannot disappear
through omission. Closed findings remain in the ledger even when later submissions
omit them. Reopening a closed finding must use `reintroduced` with evidence. The
model cannot set counters, IDs or SHAs, or transition a finding to `risk_accepted`.
No manual risk-acceptance command is provided by this version.

Only completed, successfully published reviews count. Replaying the same input
snapshot/configuration does not run the model or advance state. Rechecking the same
fix revision while base/configuration changes does not consume another actionable
round. Moving from A to B and force-pushing back to A is a new fix attempt, not an
unchanged-checkpoint retry; it consumes a round so toggling old heads cannot evade
the bound. Clean reviews end the active episode without deleting total counts/history.
Three actionable fix attempts with unresolved material regressions pause automatic
model runs until an authorized human resumes. Failure/incomplete coverage does not
advance the cursor or constitute a clean review.

Outputs `review_outcome` (`reviewed`, `unchanged`, `needs_human`) and
`review_revision` describe processing/checkpoint state, not merge authorization.
The canonical summary separately renders `PASS`, `FINDINGS`, or `NEEDS_HUMAN`.

## Tool boundary and rollout

Stateful sessions expose only read/grep/find/ls, PR thread retrieval, codemode,
bounded review children, child collection and model-only result submission. The
host also blocks non-review nested tool calls. Read-only tools are not an operating
system filesystem sandbox; continue treating prompt injection and exposed runner
files as security concerns. No PR instructions or credentials should enter the
trusted configuration. Children cannot publish or spawn grandchildren.

Pilot manually on coordinated PRs first. Do not connect the pilot to an autonomous
author-fix loop or run competing state writers. Keep ordinary stateless workflows
separate until an explicit rollout replaces them. Disable the opt-in to roll back,
while preserving the ledger for diagnosis. Do not feed the new output to legacy
final-line approval parsers or delete its canonical comment after review.
