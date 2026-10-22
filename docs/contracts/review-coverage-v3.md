# Stateful coverage contract v3

Extends [v2](review-coverage-v2.md). Static coverage is not certification.

Each completed review appends a NEW full findings comment. Prior bodies stay
immutable; schema 1, stable F-IDs and counters persist. Before the state payload,
`pi-stateful-review-parent:v1` carries base64 JSON `{version:1,parent}`. Parent is
null for a new root, otherwise `{commentId,bodyHash,revision,operationKey}` binding
the exact predecessor body. A single legacy edited ledger can root migration at
its current revision. Only one complete validated chain head is authoritative;
missing/deleted/tampered history, forks and conflicting witnesses fail closed.

Lifecycle/work journals remain mutable with independent witnesses. Lifecycle
marker/label stay v1; new payload version 2 rejects old readers, even with one root.
Readers accept v1/v2; only v1 publishing intents recover
exact legacy in-place candidates at the old ID. Version 2 requires the linked
candidate, exact hash/revision/key, readback and seal. Reconcile unknown writes;
never blindly repost. Capacity reserves stay unchanged.

There is no finite round cap. Deprecated `review_max_rounds` is accepted/ignored
(default 0). Existing cap-only pauses release on the next ordinary event without
resetting history. Uncertain material origin still requires authorized resume;
`full` is not resume, bootstrap cannot reset history, no automated risk acceptance.
Unchanged successful retries post nothing. Partial/incomplete/error runs never
publish success or advance cursors, dispositions, IDs or completion counters.

Required units, synthesis and evidence need a fresh gate. Snapshot fingerprints,
freshness, reservations and native receipts persist. Digests are not semantics.
Preserve journals/blobs/labels. No PR execution,
permission, delegation, self-dispatch or per-invocation budget increases.

Bounds remain: 96 units, concurrency 3, 2 attempts/unit; session 5min/60 reads;
22min total/4min synthesis reserve; 3 synthesis attempts; existing storage/snapshot
limits. Policy `approved-action-pins-v7` selects v3 in the same ninth fixed slot
(v2/v1 fallback): 4 refs, 9 files/ref, 64KiB/file, 256KiB total, 45s total/15s request.
