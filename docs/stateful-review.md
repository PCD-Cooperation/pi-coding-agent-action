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
Attempt 1 of a new `opened` event may establish the first checkpoint
automatically. A PR originally opened as a draft can also initialize with control
`none` on its first `pull_request_target` / `ready_for_review` attempt. GitHub must
prove exactly one matching readiness event and no earlier draft-conversion event,
with the repository/PR, actor and event timestamp bound to the trusted event.
History is paginated up to 10,000 events; unavailable, malformed or unknown history
fails closed. A head pushed while the ready event waits is reviewed through the
normal live snapshot and freshness checks, not rejected merely for differing from
the event's old head. Re-ready cycles and reruns cannot silently initialize a
missing ledger. Replaying the original event after state deletion cannot reset the
budget. Other existing PRs without checkpoints require explicit `bootstrap` and a
reason; bootstrap cannot replace an existing ledger. Invalid state requires deliberate operator
recovery, not an automatic reset. Deleting state is not a supported reset procedure.

`full` requests whole-PR discovery but does not unpause escalation or erase findings.
`resume` records human reassessment and starts another bounded episode. It never
marks a finding fixed or accepts risk. Do not use repeated resumes to automate
around the limit. Only the most recent intervention is retained in the current
checkpoint; use external run artifacts/history if a full intervention audit is needed.

## Review flow

1. Read the dedicated bot-owned comment, validating schema, identity and ledger.
2. Capture head `H`, actual target-ref tip `B`, merge-base `M`, PR intent and
   configuration. Resolve `refs/heads/<baseRef>` through GitHub; an older PR's API
   `base.sha` is not assumed to be the current target tip. Re-resolve the ref before
   publication to reject target movement or retargeting.
3. Stage immutable source trees and complete diff files using trusted host Git.
   The first pass uses `M -> H`. Incremental passes use the exact endpoint diff
   `P -> H`, where `P` is the last successfully published reviewed head. This is
   deliberately not a triple-dot comparison after a force-push.
4. Reconcile every open finding, then inspect changes and affected dependencies.
   A changed merge-base/base ref or unavailable old head causes an explicit full
   fallback, preserving the ledger and active budget. Reviewer configuration
   changes and the `full` control also trigger full discovery.
5. Submit one schema-validated `submit_review_result` call. Complete submissions
   receive host-assigned IDs, transition validation, and current head/actual
   target-ref/intent checks before one canonical comment update. An honest
   incomplete submission is a valid final report, not a request to relabel its
   coverage complete: it fails the run, preserves its reason/candidate evidence in
   outputs and the job summary, and never advances or overwrites canonical state.
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

## Approved dependency evidence

For changed workflow files, the host may stage the exact commit-pinned public
source of this action: only `PCD-Cooperation/pi-coding-agent-action` and upstream
`shaftoe/pi-coding-agent-action`. The fixed required files are `action.yml`, the
orchestrator, the action's Git adapter and GitHub comment publisher. The fixed
versioned stateful runner, renderer and GitHub state provider are also staged when
present; only a nonredirected 404 denotes an older version without those files.
Their absence is disclosed, not evidence that an unknown contract is safe.
This source-controlled allowlist is maintainer policy, not a PR or model input.
Both PR-head and merge-base references are considered. Mutable tags, arbitrary
repositories/URLs, imports discovered inside fetched code, and additional file
paths are not resolved.

Workflow references are parsed as failsafe YAML, including quoted/escaped scalars
and flow mappings; aliases, duplicate keys and parse errors fail closed. Scalar
shell/prompt text is not interpreted as action syntax. The existing locked `yaml`
package is declared as a core runtime dependency for this parsing boundary.

The fetcher uses only the fixed HTTPS raw-GitHub host, no authentication, cookies,
or credential forwarding and rejects redirects. Limits remain four references,
64 KiB per file, 256 KiB total and 45 seconds overall (15 seconds per request),
with at most seven fixed files per reference. Text is staged as non-executable evidence in temporary
files; it is never imported, installed or executed. Missing or omitted approved
context is explicit in the manifest and prevents a complete result. Other material
external contracts still require an honest incomplete report if they cannot be
established; this is not a general dependency resolver.

The stable policy version and content hashes contribute to the reviewer fingerprint;
job-specific temp paths do not. The prompt identifies the trusted workflow-checkout
`REVIEW.md` separately from historical PR snapshots, which may legitimately lack it.

## Static coverage and deployment prerequisites

Coverage is completeness of the static PR/code-contract review, not certification
of live deployment state. A complete review may still contain material findings.
Not running tests, inspecting secret values, or querying production is not itself
a coverage failure: these actions are prohibited. Preserve declared deployment
holds and disclose unverified SSM/IAM/database and client/minimum-version rollout
prerequisites in `coverageNotes`; never claim those conditions were verified or
approve deployment.

Distinguish declared intent from implementation proof. An explicitly intended
breaking contract is not an accidental regression solely because old clients
have a different contract. Review the new behavior and transition safeguards;
claims that consumers have migrated are not proof. Breaking-change labels and
stated intent never waive authorization/privacy/data-integrity invariants, trusted
policy or human risk acceptance. If a material implementation
decision actually requires absent external source, coverage remains incomplete.

For generated data, inspect the generator/configuration, packaged baseline,
provenance, schema/invariants and affected consumers. Read-only codemode data
processing can check whole-artifact invariants without running PR scripts. State
what was checked; do not claim exhaustive semantic certification of every domain
record, or silently sample material changed code. Missing essential evidence or
uninspected material changes still fail closed. These rules never convert an
incomplete submission into a passing result or accept risk on a human's behalf.

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

Outputs `review_outcome` (`reviewed`, `unchanged`, `needs_human`, `incomplete`) and
`review_revision` describe processing/checkpoint state, not merge authorization.
For incomplete reports, `success=false`, the run is non-passing, and the revision
remains the last successful checkpoint (0 if none exists). `review_result` contains
JSON with `outcome`, pinned `snapshot`, unchanged `checkpointRevision`, and the
uncommitted `submission` including its coverage reason and evidence candidates.
The job summary explicitly labels these as claims, not accepted finding dispositions.
The 60,000-byte rendered-report budget is checked inside result submission before capture;
oversized candidates receive a retryable tool error asking for shorter evidence while
keeping `coverage=incomplete`, rather than losing an already accepted report.
No canonical comment is created or changed, even if a candidate claims an old finding
is fixed or accepted. The canonical summary separately renders `PASS`, `FINDINGS`,
or `NEEDS_HUMAN` only for successfully committed complete reviews.

## Tool boundary and rollout

Stateful sessions expose only read/grep/find/ls, PR thread retrieval, codemode,
bounded review children, child collection and model-only result submission. The
host also blocks non-review nested tool calls. Read-only tools are not an operating
system filesystem sandbox; continue treating prompt injection and exposed runner
files as security concerns. No PR instructions or credentials should enter the
trusted configuration. Children cannot publish or spawn grandchildren. Fresh
children receive the host-owned snapshot identity, absolute source/diff paths and
staged dependency manifest automatically; parent prose is not their only route
to the immutable evidence. They still have no ambient project/global context,
author mutation tools or additional filesystem/network permissions.

Pilot manually on coordinated PRs first. Do not connect the pilot to an autonomous
author-fix loop or run competing state writers. Keep ordinary stateless workflows
separate until an explicit rollout replaces them. Disable the opt-in to roll back,
while preserving the ledger for diagnosis. Do not feed the new output to legacy
final-line approval parsers or delete its canonical comment after review.
