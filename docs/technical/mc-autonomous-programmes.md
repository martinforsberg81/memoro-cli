# Autonomous programmes (opt-in, not supported by the installed runner)

This is the versioned contract, its CLI and the rollout state of the whole
autonomous mode. Typed commands store and display contracts but grant no
session launch, merge permission or deployment authority. Existing `mc-plan` v1
validation, fixed steps and register matching remain unchanged. `PLAN_VERSION`
remains 1. No existing project or programme is migrated.

## V1 and v2 boundaries

| | mc-plan v1 (default) | mc-plan v2, `execution.kind: "autonomous"` |
| --- | --- | --- |
| Work unit | fixed `steps[]`, one session each | one goal with stable criterion IDs, as many fresh sessions as it needs |
| Who changes it | `mc project` verbs and `amend` | plan only (`mc programme decide`), within the approved programme |
| Review | v1's appended final review step, which may mend | independent review on another model, report only ([review](mc-autonomous-review.md)) |
| Failure | `mend`, retries, failed-to-person | incomplete attempt to plan ([recovery](mc-autonomous-recovery.md)); no repair role |
| Merge | `mc publish` / `mc merge`, the legacy door | runner queues a clean reviewed head; the autonomous door rechecks it ([merge](mc-autonomous-merge.md)) |
| Done | register `done`, automatic archive | plan's confirmation; only `mc plan <programme> --archive` |
| Runs when | sent and ready | sent, and the programme started by the operator on an installation that supports it |

Each reader dispatches on the plan's version: a v1 plan never reaches a v2
path and a v2 contract never falls through to v1's. Nothing below changes v1.

## Version dispatch

`validateProject` in `src/mc/plan-schema.js` dispatches an explicit numeric
version 2 to `validateAutonomousProject`; invalid v2 never retries as v1.
Unknown versions are unsupported, including string versions. `readPlanText` and
plan-source readers use that dispatch: a valid v2 contract
is readable, while the fixed-step `validatePlan` still refuses it. Status and
runner selection report valid v2 as `inactive`, never ready or done. Malformed
v2 and unknown versions remain listed with diagnostics, not missing projects.
They cannot seed or overlay the v1 register, run steps or qualify for automatic
archiving. Even a legacy `CLOSEOUT.json` cannot hide a non-v1 plan or make it
an archived project. Legacy mutation, amendment, archive and discard commands
refuse these contracts. `AUTONOMOUS_EXECUTION_ENABLED` is false; validating a
contract
does not activate it.

## Programme snapshots

`src/mc/programme-contract.js` validates these fields:

- `schema: "mc-programme"`, `version: 1`, stable `id`, positive integer
  `revision`, and `based_on` (the preceding revision, 0 initially).
- `status: "draft" | "approved"`. Only approved snapshots carry `approval:
  { by, at }`, naming the approving person and an ISO instant. Attribution is
  data, not proof of authorization: the guarded state writer enforces run
  ownership.
- `goal` and `specification`: nonempty paragraph arrays.
- `scope: { included, excluded }`: nonempty paragraph arrays in both directions.
- `success_criteria`: nonempty `{ id, criterion, check, verification }` entries.
- `authority`: programme revision belongs to `foreground-plan`, goal revision
  and confirmation to `plan`, implementation to `step`, review to `report-only`.
  Keys are `programme_revision`, `goal_revision`, `confirmation`,
  `implementation`, `review`. There is no repair role or deployment grant.
- `planned_stops`: nonempty `{ id, condition }` entries describing agreed stops.

`programmeRevisionProblems(approved, next)` refuses any alteration of an
approved revision in place. An identical snapshot is allowed for idempotent
reads; new content requires the next consecutive revision and its exact base.
A draft is a separate snapshot and is never an authority source. Approved
history and drafts persist separately in `PROGRAMME_STATE.json`
outside repositories; the validators themselves perform no writes. See
[revisioned state and guarded operations](mc-autonomous-state.md).

## Autonomous goals and observations

`src/mc/autonomous-project.js` validates `mc-plan` version 2:

- Stable `project_id`, one named `repo`, `execution: { kind: "autonomous" }`,
  `programme: { id, revision }`, positive `goal_revision`.
