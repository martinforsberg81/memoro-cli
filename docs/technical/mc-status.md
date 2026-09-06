# mc status — one project, and where the page went

`mc status <name>` answers about **one project**: what its `PLAN.json` says
right now, which decisions belong to it, its last three runner steps, and the
open pull request on its branch. It is a script — no model — it writes
nothing, starts nothing, and takes at most a `git fetch` and a `gh pr list`
off the network, both skipped by `--offline`.

Everything the verb prints is read from files the runner and the sessions
already write. This note says which file every fact comes from, why the plan
is read from the workarea rather than from `origin/main`, and what the status
board that `mc status` used to print was before it went.

Bare `mc status` prints no list. **The page is `mc`** (decision mc-3,
2026-08-29) — one surface that lists, and no other — so the bare verb says
where the page went and exits 2:

```
mc: mc status is now mc — one page, and it is what mc prints
    mc                  the page, and at a terminal a way in
    mc --json           the same page, as one object
    mc status <name>    one project
```

The page itself is [`docs/technical/mc-ui.md`](mc-ui.md). What it reads, this
project built: `nowBlock`, `kindFor`, `pidAlive`, `decisionsBlock` and
`areasWithCheckout` in `status-collect.js`, and the price table in
`prices.js`, are the readers `mc` borrows.

## What one project looks like

```
mc-status — memoro-cli · mc
  plan        docs/project/mc/mc-status/PLAN.json (workarea memoro-cli)
  workarea    ~/mc/mc-status
  status      ready
  budget      150k
  needs       []

NEXT
  Step 4 — close-out: `docs/technical/mc-status.md` says what `mc status <name>`
  and the page read, which file every fact comes from, and what the old board
  was; …

DECISIONS
  none

LAST RUNS
  08-29 06:42Z  step        880s  #427    success,merged
  08-30 11:31Z  repair      384s  —       success
  08-30 11:44Z  step        737s  #476    success,merged

OPEN PR
  none on this branch
```

`--json` prints the same object the renderer takes. `--offline` skips the
fetch and the `gh` call; the one thing it changes besides the OPEN PR block is
the status row, and it says so — see *The status row says the pair* below.

**`next:` gets a block of its own.** On a live plan it is a paragraph —
docx-editor's was 1 900 characters — so putting it in the label column
pushes every other field off the screen. It is folded at 90 columns, not
clipped: the whole of it is the point.

From the page's menu, `s <name>` runs this same verb and redraws
(`commands/home.js`). There is no second reading of the same files.

## Where the facts come from

| fact | file | written by |
|---|---|---|
| the plan, its state and its steps | `<workarea>/<repo>/docs/project/<programme>/<name>/PLAN.json`, else the same path on `origin/main` | the step sessions, through `mc run` |
| the workarea exists | `~/mc/<name>/` holding a checkout with a `.git` | `mc run`, `mc work` — never `mc plan`, whose session lives under `~/mc/plan/` and is not a workarea |
| the last three steps | `~/mc/runner/log/runs.tsv`, rows whose `name` is this project | `mc run`, after each step |
| the open pull request | `gh pr list --head <name>` in the project's repository | GitHub |
| whether the runner could start it at all | the workarea's `git status --porcelain`, `~/mc/runner/held.json`, the same open pull requests, and whether `~/mc/runner/STOP` is there | `mc run`, and whoever left the workarea dirty |

The readers are shared, not re-implemented: `planFields`, `scanDecisions`,
`parseDecision`, `runsFor` and `defaultRepos` all come from
[`brief-collect.js`](../../src/mc/brief-collect.js), so `mc brief`, the page
and this verb cannot disagree about what a plan says or which decision is
answered.

Nothing is asked of tmux and nothing of `ps`. A project is not a session.

## The plan is read from the workarea, not from main

A step is written, pushed, and merged **afterwards**, so `origin/main` is one
step behind for as long as the pull request is open — and the plan a person
asks about is almost always one that is being worked on right now. So:

