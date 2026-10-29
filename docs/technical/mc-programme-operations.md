# Programme status, start, pause and resume

`mc programme status|start|pause|resume` are the operator's view and controls
for one autonomous programme. They sit beside the existing contract verbs
(`show`, `draft`, `approve`) and the planner's guarded verbs (`decide`,
`complete`, `cancel`). Existing v1 projects, their rows on the page, their
`mc status` output and the runner's default selection are unchanged.

## Explicit opt-in

A programme's `planner_jobs` mode starts `inactive` (absent counts as
inactive). Nothing activates it except `mc programme start`: not installing mc,
not opening `mc plan`, not reading status, not the runner's opt-in
reconciliation scan, which keeps an inactive programme inactive.

```
mc programme start <programme> --expected-revision <state revision> \
  --stop <planned stop id> --input-file start.json
```

`start.json` is `{ "by", "build": { "class", "profile" }, "review": { "model" } }`.
Start refuses, writing nothing, unless:

- the programme has an approved revision (a draft is never in force);
- `--stop` names one of that revision's `planned_stops`;
- `build.class` is `fast` or `large`, `build.profile` passes
  `validateControlProfile` (`src/mc/session-control.js`), and the class keeps at
  least one builder in the model catalog after `review.model` is reserved from
  it (`independentModel`, `src/mc/autonomous-models.js`);
- this installation supports every control capability in
  `CONTROL_CAPABILITIES` (`src/mc/programme-control.js`): `programme-jobs`,
  `programme-plan`, `build`, `review`, `control-signals`, `interrupt`;
- the caller is the operator: `MC_AUTONOMOUS_ROLE` unset or `foreground-plan`.
  Headless plan, step and review sessions are refused; plan is also refused by
  `reviewCommandRefusal`.

**No installation supports these capabilities yet.** `installationCapabilities`
returns an empty report with the reason *autonomous execution is not activated
in this installation*. Tests inject a report; fixtures are not support. So, as
landed, `start` always refuses on a real machine, and the runner still launches
v2 work only through `createRunner`'s injected `autonomous` capability, which
production never passes. `execution_enabled` stays `false`.

A successful start is one write under the programme and register locks: the
`activation` trigger event, mode `active`, and `planner_jobs.activation` —
approved revision, chosen stop, who and when, the build/review profiles and the
capability list. A second start is refused; a start applies once.

## Pause and resume

```
mc programme pause <programme> [--expected-revision <n>] [--by <name>]
mc programme resume <programme> --expected-revision <n> [--by <name>]
```

Pause is an idempotent hold, so it does not require a revision (a planner's
lease renewal must not turn an urgent pause into a stale refusal); a repeated
pause is a read and writes no new revision. It refuses an inactive programme and
one resting at a reached planned stop. It records who, when and the previous
mode and wait in `planner_jobs.pause`.

While paused, the existing mode checks refuse new work: `claimProgrammeJob`
claims no planner, `autonomousChoice` skips the programme (`programme-held`),
`startAutonomousBuild` and `startAutonomousReview` refuse, and the merge
admission door (`autonomousProof`) refuses. A clean review that finishes during
the pause is *held* rather than refused: `routeAutonomousReview` returns without
recording a refusal, so the route is still pending and is submitted after resume.

Work already started is not signalled, reverted or rewritten. A running build
finishes to its publication on the same PR; an independent review records its
report; a planner lease finishes or expires; acknowledging already-applied
effects stays possible. A merge queued before the pause is rechecked by the
admission door at landing and, if refused, is reported to plan as a merge event.
A merge that has happened is not undone. `mc programme status` lists all of
this under *in flight* until it has finished.

Resume requires the current revision and rechecks capability support and that
the approved revision still contains the activation's stop. It restores what the
pause interrupted: a wait goes back to waiting (reconciliation activates it when
due, with its retry event), an exception stays an exception for plan, anything
else becomes active. Resume applies only to a paused programme; a reached
planned stop needs a new agreement, not a resume.

Every start, pause and resume is appended to `planner_jobs.control`.

## Status

