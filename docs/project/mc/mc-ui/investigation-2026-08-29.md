# mc ui — investigation, 2026-08-29

Martin: *"Vi behöver göra om UI för mc … en polerad terminal-UI. Det som helt
saknas är några sektioner: en runner queue. Vad körs. Hur många ligger i queue.
etc. Vad hanteras i mc brief, eller olika mc plan. Man borde också se en siffra
för hur mycket som ligger i intake."*

Every claim below is marked **M** (measured — I ran it or read the code on this
machine, 2026-08-29 07:10–07:20Z) or **A** (assumed — reasoning, not observation).

## 1. What the front door prints today

**M.** Bare `mc` routes to `src/cli/list.js` (`src/mc-cli.js`, line ~55:
`if (args.length === 0) return runModule('./cli/list.js', [])`). It prints the
V1 sessions table:

```
mc sessions · 1 local · 0 cloud

Local sessions
  Open: mc open <name> · Message: mc sessions send <name> "…"
──────────────────────────────────────────────────────────────────────
#      Session    Tool   Workspace     Runtime      Source   mc-id
1.     mc-tasks   —      mc-tasks +2   not-started  local    mcs_5444…
Cloud sessions   (none)
```

**M.** `mc list --local` runs in **0.10 s**. It is fast and entirely dead: one
row, a session `not-started`, from the sessions/registry/runtime world that
`mc-dormant` and cut-old-surface are removing. Nothing on that page is about
the runner, the projects, the queue or the decisions.

**M.** The page that *is* true is `mc status` (`src/cli/status.js` → no
positional and none of `--watch/--wait/--timeout/--sessions` → `commands/
status-page.js` → `status-collect.js`). Four blocks: RUNNER, DECISIONS,
PROJECTS, WORKAREAS WITHOUT A PROJECT. **1.92 s** with `--offline`; the
`mc-status` plan records 3.3 s live (**A** for the live figure — I did not run
the network path).

**M.** The old board — `mc status --sessions`, `status-render.js` +
`work-status.js` — takes **7.26 s** and is the repo's only piece of polished
terminal drawing: `painter()`, `width()` (escape-aware), `pad`, `clip`, a
`─` rule, glyphs `◆ ● ·` with `yellow/green/grey`. It renders the world that
is going away, but its *renderer* is exactly the house style to reuse.

**M.** `package.json` has three dependencies — `@xterm/addon-serialize`,
`@xterm/headless`, `node-pty`. No ink, no blessed, no chalk. A hand-rolled
ANSI renderer is the repo's style and needs no new dependency.

## 2. The three gaps Martin named, measured

**M. What is running right now is not knowable from mc.** At 07:17:44Z the
runner (`mc run`, pid 13963, up 7 h 02 m, tmux `runner`) was executing a step
for `network-review-rollout` — `claude -p`, pid 26623, started 07:13:39Z,
90-minute budget. `mc status --offline` at that same moment said:

```
RUNNER
  running (tmux runner)
  queue: 24 projects — next: docx-editor (step)
```

`docx-editor` is the head of the *queue*, not what is running. `run.js` writes
the `runs.tsv` row only *after* the step ends, so the current step exists only
as a line of prose in `~/mc/runner/log/runner.log`
(`network-review-rollout: step starting (claude opus, 90 min)`).

**M. A pending STOP is invisible.** `~/mc/runner/STOP` was created 07:14Z. The
runner exits after the step in flight (`run.js`, `stopRequested()`). The page
says "running" and nothing else.

**M. `runnerAlive()` can lie both ways.** `tmux has-session -t runner` is true
for a pane whose process has died; and `pgrep -f 'runner.sh|mc run'` matched
pid 26623 — a *step session* whose prompt text contained the words "mc run".

**M. Intake does not exist yet.** `~/mc/intake/` is absent. `mc helper` writes
it (`docs/project/mc/mc-helper/PLAN.md`); decision `mc-2` is answered **A**, so
the section is designed now and reads "no digest yet" until the helper runs.
(Do not confuse it with `src/mc/pm-helper-intake.js`, which reads
`<area>/intake/` for the dormant pm-helper.)

