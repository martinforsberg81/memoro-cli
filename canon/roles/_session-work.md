## Runner or this session

The runner gets only finished work: every step buildable start to finish by a
headless session that has read nothing but the plan, with nothing for Martin
to look at before the next step starts. A step lands on `main` by itself; it
is never a checkpoint.

Everything else is done here, with Martin:

- anything he is to review — code, structure, UI, design, wording — before it
  lands or before the next part is built;
- investigation, measurement, prototypes, "find out whether";
- anything gated on his act: `mc deploy`, production data, remote migrations,
  credentials.

Never put work in the runner to get a review between steps. If step 3 waits on
Martin seeing step 2, do step 2 here; the plan starts after it, or not at all.
Mixed work: the reviewed part here first, landed; then a plan for what is left.

## Driving work in this session

1. Branch from main: `git fetch origin && git checkout -B <slug> origin/main`.
   `<slug>` is never a project directory name — `mc merge` would check the
   PR against that plan. In `~/mc/plan/<programme>/`, go back to
   `plan/<programme>` when done.
2. Build in pieces. At each review point stop and show Martin the thing
   itself — the diff, a screenshot (`mc shot`), the running app (`mc dev`) —
   with what you would do next. Build nothing past a point he has not seen.
3. `mc gate`, commit, `mc publish`, `mc merge <repo> <pr>`. Fix reds yourself
   on the same branch.
4. Deploy is Martin's: say what `mc deploy` would ship; run it when he says go.
5. More than one session: one open PR carries it. Its body says what is done,
   what is next, what is open; the next session starts with `gh pr view <n>`.
   No `PLAN.json`, no `mc step` entries for in-session work.
6. End: what landed (PR numbers), what is open. Swedish, short.

A plan already on `main` that turns out to need Martin between steps: run
`mc step blocked <project> <n> --on <name>` so the runner stays off, drive it
here, and `mc step done <project> <n> --pr <pr>` as each step lands.

## Unblocking a step

When Martin answers what a step waited on, the answer is written into the
plan — `contract`, the step's `instruction`, or a new step — so the plan
carries it on its own, reaching no further than his answer. Land it with
`mc merge --docs`, then `mc step ready <project> <n>`: a plan comes back by its
first unfinished step being `ready`, and by nothing else.
A failed or blocked step with an open PR: read the PR and the step's notes
first, then land or close that PR — `mc step ready` refuses while it is open.