- the workarea's working copy is preferred when there is one,
- `origin/main` is used when there is not,
- and the row says which: `(workarea memoro-cli)` or `(origin/main)`.

When both exist and their frontmatters differ, the row adds
`differs from origin/main`. The page never picks one silently.

A name that has a workarea but no plan anywhere is answered too — with
`no plan — this is a workarea without a project`. Those are the closure
candidates `mc run` will not remove by itself; the page lists them and
`~/mc/runner/unplanned-workareas.md` keeps them.

## The status row says the pair

`ready` on this row answers *the plan's first unfinished step is ready*, and it
was read as *this is being worked on, or is about to be*. Those are two
questions and until 2026-09-05 only the first was answered here: on that day
`mc status intake-inbox` and `mc status role-instructions` both printed a bare
`ready` while #612 and #614 sat in `held.json` and nothing could start either
project. So the row carries both halves, and it carries them on **one** row —
`ready` with the machine's answer on a row of its own is a row that invites a
reader to stop at the first one:

```
  status      ready · #614 is held before merge after a repair — the brief's (since 09-03 10:00Z)
  status      ready · uncommitted work in ~/mc/connections-section/memoro: hop-measure.mjs,
              probe.mjs (since 09-05 10:03Z)
  status      ready
```

The second half is `machineState` (`status-collect.js`), the same reading the
page's NEXT and the brief draw; what the two readings are and why there are two
is [`mc-run.md`](mc-run.md) § *The two readings, and what each answers*.
`machineNote` is the rule for when it says nothing, and there are three cases
and no others:

- **a refusal the plan already names is dropped.** The row exists to stop
  `ready` being read as runnable, not to print `blocked · blocked`.
- **`runnable` is silent.** That is most projects, and it is the case that must
  stay silent: a clause on every row would be noise nobody reads the day it
  matters. The third example above is exactly what it was before this existed.
- **the one loud `runnable` case is a hold still owed its repair**, because what
  the runner would start there is a repair session and not the step the plan
  names.

The workarea's absolute path is folded to `~`; it is otherwise most of a
terminal row.

**The machine half is asked of the plan on `origin/main`**, not of the workarea
copy the rows above it are read from, because `origin/main` is the copy the
round reads. Where the two differ the plan row already says
`differs from origin/main`, and a plan that is `ready` in the workarea while
main's is `blocked` now says so on the status row as well.

**`--offline` changes this row, and that is the honest answer rather than a
promise.** With no `gh` call the repository lands in `prsFailed`, which is the
round's own refusal for it, so every project reads
`ready · GitHub could not be asked what this repository has open` — measured on
2026-09-05, `mc status total-lane-cap --offline` against `~/mc`. A project with
something nearer in the way still reads that: the dirty worktree is asked first,
online or off.

## The cost estimate

`prices.js` is a dated list-price table — `PRICES_DATED = '2026-06'` — with
cache writes at 1.25× input and cache reads at 0.1× input. `estimateCost`
returns dollars for one usage line, or `null` for a model not in the table.

Two things are true about the number and both are printed with it:

- **It is a list-price estimate, never what Martin pays.** The subscription's
  quota is the real limit; the page says so and points at `/status`.
- **`runs.tsv` has no model column.** Every row is priced as the runner's
  model, `opus` (`RUNNER_MODEL` in `status-collect.js`), and the page names
  the model it assumed. `mc run` should write the model per row; until it
  does, a Sonnet step is over-priced here.

The estimate is large and dominated by cache reads: a day of about 30 steps
comes to roughly $120 list. The number is only summed on the page — this
verb prints seconds and a pull request number, not dollars.

Interactive sessions are out of scope: `runs.tsv` is the runner's own
accounting and nothing else is counted.

## What the old board was