**M. `mc brief` and `mc plan` leave no mark mc can find.** Both open a
*foreground* session (`commands/brief.js`, `commands/plan.js` → `openInWorkArea`,
`pick: 'new'`) — the terminal's own process, never tmux. So `tmux ls` cannot
see them. What is observable: a `claude`/`codex` process standing in `~/mc`
(that is a brief, since brief opens with `worktree.path = workRoot`) or in
`~/mc/<name>/<repo>` (a plan or a worker). `processesStandingIn` gives
pid + directory in **66 ms** over 32 processes. It cannot say *which verb*
started them; only a register written at launch can.

## 3. Inventory — every fact the page could show

| fact | source today | cost | available now? |
|---|---|---|---|
| runner alive | `tmux has-session -t runner`, `pgrep` | 5 ms | yes, unreliably (§2) |
| runner uptime | `ps -o etime` on its pid | ~10 ms **A** | no — nothing records the pid |
| current step: name, kind, tool, model, started, budget, pid | only prose in `runner.log` | — | **no — needs `~/mc/runner/current.json`** |
| elapsed vs budget | `started` + `budget_minutes` (`sessionSettings`, default 90) | 0 | follows from `current.json` |
| STOP pending | `existsSync(~/mc/runner/STOP)` | <1 ms | yes, never shown |
| queue, ordered | `queue.md` + `listPlans` → `assembleQueue`/`queueNames` | see below | yes (24 items **M**) |
| kind or skip reason per item | `kindFor` (status-collect) / `chooseKind` (run-plan) | 0 | yes, two implementations |
| count runnable | derived (not skip, not live) | 0 | yes, not printed as a number |
| last 24 h by kind and outcome | `runs.tsv` → `summariseRuns` | ~5 ms **A** | yes (34 steps, 30 merged **M**) |
| estimated cost | `prices.js` → `estimateCost` | 0 | yes (≈ $231.58 list **M**) |
| quota hits | `runs.tsv` `note=quota` | 0 | yes, never shown |
| decisions waiting | `scanDecisions(~/mc)` | **15 ms**, 45 files, 9 waiting **M** | yes |
| open PRs | `gh pr list` per repo | network | yes, needs `--fresh` or a cache |
| projects: status + next | `listPlans` on `origin/main` | **1.30 s** memoro (37 plans) + **0.15 s** cli **M** | yes, slow |
| workareas without a project | `areasWithCheckout` | **12 ms**, 53 areas **M** | yes |
| intake: digest date, new errors, proposals | `~/mc/intake/…` | two readdirs **A** | **no — `mc helper` writes it** |
| live tmux areas | `tmux ls -F '#S'` → `mc-*` | **5 ms** **M** | yes, used only to skip queue items |
| foreground `mc brief` / `mc plan` | `processesStandingIn` | **66 ms** **M** | partly — the verb is not recorded |
| what a live session last said | `listConversations` + `readTailEntries` | **0.70 s** for 1 417 transcripts **M** | yes, too slow for a front door |

**M.** `listPlans` is 1.45 s of the offline page's 1.92 s: it spends one
`git show` per plan. One `git cat-file --batch` per repository, behind a
`~/mc/runner/plans.json` cache keyed by the `origin/main` sha, should collapse
it (**A** — not measured).

## 4. The page

Static, printed and exited; `--watch [seconds]` for a second screen. Six
sections, in the order a person needs them. Width from `stdout.columns`
clamped 60–160; colour only on a TTY and only when `NO_COLOR` is unset or
empty (**M**: `src/cli/list.js` tests `NO_COLOR !== '1'`, which lets
`NO_COLOR=true` through — a bug to fix while passing).

