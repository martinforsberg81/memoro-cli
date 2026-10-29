# Revisioned autonomous data (inactive)

This is the persistence layer for explicitly opted-in v2 goals. It does not
launch sessions, enable execution, publish code or queue a merge. The
legacy v1 register and its matching rules are unchanged. Command modules are
lazily routed by `src/mc-cli.js`; v2 contract publication
and display are described in [the contract integration](mc-autonomous-programmes.md).

## Storage and atomicity

All files are outside repositories, under `programs/<programme>/` in the mc
work root. `PROGRAMME_STATE.json` is a versioned `mc-programme-state` record:
its `approved` array contains immutable approved contract snapshots; `draft`
is separate and cannot change an approved snapshot. Its mutation `revision`
is distinct from a contract revision. It also holds the reserved plan owner
and run history. `execution_enabled` remains false.

Each project has `AUTONOMOUS_STATE.json` (`mc-autonomous-state`, version 1).
It holds the authoritative draft contract and contract history, programme and
goal revisions, stable criterion observations, independent reports, planner
confirmation/history, branch/PR ownership, commits, execution phase, current
handoff reference, run ownership/history and append-only incomplete attempts.
Independent completion and merge routing additionally append idempotent
`plan_events`, retain the pending/answered `merge_handoff` intent and record
`landing` facts separately from confirmation; see
[autonomous outcomes](mc-autonomous-merge.md#reports-and-outcomes-for-plan).
It is not a v1 `STATE.json` and must never pass through v1 normalization.

Every mutation, including inactive send, takes the programme's plan lock, the project's plan lock when
applicable, then the existing strict register lock. It checks the expected
state revision and active run/role **after** taking those locks, then atomically replaces
one authoritative JSON file with `writeJsonAtomic`. Send writes only the PLAN
snapshot; it does not advance state revision or execution phase. A failed replacement leaves
the previous state intact. No operation holds these locks across remote IO.

`DRAFT.json` is a compatibility projection written **after** the authoritative
project state commits. Reads and all future v2 consumers must use the locked
`readAutonomousState` reader and its `contract`, not combine a raw draft with
state. If the projection write fails, the mutation may already have committed:
read the state revision; do not replay the old revision. The planner-owned
`recover` operation reconstructs the projection without a new contract or state
revision. `show` is read-only. Raw edits to the projection are never adopted.
Sending atomically writes the authoritative contract as an inactive `PLAN.json`;
it never adopts the draft projection or launches work.

## Typed command operations

The routed command modules take these argument vectors:

- `programme show <programme>`
- `programme draft|approve <programme> --expected-revision <n> --input-file <json>`
- `autonomous-project show <programme>/<project>`
- `autonomous-project create|revise|progress|report|confirm|attempt <programme>/<project> --expected-revision <n> --input-file <json>`
- `autonomous-project send|release|recover <programme>/<project> --expected-revision <n>`

`draft` accepts a complete draft programme contract; `approve` accepts only
`{by, at}` approval attribution and approves the exact stored draft. Only the
reserved `foreground-plan` run may do either. A headless `plan` cannot revise
the programme agreement. `create` checks the expected **programme state**
revision, the planner's reservation and the referenced approved contract.
Other project operations check the **project state** revision.

Only the active `plan` run, also owning the programme reservation, may revise
or confirm a project. A revision advances the goal revision exactly once,
keeps project/repository/programme identity and preserves commits, branch/PR,
reports, attempts and old contracts. All earlier-revision evidence is retained
but excluded from current evidence; current handoff and confirmation are
invalidated conservatively. Retired criterion IDs cannot be recycled in later
approved programme revisions or goal revisions. A new planner cannot replace a running builder:
the existing owner must release at a safe boundary first.

`step` may append builder progress; `review` may append independent reports.
Neither can change scope or confirm. Record attribution is stamped from the
active reservation and current contract, not trusted from the input. Evidence
IDs cannot be overwritten. Verification observations are not green gate
receipts or merge authorization. Planner confirmation is a separate attributed
decision, not inferred from builder or review progress.

`attempt` accepts `{id, reason, commits, branch?, pr?, handoff?}`; commits are
full SHAs. It appends an **incomplete** result, never a green handoff. Existing
branch/PR ownership cannot change. Review can record only failure metadata,
not implementation commits or publication identity. These references retain
attribution; this layer does not verify external report files or Git content.

Run reservations are trusted control-plane functions (`reserveProgrammeRun`,
`reserveProjectRun`, `releaseProgrammeRun`), not public claim/launch commands.
They enforce exclusivity and stable unique run IDs under lock. Commands use a
supplied runner context (`actor`) or `MC_AUTONOMOUS_RUN`/`MC_AUTONOMOUS_ROLE`,
which must exactly match the stored reservation; there is no `--role` override.
This is process ownership checking within mc's existing trusted work-root
boundary, not a new OS security principal or credential mechanism. The future
runner must reserve before invoking a role. This step adds no production
reservation caller and cannot activate autonomous work.