`mc programme status <programme> [--json]` (`src/mc/programme-status.js`) is a
read: it takes the same locks as other readers and writes nothing. It shows:

- mode, whether this installation can execute autonomous work and what is
  missing, approved and draft revisions, the state revision to pass back;
- the activation (when, by whom, build class and reviewer model) and the
  planned stop it runs to, with whether it has been reached;
- plan ownership: plan owns goals and confirmation; its current lease, pending
  trigger events and unreconciled operation intents;
- a known wait or exception, the pause record, and everything *in flight*;
- the next automatic action, which says plainly when nothing will happen
  (inactive, paused, stopped, exception, or an installation that cannot run it);
- per goal: phase, goal/programme revisions and alignment, branch/PR, builder
  status per criterion (current goal revision only), evidence quality, the
  publication's gate receipt, incomplete attempts, older-revision observations
  ignored, the latest review and its findings (stale when its head or revision
  is not current), actual builder models for this revision, the reserved and
  actual reviewer, session control phase/reason/activity/context, publication
  and merge state, waits, and the goal's next action (marked held when the
  programme is not active);
- v1 projects in the programme directory, listed as unchanged.

A missing reading is `unknown`: a session without a fresh context reading shows
`context unknown`, an unpublished goal `gate none recorded` or `not yet
measured`, never green. Damaged programme or goal state is reported as a
problem with `unknown` next action, and is left as it is for recovery.

`mc status <project>` for a v2 project adds the programme's mode and the goal's
next action. The page (`mc`) draws an `AUTONOMY` block after PROGRAMMES, one line
per programme that has `PROGRAMME_STATE.json`; with none, the page is unchanged.

## Archive

A programme with autonomous goals ends the way every programme does, with
`mc plan <programme> --archive` ([mc-plan.md](mc-plan.md#archiving-a-programme)),
and only then: the runner never archives a v2 goal on its own. The archive is
refused while any goal is not confirmed by plan (a landed goal is not), while
the programme is active, paused, waiting or in an exception, or while a plan
session holds its lease. Before that every programme record stays where it is;
after, the programme's directory, its `PROGRAMME_STATE.json` and every goal's
state with it, moves whole to `~/mc/archive/programs/<programme>/`.

## Verification

`mc gate tests/mc/programme-status.test.js` covers the inactive default and
the refusal on an unsupporting installation, every start precondition, the
rendered status of a building, reviewed and revised goal, a claimed planner,
pause/resume with in-flight work, held merge submission, restored waits and
exceptions, reached stops, damaged state, v1 projects in the programme, the
page block and the `mc status` lines.

The acceptance scenarios run end to end on real temporary repositories:
a bare origin and its primary clone, the real runner, planner journal,
independent review, merge admission, leased merger round and archive. GitHub
(a PR store that squashes the pinned head into the origin's main), the model
sessions and the merge round's gate are deterministic adapters
(`tests/mc/autonomy-lifecycle-fixture.js`); no model is called.

- `mc gate tests/mc/autonomy-lifecycle.test.js`: one goal from a deliberate
  start through fresh bounded sessions, a main conflict integrated by the next
  session, review findings to plan only, a plan revision on the same branch and
  PR, a clean review, the exact-head landing, after-integration confirmation,
  the planned stop and the programme archive; a closing mid-criterion with a red
  gate or a forced exit; a real process that ignores closure (and SIGTERM) and
  one that loses its clock; a long gate that keeps its lane and its builder; a
  crash after the push, after PR creation, after the review report, after the
  merge intent, after the merge and after plan's confirmation, each recovered to
  one PR, one merge and one confirmation; main or head movement and damaged
  ownership after review; one red main shared by two goals becoming one
  incident and one repair, a quota wait, and stagnation counted across sessions.
- `mc gate tests/mc/autonomy-coexistence.test.js`: a v1 project beside a v2
  goal in one runner under one lane cap, with its prompt, plan and merge door
  unchanged; no activation by status, reconciliation, the installed runner or
  an unsupported start; pause and resume with work in flight while v1 runs; the
  planned stop with v1 running on and a foreground draft that changes no active
  work.