Until 2026-08-29 `mc status` printed a **status board**: a scan of every
session home, its worktrees, its leases and the watcher's pulses, drawn from
1 417 transcripts in 7.26 s — later 1.92 s. Its subjects had already
outlived themselves. The local session store was emptied on 2026-08-13, the
PM round and the sessions watchman were deleted with `mc-dormant`, and what
was left was a page about sessions in a system whose unit of work is a plan.

The board went whole, in `mc-ui` under decision mc-3, before this project's
own step 3 arrived to retire it: `commands/status-board.js`,
`commands/status-page.js`, `renderLines` in `status-render.js`, and the
block-and-render half of `status-collect.js` — `collectStatus`,
`renderStatus`, `runnerBlock`, `projectsBlock`, `orphanWorkareas` — were
removed together with the flags that reached them. There is no flag that
brings it back.

Two things did **not** go with it, and saying so is the point of this
section:

- **`workStatus()` stays.** The board sat on top of it, but `mc repo status`
  regroups its worktree facts by repository and the lease-liveness check
  reads it. Only the board's own half went. Six tests that had used the board
  as a probe ask `workStatus()` directly now.
- **Leases and watchers are not gone.** `mc repo claim|release|who`,
  `mc repo watch start|stop|status` and the other verb families all
  still run and `mc --help` is right to offer them. The board read them; they
  did not leave with it.

**A retired surface leaves a sentence behind, and a sentence is a surface
too.** Bare `mc status` went on offering `mc --watch` — the page on a timer,
removed the same day it landed — which answers `unknown command "--watch"`;
and `docs/mc-command-matrix.md`, whose own rule is "if it is not listed here
it does not exist", still listed it. That was step 3's whole work.
`tests/mc/status-project.test.js` now runs **every `mc …` the sentence
offers**, so it cannot rot back into a menu of things that exit 2.

## The modules

| file | what it is |
|---|---|
| `src/cli/status.js` | the routing: a name, or the sentence saying the page is `mc` |
| `src/mc/commands/status-project.js` | the two flags, and printing |
| `src/mc/status-project.js` | what one project is — collect, the builders, the renderer |
| `src/mc/status-collect.js` | the readers more than one caller needs — `nowBlock`, `kindFor`, `machineState` and `machineDetail`, `pidAlive`, `readCurrents`, `areasWithCheckout` |
| `src/mc/status-render.js` | the drawing primitives — `painter`, `width`, `pad`, `clip`, `elapsed` |
| `src/mc/prices.js` | the dated list-price table |

The builders are pure — `fieldRows`, `wrap`,
`renderProject`, `findWorkareaPlan`, `findMainPlan` each take read data and
return their part — so `tests/mc/status-project.test.js` and
`tests/mc/status-collect.test.js` build every case from fixture files, with
git injected and `gh` stubbed. No test starts a session, opens a worktree or
reaches the network.

## Speed

Measured 2026-08-30 on this machine, three runs each:

| | live | `--offline` |
|---|---|---|
| `mc status <name>` | 1.7–2.2 s | 0.13–0.16 s |
| `mc --json` (the page) | 6.0 s | 5.8 s |

The verb is inside the five-second bound the plan set, and its live cost is
the two `git fetch`es and the `gh` call. The page is not, and `--offline`
barely changes it — which says the time is local work (73 areas under
`~/mc` walked, 24 git worktrees inspected), not the network. That number belongs to `mc`, and
[`docs/technical/mc-ui.md`](mc-ui.md) is where it is answered; it is recorded
here because this is where it was measured.

## History

Built as `docs/project/mc/mc-status/`, four steps: the four blocks and
`--json` ([#415](https://github.com/martinforsberg81/memoro-cli/pull/415)),
`mc status <name>`
([#427](https://github.com/martinforsberg81/memoro-cli/pull/427)), retiring
the board and the sentence that pointed past it
([#476](https://github.com/martinforsberg81/memoro-cli/pull/476)), and this
close-out. Decision mc-3 (2026-08-29) is what made the page `mc` and left
this verb one project to answer about.
