# Autonomous programme contracts (inactive)

This is the contract layer only. No command, session launch, autonomous
publication, merge permission or deployment authority is added here. Existing
`mc-plan` v1 validation, fixed steps and register matching remain unchanged.
`PLAN_VERSION` remains 1. No existing project or programme is migrated.

## Version dispatch

`validateProject` in `src/mc/plan-schema.js` dispatches an explicit numeric
version 2 to `validateAutonomousProject`; invalid v2 never retries as v1.
Unknown versions are unsupported, including string versions. The legacy
`validatePlan`/`readPlanText` admission path still refuses **all** non-v1 plans,
including valid v2 contracts, until the later reader/command integration step.
They remain listed with their text and an unsupported diagnostic, not missing
projects. They cannot seed the v1 register, run steps or qualify for automatic
archiving. `planState` also refuses non-v1 rather than interpreting absent steps
as completion. `AUTONOMOUS_EXECUTION_ENABLED` is false; validating a contract
does not activate it.

## Programme snapshots

`src/mc/programme-contract.js` validates these fields:

- `schema: "mc-programme"`, `version: 1`, stable `id`, positive integer
  `revision`, and `based_on` (the preceding revision, 0 initially).
- `status: "draft" | "approved"`. Only approved snapshots carry `approval:
  { by, at }`, naming the approving person and an ISO instant. Attribution is
  data, not proof of authorization: the later guarded writer must enforce it.
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
A draft is a separate snapshot and is never an authority source. The next
step will persist approved history and drafts separately outside repositories;
these validators do not write `PROGRAMME.json` or other files.

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
criterion gets a new ID. Retired identities must not be recycled by the later
history-owning writer. `autonomousRevisionProblems` requires an exact
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
retagging or rewriting history. Preserving history and immutable report files
is the later state writer's responsibility. These views do not certify gate
coverage, independent models, current heads, complete reviews or merge safety.

`verification` is explicitly `premerge` or `after-integration`.
`criteriaForPhase` separates the sets: integration/deploy checks are not a
circular prerequisite to merging the change that enables their measurement.
They still belong to the goal and must be followed up before planner
confirmation. Phase selection supplies no new permission to deploy.