- Nonempty paragraph arrays for `goal`, `instruction`, `contract`,
  `out_of_scope`; `documents` uses v1's `{ label, path }` entries.
- Criteria use `{ id, criterion, instruction, check, verification }`, with
  nonempty instruction paragraphs. There is no `met` flag or fixed `steps`.

All IDs are explicit lower-case names (letters, digits and hyphens, at most
64 characters), unique within their collection, not derived from text or
positions. Reordering or rewording retains an existing criterion ID; a new
criterion gets a new ID. The state writer prevents recycling retired identities.
`autonomousRevisionProblems` requires an exact
one-increment goal revision, stable project/repository/programme ownership,
and no backwards programme revision. An optional `programme` argument to
`validateAutonomousProject` checks the exact approved reference. Without it,
validation checks shape only, not programme authorization or semantic scope.

`validateAutonomousEvidence` represents three separate observations:

- `builder`: progress records with stable `id`, `run_id`, `project_id`,
  `programme_id`, `programme_revision`, `goal_revision`, `criterion_id`,
  `status` and `reference`. Status is pending, working, verified, failed or
  unknown; verified requires an evidence reference, others a reference or null.
- `reviews`: independently attributed report records with the same identity
  and revision fields, an immutable report `reference`, `findings` and
  `criteria: [{ criterion_id, status, reference }]`. Review status is verified,
  finding, unknown or deferred. No omitted answer becomes a clean report.
- `confirmation`: null or a separately attributed planner decision record
  with the same identity/revision fields, `role: "plan"` and `reference`.
  Builder progress and a clean review do not imply confirmation.

Evidence IDs are unique across the envelope. `evidenceForRevision` selects
only observations belonging to the exact project, programme and revisions;
builder progress also matches criterion IDs. A goal revision conservatively
invalidates all prior observations, including confirmation, without deleting,
retagging or rewriting history. The state writer preserves history and immutable
report references. These views do not certify gate
coverage, independent models, current heads, complete reviews or merge safety.

`verification` is explicitly `premerge` or `after-integration`.
`criteriaForPhase` separates the sets: integration/deploy checks are not a
circular prerequisite to merging the change that enables their measurement.
They still belong to the goal and must be followed up before planner
confirmation. Phase selection supplies no new permission to deploy.

## CLI and inactive publication

The lazy route table used by `src/mc-cli.js` exposes `mc programme` and
`mc autonomous-project`; both support `--help`. Their `show` operations are
read-only, and mutations require the reserved role/run and expected state
revision. There is no public reservation command. `mc programme
capabilities|status|start|pause|resume` are the operator's
[programme operations](mc-programme-operations.md); start refuses on an
installation that does not support every control capability, which is every
installed mc today (see *Rollout state* below).

`mc autonomous-project send <programme>/<project> --expected-revision <n>`
(or `mc project send <project> --expected-revision <n>`) checks the authoritative
state contract against its exact approved programme revision under the same
locks and planner ownership checks as other mutations. It writes an atomic
`PLAN.json` snapshot, leaves `DRAFT.json` as a non-authoritative projection and
returns `execution_enabled: false`. Repeating the typed send is idempotent for
an identical snapshot; a different existing PLAN is refused. A failed write
leaves no successful publication. No v1 review step is appended and no phase,
run reservation, branch, PR, gate result or merge queue entry is changed.
Sent goal revision is deliberately unsupported until execution integration.

`mc project <name>` reads a v2 draft from authoritative state, not raw draft
edits; `--json` exposes that state. For sent contracts, `mc status <name>` and
`mc project <name>` show whether this installation executes autonomous work,
the programme's mode and the goal's next action, programme/goal/state revisions,
phase, branch/PR ownership, separately recorded planner confirmation and current
builder observations by stable criterion ID. Missing evidence is `unknown`;
missing, malformed or mismatched state is reported rather than guessed. JSON
status includes current revision evidence. These reads never seed a v1 register
or launch a session. `--offline` avoids repository/GitHub refreshes.

V1 remains the default: its draft/send validation, automatic final mutating
review, register interpretation and publication/merge/recovery behavior are
unchanged. This independent v2 review evidence is not that v1 review step;
it reports findings without implementing repairs. Plan alone revises goals
or records confirmation, within approved programme authority and planned stops.

