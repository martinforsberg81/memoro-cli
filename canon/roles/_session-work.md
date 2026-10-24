## Runner or this session

The runner gets only finished work: every step buildable start to finish by a
headless session that has read nothing but the plan, with nothing for Martin
to look at before the next step starts. A step lands on `main` by itself; it
is never a checkpoint.

Everything else is done here, with Martin:

- anything he is to review — code, structure, UI, design, wording — before it
  lands or before the next part is built;
- investigation, measurement, prototypes, "find out whether";
- anything gated on his act: `mc deploy`, `mc language`, production data,
  remote migrations, credentials. Those are his verbs; no session drives them.

Never put work in the runner to get a review between steps. If step 3 waits on
Martin seeing step 2, do step 2 here; the plan starts after it, or not at all.
Mixed work: the reviewed part here first, landed; then a plan for what is left.
Nor does a plan hold anything for Martin afterwards — no hand check, no
"Martin's" criterion, no review step: he tests once the project is done, and
nothing in the plan waits for that.

## Driving work in this session

1. Branch from main: `git fetch origin && git checkout -B <slug> origin/main`.
   `<slug>` is never a project directory name — `mc merge` would check the
   PR against that plan. In `~/mc/plan/<programme>/`, go back to
   `plan/<programme>` when done.
2. Build in pieces. At each review point stop and show Martin the thing
   itself — the diff, a screenshot (`mc shot`), the running app (`mc dev`) —
   with what you would do next. Build nothing past a point he has not seen.
3. `mc gate <files…>` (the tests your change reaches), commit, `mc publish` —
   it pushes, opens the PR and queues it for the merger in one call (a
   docs-only PR lands in the call); `mc step` and `merger.log` say what came
   of it. Once: do not poll — no loop, no `sleep`, no `mc merge watch`; the
   merger lands it without you. Fix reds yourself on the same branch, and
   `mc publish` again.
4. Deploy is Martin's: say what `mc deploy` would ship; run it when he says go.
5. More than one session: one open PR carries it. Its body says what is done,
   what is next, what is open; the next session starts with `gh pr view <n>`.
   No `PLAN.json`, no `mc step` entries for in-session work.
6. End: what landed (PR numbers), what is open. Swedish, short.

A plan already sent that turns out to need Martin between steps: run
`mc step blocked <project> <n> --on <name>` so the runner stays off, drive it
here, and `mc step done <project> <n> --pr <pr>` as each step lands.

## Unblocking a step

When Martin answers what a step waited on, the answer is written into the
plan — `contract`, the step's `instruction`, or a new step — so the plan
carries it on its own, reaching no further than his answer. Write it with
`mc project` verbs (the plan is under `~/mc/programs/`, and no pull request
carries it), then `mc step ready <project> <n>`: a plan comes back by its
first unfinished step being `ready`, and by nothing else.
A failed or blocked step with an open PR: read the PR and the step's notes
first, then land or close that PR — `mc step ready` refuses while it is open.
