# Autonomous programme contracts (inactive)

This is the versioned contract and inactive publication layer. Typed commands
can store and display contracts but grant no session launch, merge permission
or deployment authority. Existing `mc-plan` v1 validation, fixed steps and register matching remain unchanged.
`PLAN_VERSION` remains 1. No existing project or programme is migrated.

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
status|start|pause|resume` are the operator's
[programme operations](mc-programme-operations.md); start refuses on an
installation that does not support every control capability, which is every
installation until activation lands.

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