```
  MEMORO·CLI  0.7.11 ──────────────  9 decisions  ·  24 queued  ·  ≈$232 today

  NOW
  ● network-review-rollout    step · claude opus · 4m of 90m   memoro  pid 26623
  ■ STOP requested 07:14Z — the runner exits after this step
  ◆ docx-editor               tmux mc-docx-editor · waiting 12m
  ◆ brief                     ~/mc · claude opus · 37m
  runner up 7h02m · 34 steps/24h: merged 30, open 0, failed 0, timed out 0

  QUEUE   18 runnable of 24                                       mc status <name>
   1 docx-editor          step      4 pdf                   step
   2 avatar-fab-compos…   step      5 swedish-grammar       step
   3 avatar-self-serve    step      6 language-issue-fix    step
   … 12 more · skipped 6 (done 5, waiting-decision 1)

  DECISIONS   9 waiting                                                  mc brief
  org-update/…/network-review-1   Should a shared household become an ent…
  pdf/…/document-pipeline-1       How PDF extraction is made to fit its s…
  … 7 more

  INTAKE   no digest yet — mc helper has not run (decision mc-2 answered A)

  PROJECTS   44 · ready 21 · waiting-decision 6 · blocked 5 · done 12
  memoro / assistant-avatar
    avatar-fab-composition  ready  Split into the three components (§4)…
                                   08-29 04:19Z step #11044
  …

  WORKAREAS WITHOUT A PROJECT   11
  jobbet · legal-work · minor-fixes · org-update · ui-fixes · week-focus · …
```

Rules the mock-up encodes:

- **NOW is first and is new.** It is the only section that answers "is the
  machine working, and on what" — the question Martin opens a terminal to ask.
- **A number where a number is the answer** (queue depth, runnable, decisions,
  intake, projects by status); **a line only where identity matters** (what
  runs now, what waits on him). Each count names the verb that expands it.
- **PROJECTS is the tail.** It is what `mc status` prints today and it is 44
  rows long. It stays, last, one project per row, with `mc status <name>` for
  the detail — that verb landed today (#427).
- **Colour carries state, never decoration:** green = running, yellow = waiting
  on Martin, red = failed or timed out, grey = quiet. Same glyphs as the old
  board (`● ◆ ·`) so nothing new has to be learnt.

## 5. Options considered

**Bare `mc`.** (a) *the page* — `mc` and `mc status` print the same thing, the
sessions table survives only as `mc list`; (b) *a live dashboard by default*,
`mc status` the static one-shot; (c) *a six-line summary*, `mc status` kept
whole. Chosen: **(a)**, put to Martin as `~/mc/mc-utredning/decisions/mc-3.md`
because it changes the front door he types fifty times a day. (b) makes the
commonest use — glance and go — the one that needs ctrl-c. (c) leaves two
pages to keep in step, which is how `mc status` and the board drifted apart.

**Static vs live.** Static by default; `--watch [seconds]` redraws whole. The
board's line-diff machinery (`renderLines` + `signature`) exists, but it is
built for the old report and a full redraw of ~40 lines is imperceptible (**A**).

**A TUI library.** Rejected. ink pulls React; blessed is unmaintained. The
repo already owns an escape-aware `width()`, a `painter()` and `pad`/`clip` in
`status-render.js`, all tested. Reuse beats a dependency here.

**Speed.** Offline and cached by default, `--fresh` for `git fetch` + `gh pr
list`. That flips today's default (`mc status` is online unless `--offline`),
which is the price of an instant front door. Target < 300 ms; the work is the
plan cache (§3) — everything else already measures in tens of milliseconds.

**Where "what is running" comes from.** Parsing `runner.log`'s tail was
considered and rejected: it is prose, it cannot say the pid, and it goes wrong
the first time a line is reworded. `mc run` writing `~/mc/runner/current.json`
at step start is one write per step, in the process that alone knows the answer.

## 6. Open, and deliberately not decided here

- Whether `mc brief`/`mc plan` register themselves (a small file per
  foreground session) or NOW settles for "a claude is standing in `~/mc/x`".
  Step 5 of the plan; costs nothing to defer.
- Alerting beyond the page (push, mail, macOS notification) — already fenced
  off as a separate decision by `mc-helper`'s Contract.
- Whether `kindFor` should be deleted in favour of `chooseKind`. Real, but it
  is `mc-run`'s and `mc-status`'s shared ground, not this project's.
