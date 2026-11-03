## `mc step`: a step that waits

A plan already sent that turns out to need Martin between steps: run
`mc step blocked <project> <n> --on <name>` so the runner stays off, drive it
in this session, and `mc step done <project> <n> --pr <pr>` as each step lands.

When Martin answers what a step waited on, the answer is written into the
plan — `contract`, the step's `instruction`, or a new step — so the plan
carries it on its own, reaching no further than his answer. Write it with
`mc project` verbs (the plan is under `~/mc/programs/`, and no pull request
carries it), then `mc step ready <project> <n>`: a plan comes back by its
first unfinished step being `ready`, and by nothing else.
A failed or blocked step with an open PR: read the PR and the step's notes
first, then land or close that PR — `mc step ready` refuses while it is open.
