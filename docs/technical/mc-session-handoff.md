# Bounded autonomous session handoffs

`src/mc/session-handoff.js` is an **inactive v2 runner seam**, not a launch or
publication command. No existing v1 prompt, register, gate selection, lane,
provider transport or execution-enabled flag changes.

## Fresh context

`buildSessionStart` emits one JSON start payload containing programme metadata,
the complete v2 goal assignment and at most one predecessor handoff. Goal scope,
requirements, criterion instructions/checks and document references remain inline.
Programme metadata supplies context, never approval authority. There is no
transcript concatenation or automatic history loading. Detail belongs in document,
code, log and immutable artifact references; no reference is fetched implicitly.

The handoff limit is 16 KiB, the complete model result 24 KiB, and the **entire
serialized start payload**, including standing instructions, assignment, programme,
references and observed facts, 64 KiB. Limits count UTF-8 bytes. Overflows fail
closed, rather than truncate criteria or silently discard decisions. The planner
must supply a bounded assignment with references for additional detail. These are
contract ceilings, not context telemetry estimates or session-control thresholds.

## Model results versus observations

Results and their handoffs carry `programme_id`,
`project_id`, `goal_revision` and `run_id`. Evidence entries carry the same binding
and an assigned criterion ID, measured-evidence reference and summary. Each handoff
names the last published SHA (or null for an incomplete attempt), implemented and
remaining work, decisions, failed approaches, next focus and code/log/artifact
references. Unknown fields, missing fields and mismatched bindings are rejected.
Interpretation and evidence summaries are model-written claims, not gate facts.

- `continue`: a normal published session with remaining work.
- `review-ready`: a normal published session with no remaining work and evidence
  references for every premerge criterion. After-integration criteria remain in
  the assignment; this outcome neither confirms completion nor authorizes merge.
- `incomplete`: interrupted/unpublished work, with an explicit reason.
- `needs-plan`: an explained exception for plan, not a new repair role.

`validateSessionResult` checks shape and binding only. `persistSessionResult`
requires existing branch/PR ownership and, for either normal outcome, uses Git
and `findPublicationReceipt` to check the current branch, committed tree, raw
content, observed pushed SHA, required full relevant selection, gate configuration,
session run and goal revision. Normal results additionally require an explicit
runner-observed zero process exit without interruption; unknown/failed/interrupted
exits are not normal even when the publication was green. A model cannot supply
an `observed` or `green` field. Missing/running/red/incomplete, named-only, stale or another run's gate
receipt cannot make the attempt normal. Incomplete/needs-plan artifacts keep
publication and gate observations null and `normal_exit: false`, even if the
model names an older published SHA. Ownership is retained separately from any
claim that incomplete work was published.

This API is a trusted control-plane seam: the future caller must check active
run/role ownership and load authoritative contracts under their locks, supply the
reserved branch/PR, observe native process completion and independently observe
remote HEAD. A remote tracking ref or model-written SHA is not such an observation. No production caller exists yet;
this module does not reserve runs, push, launch, alter criteria or transition
`AUTONOMOUS_STATE.json`. It is not an OS/adversarial filesystem boundary.

## Persistence and recovery

Under `<mc home>/session-handoffs/<programme>/<project>/`, `<run>.json` is an
exclusive immutable attempt containing the result, predecessor ID and separate
mc observations. `CURRENT.json` atomically replaces only the prompt pointer,
identifying the current run and artifact digest. Writes use the existing strict
register lock and compare the expected predecessor; a stale writer cannot replace
a newer handoff. Slow Git observations happen before that shared lock; the
reserved run must own a quiescent checkout. Branch/PR identity cannot change across runs: the predecessor is
read back to compare it against the goal revision it was built for
(`history: { assignments }`, the goal's append-only contracts), so a session
after plan revised the goal can still publish on the same branch and PR. A retry may reuse
an identical artifact, never replace it or relabel an old run as a new attempt.

The immutable artifact is written before the pointer. A crash between them leaves
addressable evidence; replaying the same result completes the pointer update.
Missing, truncated, oversized or modified artifacts are explicit failures. Partial
artifact writes cannot be promoted to normal results or overwritten as new history.

`readCurrentHandoff` requires the exact source run and assignment revisions.
`buildSessionStart` additionally requires an explicit, different `previousRunId`.
A predecessor's observed publication and evidence survive as continuation context,
not proof for the new run. Supplying that old handoff or gate as the new run's
result is rejected. Older attempt files remain addressable but are not appended
to the next prompt. Assignment revisions invalidate continuation conservatively;
future revision/runner orchestration must clear or replace the current pointer
explicitly, not reinterpret stale evidence.
