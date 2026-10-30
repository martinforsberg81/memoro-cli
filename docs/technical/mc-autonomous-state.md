# Revisioned autonomous data (inactive)

This is the persistence layer for explicitly opted-in v2 goals. It does not
launch sessions, enable execution, publish code or queue a merge. The
legacy v1 register and its matching rules are unchanged. Command modules are
lazily routed by `src/mc-cli.js`; v2 contract publication
and display are described in [the contract integration](mc-autonomous-programmes.md).

## Storage and atomicity

All files are outside repositories, under `programs/<programme>/` in the mc
work root. The ruling-60 format uses `mc-programme-state` **version 2** with
`metadata: {id, brief}`, a mutation `revision`, reserved planner ownership and
append-only run/metadata history. There is no programme approval schema or
approved-revision authority. Its optional durable planner outbox retains events,
leases and operation receipts. `execution_enabled` remains false.

Each goal has `AUTONOMOUS_STATE.json` (`mc-autonomous-state`, **version 2**).
Its explicit v2 `mc-plan` assignment has `programme: {id}`, `work_class`
(`fast` or `large`), `programme_phase` (a positive integer distinct from the
runtime phase) and `goal_revision`. State keeps immutable assignment history,
stable criterion observations, independent reports, branch/PR ownership,
commits, execution phase, handoffs, owners and incomplete attempts. Events,
merge handoff and landing facts remain durable. It never enters v1 register
normalization. Pre-ruling-60 programme/goal state, even relabelled as version 2,
is explicitly unsupported and preserved; there is no automatic migration.

Every mutation takes the programme plan lock, the goal plan lock when
applicable, and the strict register lock. CAS and ownership are checked inside
them. Send commits its durable sent marker before projecting PLAN; replay of
a settled identical send does not duplicate history. A failed atomic state
replacement leaves the previous state intact. Locks never span remote IO.

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
- `programme metadata <programme> --expected-revision <n> --input-file <json>`
- `autonomous-project show <programme>/<project>`
- `autonomous-project create|revise|progress|report|confirm|attempt <programme>/<project> --expected-revision <n> --input-file <json>`
- `autonomous-project send|release|recover <programme>/<project> --expected-revision <n>`

These are transitional entry points pending ordinary `goal` verbs. The old
`draft`/`approve` routes remain present but refuse: they grant no authority.
Foreground planning obtains an operation actor internally and needs no lease.
Headless planning must prove the exact programme reservation, token and live
lease. Builders/reviewers cannot author assignments. Creation CAS checks the
programme state revision; other goal writes check the goal state revision.

A revision advances `goal_revision` by exactly one, preserves repository,
goal/programme identity, branch/PR, commits, attempts and reports, and appends
the assignment to history. Retired criterion IDs cannot be reused. Current
execution projections are invalidated, not their immutable evidence/history.
Active build/review/merge owners or unresolved builder claims fence revision.
Landed scope is immutable. Evidence binds programme/goal identity and the goal
revision, never a programme state revision: context or another goal changing
cannot stale exact publication/review evidence. Exact content, head, base,
report digest and independent-model checks remain required at every merge.

Autonomy off disables only new headless planner claims. Sent goals continue
build, review and merge. The installed runner still has no autonomous
capability, so this cutover activates nothing. Confirmation/dependency follow-up
semantics and obsolete entry-point removal are subsequent project steps.

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