## Programme authorization and deliberate activation

Authority comes from three separate acts, none implied by another:

1. **Agreement.** The foreground plan with Martin drafts the programme
   (`mc programme draft`) and approves it (`mc programme approve`). The
   approved revision is immutable; its scope, criteria, authority and planned
   stops bound everything after it. A draft is never in force.
2. **Start.** The operator runs `mc programme start` naming the approved
   revision's planned stop and the build class, control profile and reviewer.
   Nothing else activates a programme: not installing mc, opening `mc plan`,
   reading status, the runner's reconciliation scan or sending a goal.
3. **Plan's decisions.** Within the started programme, headless plan creates,
   sends, revises, resumes and confirms goals and reaches the planned stop
   ([programme plan](mc-programme-plan.md)). It cannot change the agreement.

Pause and resume are the operator's too. Headless plan, step and review
sessions are refused start, pause and resume.

## Closure budgets and unknown context

The session budgets are the `build.profile` given at start, validated by
`validateControlProfile` and stored in the activation; there is no default
profile and no universal minute or token value. A profile sets soft, upper and
emergency active time and context fractions, the closing reserve for gate,
fixes, commit, push and handoff, tool and lane waits, total awake time,
no-progress time and the stagnation and failure ceilings
([session control](mc-session-control.md)).

A soft limit asks a session to finish after a newly measured criterion; an
upper limit asks even mid-criterion; an emergency limit stops it and records an
incomplete attempt. Context that cannot be read is `unknown`, never zero: the
time and checkpoint limits still close the session. Codex reports no current
context at all; Claude's is an estimate (see the capability report below).

## Non-green recovery

A red gate, a forced or unexpected exit, a crash, missing observations or
unknown child processes are incomplete attempts: the work is preserved outside
the checkout, ownership stays held and the attempt goes to plan, never into a
green handoff ([recovery](mc-autonomous-recovery.md),
[programme recovery](mc-programme-recovery.md)). Plan diagnoses and retries with
a different approach, waits, or records an exception; repeated failure and
stagnation are counted across sessions. Main moving after review, a stale
report, a changed head or broken ownership refuses merge and reports to plan.

## Rollout state

`mc programme capabilities [--json]` is the installation's own report
(`installationCapabilities`, `src/mc/programme-control.js`). Every control
capability is built and proven by tests with fixtures, and none is supported:

| Capability | Proven by | Missing for support |
| --- | --- | --- |
| `programme-jobs`, `programme-plan`, `review` | temporary state, real temporary repositories, scripted sessions | the installed runner (`runLoop`) passes no autonomous capability |
| `build` | the same | that, and a production awake clock that excludes machine suspend |
| `control-signals` | real fixture processes in both prompt shapes reading the durable `mc session-control status` | observation with a provider process |
| `interrupt` | a real fixture process ignoring finish-session and SIGTERM, closed with its child | observation with a provider process; the production clock |

Transport, from the 2026-10-28 version and help probes only
([observation](mc-session-observation.md#what-was-actually-measured)):

| Tool | Prompt | Live control | Current context |
| --- | --- | --- | --- |
| Codex exec JSONL (`codex-cli 0.164.0`) | positional argument, stdin ignored | none; durable `mc session-control` | unavailable: usage is cumulative |
| Claude print stream-json (`2.1.312`) | first stdin user message | none added; durable `mc session-control` | estimate from the last request input |

Not proven with actual provider output: live context telemetry for either tool,
native live-control delivery, a provider session reading the durable control,
interruption of a provider process group, a production suspend-aware clock and
any paid model behaviour. No live model pilot has been run. So `start` refuses
on every installed mc, `execution_enabled` and `AUTONOMOUS_EXECUTION_ENABLED`
stay false, and no existing programme can be activated. Supporting it needs the
runner wiring and clock above and a measured provider pilot; then the report is
what changes, not the start door.

## Verification

- `mc gate tests/mc/programme-cli-smoke.test.js`: the documented commands as
  real processes on a disposable programme (see
  [operations](mc-programme-operations.md#verification)).
- `mc gate tests/mc/autonomy-lifecycle.test.js tests/mc/autonomy-coexistence.test.js tests/mc/programme-status.test.js`:
  the acceptance scenarios beside a v1 project.
