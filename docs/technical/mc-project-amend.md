# Amending a blocked project

`mc project amend <project> --amendment-file <json> --reason "<authorization>"`
is the planning session's explicit exception to the freeze on a sent plan.
Use it after an authorized review changes the remaining instructions or
contract. It never releases a step. Ordinary `project edit` and `step edit`
retain their existing restrictions.

The amendment file is input to the verb, not a replacement `PLAN.json`.
Keep it in scratch space. Its optional fields are:

```json
{
  "contract": ["Preserve the format while permitting the necessary repair."],
  "steps": [
    {
      "number": 2,
      "instruction": ["Read and expose the existing next-style metadata."],
      "done_when": "The next-style regression passes.",
      "model": "haiku",
      "effort": "high"
    }
  ],
  "success_criteria": [
    {
      "criterion": "The next style is available without changing package bytes.",
      "check": "mc gate tests/next-style.test.js"
    }
  ]
}
```

`contract` and `success_criteria` replace those arrays whole; include every
entry to keep. `steps` edits the named 1-based slots, leaving other fields
and steps intact. Instruction paragraphs, done-when, model and effort are
the only editable step fields. The verb cannot rename, reorder, add or
delete steps, alter their state/dependencies, change the goal or exclusions,
change the plan's tool, or modify a completed/built/review step.

## Preconditions and validation

- A sent, non-archived plan and matching register must exist.
- The first unfinished step must be blocked on a decision or workarea.
  Automatic time, deploy and project waits are not an amendment lock.
- No step may be running, landing or retain a session. A caller carrying
  `MC_STEP` is refused: a runner session cannot change its own scope.
- Every registered criterion must be unmet. A new contract can invalidate
  earlier evidence; use `mc project criterion unmet` explicitly before
  amending rather than carrying a stale green result into the new plan.
- No project PR may be open, including one on a retained branch or named in
  the register. An unsuccessful or truncated GitHub lookup refuses the write.

The complete result must pass the plan schema and the same authorship checks
as `send`, including step models, measurable checks and dependency placement.
The mc-owned review step is retained unchanged, not added a second time.

Remote checks happen before locking. Under the plan lock and a strict
register lock, the verb rereads the plan and register and refuses if either
changed. It writes one complete plan atomically; it does not write the
register, so landed PRs, retained branches/commit notes, blockers, criteria
state and history are not reset. New criterion names are reconciled as unmet
by the normal plan reader.

## Audit and failure

Before committing the plan, the verb writes an authorization record to
`<project>/amendments/<uuid>.json`: reason, timestamp, caller, full before/after
plans and their SHA-256 digests. Failure to record authorization prevents the
plan write. Failure of the atomic plan write leaves the old plan and an
authorization attempt, not an assertion that it succeeded. Compare the plan
digest with the record's `after_sha256` to identify the authorized version;
later amendments have their own records. Filesystem I/O is the only work
inside the locks; no network call waits there.

After a successful amendment the project is still blocked. Read the result,
then use `mc step ready <project> <n> --answer "..."` as the separate handover.
Amendment does not weaken that command's PR safeguards. No branch, workarea,
pull request or deployment is created by amending a plan.

Implementation: `src/mc/plan-amend.js` validates the partial input and the
standing; `src/mc/commands/project-amend.js` owns lookup, locking, audit and
commit; `src/mc/commands/project.js` routes the verb. The existing atomic
writer and register lock are reused. Coverage lives in
`tests/mc/commands/project-amend.test.js`.
