# Independent autonomous review (inactive)

The v1 review role still closes gaps, measures criteria and publishes. V2 has
an examine-and-report flavor, `_review-autonomous.md`, selected only through
`createRunner`'s injected autonomous capability with `review: true`. No CLI or
environment flag activates it; normal execution remains disabled. This step
does not activate live programmes or automatically schedule repairs.

## Models and admission

The operator's existing `mc model set review <tool:model:effort>` configures the
reviewer for a new autonomous goal. The first build atomically reserves that
candidate in `reviewer_model`, excluding it from autonomous build pools without
changing the catalog or v1 routing. Later catalog edits do not move an existing
reservation. Actual build candidates, run IDs and goal revisions are retained
in `model_history`, including unsuccessful attempts. All historical builder
identities count for review, not just the latest builder/revision. Missing
provenance waits instead of claiming independence. Effort changes do not create
independence; Claude moving aliases and explicit names in the same family are
conservatively treated as the same identity.

Review uses the ordinary capacity and interactive-reserve rules with exactly
the reserved candidate. Refusal/unavailability returns a transient wait. It
cannot fall back to a builder. Both flavors share the runner's existing
project claims, repository lanes and machine-wide slots. Gate selection and
resource reservations are unchanged.

## Frozen session and command boundary

`prepareAutonomousReview` requires review-ready state and a settled publication,
checks the pushed branch's head and creates a new detached worktree beneath
`<work root>/runner/reviews/<run ID>/checkout`. It never syncs or resets the
builder's branch/index. The session freezes the complete assignment, criterion
and assignment digests, programme/goal revision, published head, branch/PR,
merge-base comparison SHA, observed integration base, model provenance, builder
verification references and gate run. The runner also verifies GitHub's open PR
head, branch and main target before and after the separate review session.
The full start context is bounded by the existing session-start byte limit.

The public command dispatcher refuses unknown commands and mutations for
`MC_AUTONOMOUS_ROLE=review`. Only help/status, gate, hooks and autonomous-project
show/report are available. Publish, merge (including admin), legacy project and
step commands also guard their imported command entrypoints. Autonomous state
writes check expected revision and exact active run/role under lock; a bound
review can only submit its report, not release itself, change scope, mark
criteria, publish or confirm completion. These are trusted workflow checks,
not OS isolation against a malicious process changing its environment/files.

## Report lifecycle

Submit `mc autonomous-project report <programme>/<project>
--expected-revision <n> --input-file <json>` from the active review. Input is:

```json
{
  "criteria": [
    {
      "criterion_id": "stable-id",
      "status": "verified",
      "evidence": ["immutable verification reference or explicit reason"],
      "uncertainty": []
    }
  ],
  "defects": [],
  "uncertainty": []
}
```

Every criterion must appear exactly once. Status is verified, finding, unknown
or deferred; only after-integration criteria may be deferred. Every observation
needs evidence/reason and an explicit uncertainty array. Missing findings,
unknown IDs, missing evidence or attempts to add scope/state fields are refused.
Submission is immutable and is not yet a completed review.

Before spawn, an immutable `manifest.json` beside the detached checkout freezes
its session, source checkout fingerprint, Git identities and a fresh generation.
`spawn-intent.json` is written before calling the transport; a crash after that
write with no observed child is **unknown**, not proof that spawn failed.
`launch.json` consumes native launch permission before spawn, so losing the spawn
response cannot launch the same attempt twice. `launch.json`, `spawned.json`,
`terminal.json` and `report.json` are immutable, generation- and
manifest-digest-bound facts. Generation-safe process and project claims serialize
writers; a dead PID alone never proves successful closure or permission to reuse
an attempt. Corrupt facts and live or unreadable claims retain ownership.

The dedicated inactive review transport detaches its own process group, observes
native close, group death, transport completion, outstanding tool jobs and the
existing gate worker. Unknown spawn outcome, open pipes, surviving children or
unfinished tools retain the active review owner. Exit zero without a complete
transport result is incomplete, never clean. A known pre-spawn abort can only
produce an incomplete report. No discovered old process is signalled.

After proven process/tool closure the trusted runner checks HEAD, detached identity,
index, tracked/untracked raw content and ignored additions against the initial
checkout fingerprint, and checks that the source checkout is unchanged. Changed
checkout, moved publication, failure/interruption or absent submission cannot be clean. Missing/invalid submissions become
explicit unknown observations for every criterion. A report is clean only with
no defects/uncertainties/invalidation and verified premerge observations;
after-integration deferral stays pending, not planner-confirmed.

The full immutable `mc-autonomous-review-report` and frozen session are appended
to authoritative `AUTONOMOUS_STATE.json`'s `review_reports`; the existing
`evidence.reviews` gets a compatible attributed summary/reference. Both commit
in one atomic state write, after publishing the immutable `report.json`.
A crash before that state write leaves ownership held. Retrying completion
revalidates the frozen assignment, checkout and publication and writes the exact
same report before releasing ownership; changed evidence cannot overwrite it.
Duplicate completion returns the durable report;
changing the same report ID is refused. All completions leave `plan_pending`
with no active owner, no new build job and no confirmation. A runner interrupted
before completion preserves its reservation/checkout/submission; it is never
silently treated as successful or relaunched by the picker.

The [autonomous merge door](mc-autonomous-merge.md) now consumes this evidence.
Review itself still neither queues nor merges. After its process exits, the
trusted runner automatically routes a complete current clean report through
that door to the existing merger. Findings/unknowns remain with plan, as do
all merge outcomes. Routing crash recovery never launches another builder or
reviewer. Landed remains distinct from planner-confirmed. Execution remains
inactive; see the merge document for event identities and recovery.

## Verification

`mc gate tests/mc/autonomous-review.test.js tests/mc/autonomous-models.test.js`
uses real temporary repositories, bare remotes and detached worktrees, with
controlled GitHub/transport/capacity fixtures. It checks historical model reuse,
reviewer reservation, missing criterion findings, forbidden commands/state
writes, checkout mutations, incomplete exits and durable reports without model
calls or touching live programmes.
