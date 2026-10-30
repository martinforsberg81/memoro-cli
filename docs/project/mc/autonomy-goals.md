# Autonomy goals: a goal is the unit of autonomous work, beside unchanged projects

System: memoro-cli (the `mc goal` and `mc programme` verbs, the runner, the
page, the plan role). Worked out with Martin on 2026-10-29 (ruling 60) after
the seven `autonomy-*` projects of the 2026-10-28 implementation plan landed
(#1157, #1158, #1159, #1160, #1161, #1162, #1170). Read it before writing any
plan for the autonomous mode; it replaces the model those projects were sent
with, not the code they built.

## Where this starts from

Everything the implementation plan asked for is on `main` and proven on real
temporary repositories: versioned contracts and state, gate receipts, bounded
fresh sessions with handoffs, cooperative and forced closure, dynamic build
sessions on one branch and PR, independent review, the autonomous merge door,
the programme job queue with leases, headless plan sessions, recovery, and the
operator's status, start, pause and resume. `mc programme capabilities` on
this machine reports all six control capabilities built and none supported:
the installed runner passes no autonomous capability, there is no production
awake clock that excludes machine suspend, no trusted checkpoint verifier, and
no provider process has ever been observed on the new path. `start` therefore
refuses everywhere, by design.

Before closing those gaps, the model itself was reviewed. The implementation
plan had made the autonomous mode a second system: an approved programme
contract (goal, specification, scope, criteria, authority, planned stops) as a
precondition; `start` taking a build class, a control profile and a reviewer;
goals created only by the headless plan through a `decide` envelope under a
lease; `landed` kept apart from `confirmed`, with archive waiting for the
latter. Martin's answers (ruling 60) change that shape. What follows is the
model as agreed, including the autonomy-off and explicit phase-completion
clarification accepted by Martin with "Go." on 2026-10-29 (appended to ruling
60).

## The model

A **programme** is a directory under `~/mc/programs/`, as today, with its
brief under `docs/project/<programme>/`. It holds, side by side:

- **projects** with fixed steps: `mc project` verbs, the register, the review
  step mc appends, the legacy merge door. Nothing here changes for them.
- **phases**, ordered, each a name and a line of purpose: *1 grunden*, *2
  pilot*. A phase stays open until a shared planning operation explicitly
  completes it, after all its goals have landed and all follow-ups have
  measured evidence.
  An empty phase never advances automatically. Phases are the only
  programme-level ordering.
- **goals** inside phases. A goal is the unit of autonomous work: one
  repository, one branch, one PR, criteria with stable ids and a verification
  phase (`premerge` or `after-integration`), a work class (`fast` or `large`,
  ruling 59), a contract and an out-of-scope list, and **no steps**. It is
  built in as many fresh bounded sessions as it takes.

Goals are a concept of their own so that projects are untouched: separate
verbs, separate state, a separate reader on the page. A programme may hold
only projects, only goals, or both.

```
programme  mc                       brief in docs/project/mc/, autonomy on|off
  phase 1  grunden
    goal   runner-wiring   fast     criteria; sent; built in n sessions
    goal   awake-clock     fast
    goal   verifier        large    --after runner-wiring
  phase 2  pilot
    goal   …
  project  ui-overview              fixed steps, exactly as today
```

### Verbs

```
mc programme phase add <programme> <n> "<name>"
mc programme phase complete <programme> <n>  # explicit; all goals landed, follow-ups measured
mc goal new <programme>/<goal> --phase <n> --repo <repo> --class fast|large \
    --goal … --contract … --out-of-scope …
mc goal criterion add <programme>/<goal> --id <id> --criterion … --instruction … \
    --check … --verify premerge|after-integration
mc goal send <programme>/<goal> [--after <goal>]
mc goal revise <programme>/<goal> …        # a new goal revision on the same branch and PR
mc goal show <programme>/<goal>
mc goal done <programme>/<goal>            # after-integration criteria measured, or none
mc programme autonomy <programme> on|off [--stop "<condition>"]
mc programme status <programme>
```

Sending an assignment makes the current goal revision ready for a build when
its selected dependencies have verified landings. Otherwise it remains
pending, and the dependency scanner releases it when those exact revisions
land. A revised assignment is sent again to make it ready; that send keeps its
dependencies, pinned to their current revisions, unless `--after` names others.
Sending never starts a session or enables the production autonomous runner.

The same verbs serve the interactive plan session and the headless one. A
headless session differs only in that it runs under the runner's lease and
its effects are recorded in the programme's job queue, where idempotency
lives. There is no `decide` verb and no decision-kind catalogue: "Verbet decide
saknar värde. Ta bort."

Nothing a headless plan can do is withheld from the interactive plan.
`MC_AUTONOMOUS_ROLE` gates step and review sessions out of planning verbs, as
today; it never gates the foreground plan out of anything.

### Class, profile, review

- The **class** belongs to the goal, set by whoever creates it. A goal's
  sessions route through that class as steps do (ruling 59).
- The **control profile** (soft, upper and emergency limits on active time and
  context, the closing reserve for gate, fixes, commit, push and handoff, tool
  and lane waits, total awake time, stagnation and failure ceilings) is
  **system configuration**, calibrated once in the pilot and changed with an
  `mc` verb, never chosen per programme, goal or start. "Profil är inget som
  planeras per projekt. Det vi tar fram är hur det ska fungera."
- The **review model** is the one `mc model set review` names, reserved from
  the builder pool so that the reviewer never built what it reviews
  (`independentModel`). It is not chosen per programme.

### Building a goal

A sent goal is picked by the runner as a sent step is: under the same lane and
total caps, the same capacity snapshot and provider refusals, the same
subscription-first routing. Each session starts fresh on current `main`, gets
the goal, the programme's brief and at most one compact handoff within the
64 KiB start bound, builds within the profile, runs the affected gate to a
receipt, commits only the measured content and pushes to the goal's one PR.
The next session continues from the handoff. When every premerge criterion is
reported with evidence, the runner starts the independent review; a clean
report on the current head is queued to the existing merger, which rechecks
it at the autonomous door. All of this is what the `autonomy-*` projects built
and is kept as it is.

Goals in an open phase run **in parallel** by default, one session per goal at
a time; `--after` orders them within the phase. Fewer sessions is a matter of
putting more points under one goal.

### Done and after-integration

A goal is **done** when its premerge criteria were reviewed clean and the PR
landed, the way a project is done when its review step lands. That is the
event the headless plan wakes on. Criteria verified after integration (a
deploy, a measurement in the running app) do not hold the merge and do not
make a second "confirmed" state: they are a follow-up row on the phase until
somebody, headless or interactive, measures them and runs `mc goal done`. A
phase can be completed explicitly by either planning session when all its
goals have landed and no follow-up is open; an empty phase never advances
automatically. Archiving a programme waits for that, as it waits for a project's close-out today, and
not for a planner's confirmation ceremony.

### The event queue

Everything that stops a goal from moving is an event in the programme's queue:
an incomplete attempt (red gate, forced exit, crash, missing observation), a
review with findings, a goal done with after-integration criteria open, a red
main in one of the programme's repositories, a dependency done, a phase with
every goal done. The queue exists whether or not anything consumes it
automatically:

- With **autonomy off** (the default, and what every programme has today),
  the events are drawn on the page and in `mc programme status` for the
  interactive plan session. Only new headless planner claims are disabled;
  already sent goals continue to build, review and merge.
- With **autonomy on**, a headless plan session is started per event with the
  programme's brief, its phases and goals, the event and the queue. It is a
  plan session: it reads the code, judges and uses the verbs above. It is
  **goal-driven from the programme's description**, not a list of permitted
  actions: it decides what the next goal in the phase is, whether to revise a
  goal after findings, whether a red main needs a repair goal, whether the
  next phase opens, or whether the stop condition is reached and it should do
  nothing. "headless session ska inte hårdkodas … den ska vara målstyrd
  utifrån programmets beskrivning."

`autonomy on` takes an optional stop condition in prose, read by the headless
plan; without one, the programme stops when its last phase is done. `off`
disables only new headless planner claims. Already sent goals continue to
build, review and merge; their events wait for foreground planning or a later
headless claim. Turning autonomy on is Martin's act, like start was; it is refused while the installation's
capability report says any control capability is missing.

## What changes against main

| On main today | This brief |
| --- | --- |
| `mc programme draft/approve`: a revisioned programme contract as the precondition for anything autonomous | gone as a precondition; the brief under `docs/project/<programme>/` is the programme's description |
| `mc programme start` with build class, control profile, reviewer and planned stop; `pause`/`resume` | `mc programme autonomy on|off [--stop …]`; class on the goal, profile and review in configuration |
| goals created, sent, revised and confirmed only by the headless plan through `mc programme decide … --input-file` under a lease | `mc goal` verbs for both plan sessions; the job queue keeps idempotency and the headless lease |
| `mc autonomous-project send` beside `mc project send` | `mc goal send` |
| `landed` ≠ `confirmed`; archive waits for plan's confirmation | done at landing; after-integration criteria as follow-up rows; `mc goal done` |
| phases do not exist; dependencies are planner-selected per goal | ordered phases on the programme; `--after` within a phase |
| the page draws one AUTONOMY line per programme with `PROGRAMME_STATE.json` | goals and phases drawn under the programme like projects (see *The page*) |

Kept as built: autonomous state and revisions, gate receipts and their reuse,
session control, observation and supervision, handoffs, the build dispatcher
and publication, independent review and report, the autonomous merge door,
outcomes to plan, the job queue with leases and reconciliation, recovery,
coexistence with v1 under one runner. The work is in the contract layer and
the verbs, not in the machinery.

## The page

With phases and goals the row model `steps n/m · next step` no longer fits.
Under a programme's heading the page draws:

- its phases in order, each with `goals done/total` and its follow-up count;
- one row per goal: phase, repository, state in the goal's phase
  (`ready`, `running`, `closing`, `publishing`, `review`, `for plan`,
  `landing`, `done`), `criteria k/n` premerge and `j/m` after integration,
  the session count and the current session's context and time against the
  profile (or `unknown`), the PR, the latest review (`clean`, `findings`,
  `stale`), and what happens next;
- the programme's queue: what waits for a plan session, with age, the one
  list that concerns Martin;
- the project rows exactly as today, after the goals.

`mc programme status <programme>` keeps the detail in text. This is design
work for the interactive session with `mc shot` before it is planned.

## Activation gaps

Unchanged from the capability report, and to be planned as goals or projects
of this programme once the verbs above exist:

1. **Runner wiring.** `mc run` builds the production capability the seam
   wants: profile from configuration, poll cadence, review, clock, the `mc
   gate` adapter, publication requirements and deps, conflict integration,
   the checkpoint verifier, job and plan consumers. `installationCapabilities`
   then reports what the runner actually passes instead of a frozen constant.
2. **Awake clock.** `awake_ms` must exclude machine suspend; Node has no such
   clock. Measure here first (wall against monotonic drift across a sleep,
   with `stay-awake.js`'s caffeinate held), then build.
3. **Checkpoint verifier.** The default verifier reports no progress, so the
   no-progress clock always runs; a trusted one measures the criterion's
   check.
4. **Review session whose runner dies** has no recovery path (it stays owned).
5. **Provider pilot.** Control signals, interruption and context readings are
   proven only with fixture processes. One goal built end to end with real
   Claude and Codex sessions, measured, is what turns the capability report
   from *missing* to *supported*. Martin's act; costs model usage; done in the
   interactive session.
6. **Profile calibration** from the pilot's measurements.
7. **Credits.** The autonomous path requires subscription billing;
   `--billing credits` starts no goal session. A decision, then possibly a
   small change.

Operational, outside the code: the runner's disk was below its 5 GiB dispatch
floor on 2026-10-29 (proposal `2026-10-29-mc-low-runner-disk`), which skips
all dispatch until cleared.

## Out of scope

Migrating projects to goals, rewriting the register, a new service or
database, repair roles, deployment authority for headless sessions, letting a
headless session change a programme's brief or phases beyond what its stop
condition and the brief allow. A project with steps keeps every rule it has.
