# mc deploy — one door to production, and a record of every time it opened

`mc deploy` is the verb a person types to put memoro's `main` in production, the
way `mc merge` is the verb that puts a pull request on `main`. It is not a
deploy tool. memoro's own `npm run deploy` — `scripts/deploy.mjs`, ending in
*Verify live version* — is the deploy, and this verb
reimplements no part of it, passes it no flag it does not already take, and does
not edit it.

What the verb adds is everything around the script:

- **the reading**, so the person who typed it sees what ships: the sha, what is live now, the gap between them, whether the nightly
  ever measured that tree whole, and which worktree it would run in;
- **a `main` to run it in**, found where `main` is already checked out or made
  and kept by mc, so nobody checks `main` out by hand to deploy;
- **the gate**, so the commit that ships is one that was measured whole and
  exercised: a completed full run of exactly that commit, and the app's own
  suites run against a local server of it (below);
- **no question, and no terminal needed** — typing `mc deploy` is the decision
  (Martin, 2026-11-15: *"without me and without a question; whoever types
  deploy wants it"*): once the reading is printed and the gate has passed the
  deployer starts, from a terminal or from a session's shell. `--dry-run` is the
  reading and ships nothing. An unattended session (`MC_HEADLESS=1`) is refused
  before anything is read: nobody typed that deploy. Deploy is not one of the
  acts that reach Martin ([canon/tasks/asking-martin.md](../../canon/tasks/asking-martin.md)),
  and the refusal to an unattended session stays until a release is checked where
  users meet it and can be taken back (Martin, 2026-11-15);
- **its own process**, the deployer, so the deploy runs beside the merger and
  neither waits for the other, and a ^C at the terminal stops only the
  watching (ruling 30);
- **the record**, written before the deploy starts and completed after it ends,
  so a deploy that dies half-way is a row that says so rather than a silence
  somebody reconstructs from `/admin/deploy/logs` afterwards.

Before it, mc knew about a deploy only after the fact, and only through that
webhook log — which had been writing nothing for weeks, and which memoro has
since removed ([`mc-helper.md`](mc-helper.md) § *the deploy section*).

## The sequence

```
mc deploy [--dry-run] [--json]
mc deploy --accept-red "<reason>"
mc deploy --follow
```

It takes no repository argument and never will: memoro-cli is installed, not
deployed. `REPO` is `memoro` in
[`src/mc/commands/deploy.js`](../../src/mc/commands/deploy.js), resolved to a
path through `defaultRepos(env)`, the same reading the page and `mc plan` use.

1. **Fetch and read.** `git fetch origin main` in `~/memoro`, then
   `rev-parse origin/main` — main's tip — and the first-parent chain of
   `origin/main` after the live commit (step 3). The sha that would ship is the
   **newest commit of that chain whose full run is green** (`pickCommit`): the
   tip when the tip is green, an older commit when it is not. The reading says
   how many commits behind the tip it is and why the tip was passed over (red,
   stalled, stopped, not measured), listing every red name. With nothing green
   after the live commit, the tip is prepared as it is, as before. Refs are
   shared by every worktree of a repository, so these reads stay here whatever
   branch this checkout is on.
2. **Where the script will run.** `git worktree list --porcelain` in `~/memoro`,
   and the worktree whose branch is `refs/heads/main` is the one — git allows at
   most one, so there is nothing to choose between. When no worktree has `main`
   out, mc makes its own at **`~/.memoro/mc/deploy/memoro`**
   (`git worktree add`, from `main` or from `origin/main` when the branch is not
   local) and says so in one line. Then, in that worktree: `status --porcelain`,
   `rev-list --count origin/main..HEAD` and `rev-list --count HEAD..origin/main`
   — dirty and diverged are refusals (below); behind is fast-forwarded and past
   the pick is reset back, both in step 9.
   `--dry-run` names the worktree it would make in its reading and then makes
   it, when it is mc's own: the suites of step 6 are served in that tree.
3. **What is live.** The last `deployed` row of `~/mc/runner/log/deploys.tsv`
   when there is one; otherwise `GET https://meetmemoro.app/api/version`, which
   is public, tiny (`{ commit, build, build_time }`) and asked with `no-store`.
   The row is preferred because it is mc's own record of what mc shipped. Of the
   row, `live_commit` (what the script verified live) is read first, then `sha`;
   `/api/version` is the last resort. With the live commit unknown, only the tip
   is a candidate. **Production never moves backwards:** a pick that is the live
   commit, or has it not as an ancestor, is refused — also under `--accept-red`,
   and again under the register's lock at final admission.
4. **The gap.** `git rev-list --count <live>..<sha>`. A sha the checkout does not
   have is *"the gap is unknown"*, never a number.
   **The reading.** With the live commit, the pick and the gap known, and the
   pick not older than what is live, memoro's `scripts/release/reading.mjs` says
   whether the release can be taken back and which change makes it not (*The
   reading* below); it is printed after the pick's lines, on `--dry-run` too, and
   changes nothing about what follows.
5. **The nightly.** `readNightlyHistory`
   ([`src/mc/nightly-history.js`](../../src/mc/nightly-history.js)) has the last
   full-suite measurement per repository with the commit it measured. When that
   commit is not the one about to ship, the line says so plainly — it is a
   reading a person weighs, and the gate (step 6) is what decides.
6. **The gate**, on the pick, ([`src/mc/deploy-gate.js`](../../src/mc/deploy-gate.js)), after
   every refusal that costs nothing — a deploy running, a dirty or diverged
   `main` — so none of them is found out after a full run. See
   *The gate* below. It prints its two readings beside the nightly line, and
   refuses when either is red.
7. **Nothing is asked.** A passed gate goes straight to the deployer; the one
   line that says so is printed under the register's lock once the deployer has
   started (step 8): `mc: deploying <short sha> to production in its own process
   (pid …)`, and with `--accept-red` `mc: deploying <short sha> to production,
   accepting red (<reason>) in its own process (pid …)`. No such line is printed
   before a refusal. A follow cut with ^C before the admission ships nothing: the
   preparation goes on in its own process and the next `mc deploy` joins it.
8. **The deployer.** Under the register's lock — milliseconds, and held by no
   merge round — the record is read once more for a deploy in progress, an
   abandoned `running` row is closed, the deployer is started detached
   (`deploy-run.js`, `ship` in `commands/deploy.js`, its output in
   `~/mc/runner/log/deploy.log`), and its row is written naming its pid. The
   terminal that typed it then follows that log (`followDeploy`) until the
   deployer is gone and answers with the row's outcome. ^C there stops the
   watching, not the deploy; `mc deploy --follow` watches the deploy going on
   again. No repository lease is taken: until ruling 30 the deploy waited up to
   eight minutes for a merge round to give it back, and gave up with exit 3.
9. **Placing the worktree at the pick**, in the deployer, after the admission — at the
   sha the gate measured, never at `origin/main` as it is by then.
   *In mc's own worktree* (`~/.memoro/mc/deploy/memoro`, the route of *The gate*
   below) the deployer first takes the worktree's **holder** (§ *No lease*) — before
   the tree is placed or read, and it keeps it until the script has exited — and then
   places the tree with `placeWorktree`, the one function the exercise of the suites
   places it with: a tree behind the pick is fast-forwarded (`git merge --ff-only
   <sha>`); a tree past the pick is `git reset --keep <sha>`, only when the pick is an
   ancestor of HEAD, HEAD is an ancestor of `origin/main` and no tracked file is
   modified; untracked strays are removed (`git clean -fd`, said in a line). A tree
   with modified tracked files, with commits `origin/main` lacks, off `origin/main`'s
   line, or that git cannot read is not placed: the row is completed `failed`, stopped
   at `moved`, naming what stood. A tree the exercise placed and something moved
   after the measuring is put back by this same placing, so what the suites measured
   and what is built are the same tree. A holder that is not given within 90 minutes
   completes the row `failed`, stopped at `held`, naming the holder; nothing was placed
   and nothing was deployed.
   *In any other worktree* (main checked out in the person's own) the one movement of
   somebody else's checkout this verb makes is `git merge --ff-only <sha>`, on a tree
   already proved clean and not ahead; a tree that stands past the pick is not
   reset, and the row is `moved`. A failed fast-forward or reset is the row's
   `stopped_at: 'fast-forward'`. mc then reads `rev-parse HEAD` in that worktree: when it
   is the sha the gate measured, that is what the success line names, the
   script is handed and the row records. When it is not — main moved on by
   somebody else between the gate's end and the placing — the commit that stands there
   has been neither measured nor exercised, so nothing runs: the row is completed
   `failed`, stopped at `moved`, naming the sha that stood, and the verb says to
   run it again. (Until 2026-11-14 it deployed whatever stood there and said so in
   one line, *"main moved to `<y>` since the question; deploying `<y>`"*; before
   2026-10-03 the row recorded the measured sha whatever went out. The question
   itself was removed on 2026-11-15.)
10. **The script.** `npm run deploy` in that worktree, the process's environment
   passed through with one addition, `MEMORO_DEPLOY_SKIP_REMOTE_PREFLIGHT=1`,
   always. The script's own remote step (`ensureUpToDateWithOrigin`) would
   otherwise fast-forward the worktree to the remote main and ship a commit that
   was neither the pick nor measured; with the variable it checks the tree and
   branch and leaves the commit alone. Its output is in the deployer's log as it happens.
   Its stdin is closed: a wrangler that wants a login stops with its own words
   in the log — `wrangler login` at a terminal, then `mc deploy` again.
11. **The branch, when the script made one.** Whenever `deploy.mjs` changed a
    tracked file of its own while it ran (today: it built and pinned a stale
    container image, which rewrites lines of `wrangler.toml`), it ends with that
    checkout clean on `main` at the deployed sha, the change committed on a new
    branch from that sha and pushed to origin — never to `main` — and one last
    line, `Deploy branch: <branch>`. When the output has that line the deployer
    opens a pull request from the branch to `main` (`gh pr create --base main
    --head <branch>`, titled and described by the branch's own commit) and queues
    it for the merger exactly as `mc publish` does (`mc merge memoro <n>`), and
    says `mc: <branch> → memoro#<n> <url> — queued for the merger`. The pull
    request is opened whether the deploy went through or failed, because the
    script pushes the branch in both. Opening or queueing can fail (no `gh`, no
    network, a refusal): that is one line on stderr and a phrase in the row's
    note, and the exit code and the outcome stay the script's. Once a pull
    request has opened, its number and URL remain in the terminal output and
    its number remains in the row even if queueing throws; the terminal says
    `— opened, not queued` and the row says `opened as memoro#<n>, not queued`.
    Until that pull request lands, a second deploy of the same sha makes the same change again —
    it costs time, never a failure — and its branch gets a pull request of its
    own. A line that is not exactly `Deploy branch: <branch>` — the script's
    `Deploy branch not pushed: …` and `Deploy branch not recorded: …` say that
    the change could not be sent — opens nothing.
12. **The row completed** — outcome, build, the live version the script verified,
    the step it stopped at when it failed, and, when there was a branch, the
    pull request in the note (`<branch> landed through memoro#<n>, queued`;
    `opened as memoro#<n>, not queued (<why>)`; `has no pull request (<why>)`).

A real reading, run in this workarea on 2026-09-07 — `~/memoro` is where `main`
happened to be that day, and the line says so whichever worktree it is:

```
mc: would deploy memoro 2742862a328e13ac9585e082f9758330ced3835d — Plan: msr-core — Martin's 2026-09-07 phone pass and four rulings (#11575)
mc: from /Users/martinforsberg/memoro — main, 1 behind origin/main, fast-forwarded before the script runs
mc: live now 08d5b46 (build 23779) — deploys.tsv, 2026-09-07 05:45
mc: 1 commit would ship
mc: the nightly measured eb592c4, 131 commits ago; this tree was not measured whole
mc: --dry-run — nothing was deployed
```

The same reading when main's tip has no green full run (the shas are from the
test's fixture, not a day's run) — the commit that ships is behind the tip, and
the reading says how far and why:

```
mc: would deploy memoro 5b2d0000a1b2c3d4e5f60718293a4b5c6d7e8f90 — the change that would ship
mc: live now 9f8e7d6 (build 812) — api/version, 2026-09-01 10:00
mc: 2 commits would ship
mc: 1 commit behind main's tip 1a2b3c4 — its full run is RED (2): tests/lib/money.test.js, command:lint
mc: the nightly has measured nothing here — this tree was not measured whole
```

The same reading with the repository checkout on a feature branch and `main`
elsewhere (`MC_REPOS_HOME=~/mc/msr-core`, whose `memoro` stands on
`programme-map-surface-persistence`) names the same worktree, and `--json`
carries it as `worktree` beside `behind`, `ahead` and `dirty`:

```
mc: would deploy memoro 2742862a328e13ac9585e082f9758330ced3835d — Plan: msr-core — Martin's 2026-09-07 phone pass and four rulings (#11575)
mc: from /Users/martinforsberg/memoro — main, 1 behind origin/main, fast-forwarded before the script runs
…
  "path": "/Users/martinforsberg/mc/msr-core/memoro",
  "worktree": "/Users/martinforsberg/memoro",
  "behind": 1,
```

## The reading: whether the release can be taken back

Once the plan is known — the live commit, the pick and the gap between them —
and the pick is not older than what is live, `mc deploy` says whether the release
for those commits can be taken back and, when it cannot, which change makes it
so. It is a reading and nothing else: it never refuses, holds, asks or changes
whether, when or by whom a deploy starts, and `--accept-red` has nothing to do
with it. The rules are memoro's, in
[`docs/technical/release-take-back.md`](../../../memoro/docs/technical/release-take-back.md)
(a migration added, changed, removed or renamed; a Durable Object, binding,
container or configuration change the provider cannot roll back; a production
act declared in `scripts/release/production-acts.json`), and they are written once, in memoro's
`scripts/_lib/release-reading.mjs`. mc runs the script and reads what it prints;
it holds no rule of its own.

[`src/mc/take-back.js`](../../src/mc/take-back.js) (`takeBackReading`) uses no
checkout. `mc deploy` runs in the bare repository `~/mc/repos/memoro.git`, which
has no working tree and so no script, and a checkout can be behind or on another
branch, so the pick's own `scripts/` is written out as the pick has it
(`git archive` into `tar -x`) into a directory of its own under the system's
temporary directory, and `node <dir>/scripts/release/reading.mjs --repo <path>
--from <live> --to <pick>` runs there, bounded at 60 s. The directory is removed
whatever happened. The script prints one JSON object — `schema_version` 1,
`can_take_back`, and `reasons[]` of `{ kind, what, file, commits[{ sha, subject }] }`
— and exits 0; mc accepts exactly that object, and nothing else is a reading.

A reading that could not be made is `no`, never "unknown, so yes": the script is
not on the pick (a pick from before it existed), it exited non-zero, it printed
something that is not the object, it did not finish in 60 s, or no live commit is
known so there is no range. The line then says `this release is read as one that
cannot be taken back — reading not made: <why>`, and the deploy goes on.

The reading is made before `--dry-run` branches, so a dry run says it too, and it
is printed after the pick's lines:

```
mc: this release cannot be taken back — 1 change makes it so:
mc:   migration-before: migrations/0411_x.sql: `auto before`; the previous build is not known to run on the new schema (bc3de65e3c Add x (#1))
```

`mc: this release can be taken back — nothing in it is one the provider cannot roll back`
is the line when it can. At most five reasons are spelled out, each with the
commits that brought it; the rest are counted (`… and 2 more`). `--json` carries
the reading as `take_back` — `{ made, can, reasons, why }` — beside the rest of
the plan, on a dry run and on a deploy, and `take_back` is `null` when the pick
is not newer than what is live, because no reading is made then. The record keeps it in
`take_back` and `take_back_why` (*The record*).

## mc's own `main`, and why it is kept

When no worktree has `main` checked out, mc adds one at
`~/.memoro/mc/deploy/memoro` and **never removes it**. Two consequences, both
deliberate:

- Every later deploy finds it in step 2 and runs there, so the two cases
  converge on one deploy checkout.
- While it stands, `git checkout main` anywhere else is refused by git — one
  branch, one worktree. That is the point rather than a side effect (Martin,
  2026-09-06: *"Jag checkar ut main enbart för att göra deploys"*). To take
  `main` back by hand, `git worktree remove ~/.memoro/mc/deploy/memoro`.

It lives under `mcHome()` and never under `~/mc/`: a checkout there is a
workarea to `listWorkAreas` and to the runner's `closeWorkareas`, and a deploy
checkout is not a goal worktree and is not listed as one.

`deploy.mjs` needs nothing from outside the tree it runs in — it resolves its
own `ROOT` from its file, and `npm run deps:ensure`
(`scripts/ensure-worktree-deps.mjs`) installs a fresh worktree's dependencies
itself, so mc runs no `npm ci`. One thing is worth knowing: the container
deploy-state cache is read through `git rev-parse --git-path
memoro-deploy-state.json`, which in a linked worktree resolves to that
worktree's *private* git directory (`.git/worktrees/<name>/…`), not the shared
one. A first deploy from a worktree that has not made one before therefore
plans a full container rollout — *"no local record of a successful full
container deploy"* (`determineContainerPlan`, `deploy.mjs:719`) — which is
slower, never less than the deploy asked for.

## What it refuses, and with what code

Typing `mc deploy` is the decision (Martin, 2026-11-15), so the verb asks nothing: every refusal below is made before the
deployer starts and ships nothing. An unattended session has nobody who typed
the deploy, so it is refused.

| situation | code | what happens |
|---|---|---|
| a positional argument, or a bad flag | 2 | usage; nothing read |
| `--dry-run` | 0 | the reading, and it stops there — no row, no deployer |
| no checkout of `memoro` on this machine | 1 | says so; this verb deploys that repository and no other |
| the checkout has no `origin/main` | 1 | says so |
| **`main` is dirty** where it is checked out | 1 | names the path and the first five files; refused row *"main is dirty in `<path>` — `<n>` file(s)"*. Nothing is stashed, reset or discarded — that tree may be somebody's |
| **`main` has commits `origin/main` does not** | 1 | refused row *"main in `<path>` has `<n>` commit(s) not on origin/main"*: what would ship is not that tree |
| `git worktree add` for mc's own `main` failed | 1 | says so; refused row. There is no checkout of `main` to run the script in |
| **the pick is the live commit, or live is not its ancestor** | 1 | production never moves backwards; refused row naming both, also under `--accept-red` and again at final admission |
| **the pick, or main's tip, is a taken-back commit or before one** | 1 | refused row, code `taken-back`, naming the take-back; also under `--accept-red` and again at final admission (*The gate*, the floor) |
| the fast-forward or the reset failed | 1 | the deployer's row completed `failed`, stopped at `fast-forward`; nothing spawned |
| the worktree stands on another commit than the pick, at the deployer's placing, and cannot be placed at it | 1 | the deployer's row completed `failed`, stopped at `moved`, naming the sha that stood; nothing spawned. Run it again |
| mc's own worktree is held by another process for 90 minutes (an exercise, a deployer, `mc language`) | 1 | the deployer's row completed `failed`, stopped at `held`, naming the holder; nothing placed or spawned. `mc deploy` again waits for it once more. In the exercise the suites are cannot-run naming the holder |
| **an unattended session** (`MC_HEADLESS=1`) | 1 | *"an unattended session does not deploy — a deploy is made by whoever types it, and no one typed this (headless, MC_HEADLESS=1); nothing was deployed. mc deploy --dry-run is the reading."* — before any fetch, history read, full run or suite, and no row: nothing was read. `--dry-run` and `--follow` are allowed |
| `--accept-red` without a reason | 2 | usage; nothing read |
| **no full run of the exact commit is green** (only when nothing after the live commit is) | 1 | red or stalled: names the commit, the red files and commands and the main-red mend that holds them. Stopped without measuring (never green) or measuring another commit: names that. Refused row, the gate's cells filled |
| **a suite failed or could not run** | 1 | names the suite and its last lines; refused row |
| another deploy is running | 1 | names its sha, start and pid; refused row. There is no queue |
| **a language run is running** | 1 | names its manifest, start and pid; refused row *"a language run of `<manifest>` is running"*. A language run writes to the same production ([`mc-language.md`](mc-language.md)) |
| the deployer could not be started | 1 | row completed `failed`, stopped at `start` |
| the script ran | 0 / 1 | `deployed` or not, read from the row when the deployer is gone |
| ^C while following | 130 | the deploy goes on; `mc deploy --follow` watches again |

`main` checked out **nowhere** is not on this list and is not a refusal: mc makes
its own worktree and deploys from that. A `main` merely *behind* `origin/main` is
not one either — it is fast-forwarded in step 9, and one that stands past the
pick is reset back there in mc's own worktree.

The decisions among them — a deploy or a language run already running, and the three
worktree refusals — are each written to the record as `outcome: refused` with
the reason. They are deploys somebody meant to make, and the page and the brief can only see
them if they exist.

Which of these stops is **technical** is one function (`classifyStop`, `src/mc/deploy-repair.js`), and it is read from the
stop, not from a list of notes: a row `failed` at any `stopped_at`, and a refusal because mc's machinery could not do its part
(the deploy worktree could not be made or placed, `git status` failed where `main` is, mc's own deploy worktree is dirty or
ahead of `origin/main` — state mc owns, which a repair may mend — the preparation could not run, a gate suite *cannot run* or
the suites could not start). These are not: a usage error, `--dry-run`, the headless refusal, another deploy or a language run
in progress, a pick that would move production backwards, no green commit with a red or unmeasured tip, a red gate suite, a
replaced preparation, and `main` dirty or ahead of `origin/main` in a worktree that is not mc's own (it may be somebody's). A
stop nobody has classified is technical. Only a technical stop queues a repair ([A stop that is repaired](#a-stop-that-is-repaired)).

A refusal is exit **1** rather than 0 on purpose, so `mc deploy && …`
does not carry on as though it had shipped. There is no exit for a missing
terminal: the verb does not look for one.

`--dry-run` writes no row at all. Nothing was attempted, and a row per person
checking what would ship would drown the ones that matter.

## The gate

Martin, 2026-11-14: tests and gates move from the merge to the deploy and the
daily run. A merge no longer carries a whole-suite measure
([`mc-merge.md`](mc-merge.md)); what ships does, here. The gate is
[`src/mc/deploy-gate.js`](../../src/mc/deploy-gate.js), called from
`gateStage` in `commands/deploy.js`, and it measures the commit that would ship
— the pick of step 1, which is `origin/main`'s tip when that is green — and no other.

**Which commit.** `pickCommit` walks the first-parent chain of `origin/main`
newest first, stops at the live commit, and takes the first commit whose full run
is `green`; a commit that is not a descendant of the live one is never a
candidate. It may be behind the tip, and the reading says how far and why
(*"1 commit behind main's tip 1a2b3c4 — its full run is RED (2): …"*, or *"not
measured: no full run of it"*). The history is read as it stands and no run is
started to find a candidate; only the pick itself is prepared. With
`--accept-red` the tip is prepared, gated and shipped, and the reading names the
green commit that would ship without it.

**The floor: a taken-back commit is no pick.** A commit that is the
`takes_back_sha` of a take-back row, in any outcome, and every commit before it on
the first-parent chain, is no candidate: `pickCommit` passes it over with state
`taken-back` and the refusal code is `taken-back`, also under `--accept-red`
and again at the final admission. A green full run does not bring back a commit
that production's check found red; a later commit that is green does ship, and
a later deployed row also ends the desk entry of *The take-back*. When main's
tip is under the floor the reading says so (*"main's tip `<sha>` is a commit
that was taken back from production after its check was red; nothing after it
is green yet, so nothing ships, also with --accept-red"*), and the plan line
names a take-back of the live row and an open desk entry. A commit the checkout
does not have is no floor it can apply.

**The whole suite.** `fullRunVerdict` reads the history the full run writes
(`readNightlyHistory`) for a completed full run of *exactly* that sha. A green
run of an older commit is no run of this one. A run that stopped because of the
machine or the runner (`fetch`, `lease`, `busy`, …) measured nothing and is
passed over. What is left says:

| state | what the gate does |
|---|---|
| `green` | says so, with the run's time, duration and counts, and goes on |
| none | the preparation starts `fullRun` — the runner's full run's own round, so the same history and the same main-red mends — and the terminal follows it; its answer is read as a history run is. `--dry-run` starts nothing and says one is needed |
| `red` | refuses, naming the commit measured, the red files and commands, and the main-red mend that holds them. When no mend holds it, says so; the history keeps red test names, not files, so the gate cannot queue one itself |
| `stalled` | a run that began and never finished its suite: refuses like a red |
| `unmeasured` | the run stopped for a reason that is not the machine's and measured nothing: refuses, never green, and `--accept-red` does not take it. A deploy starts a run only when there is none, so every later deploy of that sha reads the same run; the refusal names the way out — `mc test memoro --full`, which writes the history the gate reads |
| `moved` | the run measured another commit than the one it was started for: refuses |

**The preparation, in a process of its own (2026-11-14).** The full run is
tens of minutes, and a deploy started from the page over SSH ran it in the
page's own process: the connection closed, the process died, and the round had
a start and no end. Everything the verb does before its deployer — the
measuring above and the suites below — is therefore a *preparation*, run by a
detached process ([`src/mc/deploy-prepare-run.js`](../../src/mc/deploy-prepare-run.js),
[`src/mc/deploy-prepare.js`](../../src/mc/deploy-prepare.js), started with
`startDetached` like the deployer) and recorded in
`~/mc/runner/deploy-prepare.json` (`{ sha, pid, started, stage, log,
accept_red, ended, result, error }`; the log is
`~/mc/runner/log/deploy-prepare.log`). `stage` is `starting`, `full-run`,
`suites` or `done`. The terminal, and the page's deploy panel, only watch it
(`followLog`): ^C, a closed SSH session or a restarted page stops the
watching, never the work, and the record is found again from disk.

A preparation is **joined by exact sha**, and reused only while the history's
current verdict for that sha equals the one recorded (a run that went red since
is not trusted), decided under the register's lock so
two terminals cannot both start one (`prepareStage`):

| the record says | `mc deploy` |
|---|---|
| running, same sha | follows it — *"already being prepared … following it, not starting a second"* — and goes on to the deployer when it is green |
| done, same sha, green | goes straight to the deployer; nothing is measured again |
| done, same sha, red | the refusal as if it had run here; `--accept-red` reads the same result. The main-red mends that hold the red are read as they stand now (`withMendsNow`): one landed or dropped since is not named |
| another sha (main moved) | a new preparation, said in one line: *"the last preparation was of `<x>`, main is `<y>` now — starting a new one"* |
| its process gone before it ended | *"interrupted at `<stage>`"*, and a new one |
| done without suites and `--accept-red` given, whether found done or joined while running | prepares again, once: the suites are what a red needs |

**A measuring preparation is never silent (2026-11-14).** The full run is tens of
minutes and the suites more; a watcher that sees nothing for that long cannot tell
a long run from a stuck one. Whatever stage the preparation is in, its log has a
line at least once a minute, and the terminal (`mc deploy`, `--follow`) shows that
log as it grows, as the page's deploy panel shows its last line and when it was
said. Two things write them:

- the **round's progress line** — `progress — <done> of <files> test files done,
  <n> running, <n> red so far, <m> min <s> s elapsed` — written by the test run
  itself each minute (`suiteProgressLine` in `repo-gate.js`; a batch of files
  counts its own files exactly, a whole suite against the tracked test files,
  `~`). Files done and running are counted from a test file's process starting and
  exiting (`test-progress-preload.mjs`), which node's reporter shows only after the
  files before it have reported; a red is a failed test counted once, not the
  suites that failed because it did. A run that cannot count files says
  `test files not counted` and still gives the reds and the elapsed time;
- the **preparation's own beat** (`prepare`, `PREPARE_BEAT_MS`): a minute with no
  line from anyone — a stage that reports no progress, such as the suites, or a
  full run followed in another process — says `mc: still preparing — <stage>, <n>
  min so far`. A starter that waits for another full run (`awaitClaim`) says the
  same once a minute: `still following the full run of <sha> (pid <n>), <n> min so
  far`.

A deploy's full run is never lost to a lease: it runs isolated and holds no
repository lease (`holdLease: false`), like the runner's full run. `--dry-run` starts
nothing and says a preparation is in flight; `--follow` follows a preparation as
it follows a deploy.

**One full run of a sha at a time, whoever starts it.** Three doors start a full
run: this preparation, `mc test <repo> --full`, and the runner's full run.
Each claims the run first in `<mc home>/full-runs.json`
([`src/mc/full-run-claim.js`](../../src/mc/full-run-claim.js)): `{ repo, sha,
pid, started, verb }`, decided under a lock of the history's own root. A claim
overlaps another of the same repository when the shas are equal or either is
unknown (`mc test --full` does not know what the fetch will find). A starter
that finds a live overlapping claim does not start a round: it follows the run
(`awaitClaim`) and reads its answer from the nightly history; a run that died
without writing one is no answer, and the follower starts its own. A claim
whose pid is gone is no claim. A known, different sha is another tree and
waits for the run in flight (`waitFor`), then claims: a repository has one
checkout for its full run (`<slug>/full`), and a second run must never prepare
it under the first. `mc test <repo> --full` with no pull request is the same
kind of run as the runner's full run — beside the merge lane, in its own checkout, no
lease, written to the history (2026-11-14: it stopped twice at `lease` because
the merger held memoro.git).

**An interrupted round.** A gate round whose process is gone without an end
record is settled by whoever reads it next (`settleInterruptedRounds`,
[`src/mc/repo-round-log.js`](../../src/mc/repo-round-log.js)): an end line,
`stopped_at: 'interrupted'`, *"process N ended without an end record"*, is
appended under the round's own run id, and the page shows it for a day beside
the deploy panel — never a round that is "running" forever.

**The app, used — against exactly the pick.** `exerciseApp` reads the suites
declared in memoro's `.mc/test.json` and runs them against local servers of
*exactly* the pick, started the way `mc test dev` starts one (`ensureAppServer`).
Which tree they are served from depends on where main is held — one of two routes,
chosen by `isOwnWorktree` on the worktree step 2 found:

- **The own route — main is held in mc's own worktree, or nowhere.** The servers
  are the **deploy worktree's own** (`~/.memoro/mc/deploy/memoro`), placed at the
  pick, and the shared checkout `~/mc/self/memoro` is not used: no git call is made
  on it, it is not moved, no hold on its main server is asked or waited for, and it
  is never served — however dirty, on whatever branch, or held it is. This is the
  tree the script then builds in, so the suites measure what is built. The order
  is fixed: the **holder** is taken (§ *No lease*; waited for up to 90 minutes, then
  every suite is cannot-run naming the holder); the tree is **placed** at the pick
  by `placeWorktree`, the function `ship` places with (step 9), and a tree it cannot
  place makes every suite cannot-run naming what stood; the declaration is read from
  the tree at the pick; each server is **ensured in that worktree** — the static
  server, the app server and each revive after a server left mid-run — **unpinned**,
  since the tree was placed and nothing follows main; and the commit each server
  serves is checked against the pick after every ensure and revive: a server of
  another commit, or one started on uncommitted changes, makes the remaining suites
  cannot-run. The servers take **dev-pool slots** and wait in turn within the pool's
  wait; a slot not had is cannot-run with the pool's reason. After the exercise,
  passed or refused, the servers it started are stopped and the holder is released;
  a server that was already there is left running.
- **The shared-checkout route — main is held in a worktree that is not mc's
  own** (the person's checkout). Nothing of the own route applies; this is the
  route as it was. The server is the shared checkout's, `~/mc/self/memoro`
  (`sharedWorktree`) — not the worktree with main that the script runs in. The
  order is fixed: `git show <pick>:.mc/test.json` (the declaration, before
  anything moves), then the holds, then the checkout is placed, then the
  declaration is read from the tree, then the server is ensured. The checkout must
  be clean, on main or on no branch, and its HEAD an ancestor of `origin/main`;
  then `git checkout --detach <pick>` places it (the repository is bare, the
  person's worktree holds the branch `main`, and git gives a branch to one
  worktree, so the shared checkout stands detached). Otherwise every suite is
  *cannot run* with the reason and nothing is moved. The holds are asked before the
  checkout is detached, and a hold of either kind — busy (mc used the main server
  within its idle window) or a kept browser's (one stepped on it within
  `KEPT_HOLD_SECONDS`) — is waited out and asked again, with the checkout
  untouched: both end by themselves, so the deploy says what it waits for and asks
  nobody to close anything. The wait has one bound for the whole hold check,
  `HOLD_WAIT_MS` (ten minutes); a server still held when it has passed refuses,
  names the hold and leaves the checkout where it stood. Every ensure **pins** the
  commit and never follows main, and the commit the server serves is checked
  against the pick after every ensure.

On both routes the gate refuses, as suites that cannot run, when the checkout has
uncommitted changes (`git status --porcelain`, read before any server is asked for
on the shared route), when the server was started on uncommitted changes
(`built_from.dirty`), or when the server serves another commit. The tests assert
the commit the server was started on.

**A suite that does not gate a deploy.** A suite in `.mc/test.json` declared
`"gate": false` with a required, non-empty `"gate_why"` is not run
by `mc deploy`, is never a refusal, and is named once with its reason in the
reading. `mc test dev` and `mc test prod` run it as before. A declaration with
`gate: false` and no `gate_why` is invalid.

A suite that gates and fails, or one that
cannot run (the server never came up, a suite never started), refuses and
names the suite and its last lines. A suite that exits with the declared skip
code (78) is named as skipped with its reason and does not refuse.

**The reading** shows both results beside the nightly line, and each suite on
a line of its own; then, with no refusal, the admission and the deployer.

**The red, accepted.** `--accept-red "<reason>"` is the only way past a red
full run or a failed suite. The reason is required (a blank one is a usage
error, exit 2); the deployer's line names the reason and the row keeps it;
and the reading lists every red and failed suite. A `red` or `stalled` run
without the flag refuses before the suites run; with the flag, and in
`--dry-run`, the suites run too so that the whole reading is in front of
whoever decides. `unmeasured` and `moved` are not red: they are not accepted.

**Headless.** `MC_HEADLESS=1` refuses a deploy before any fetch, full run or
suite. An unattended session is told it does not deploy, because nobody typed that deploy, and that `--dry-run` is the reading. `--dry-run` and
`--follow` stay allowed — they change nothing. The Claude hook rule
`headless-deploy` ([`src/mc/hooks.js`](../../src/mc/hooks.js)) is kept as the
first line; the verb's own refusal is the second, and the only one under Codex,
whose hook has no such rule.

**What it never does.** It never refuses or delays a merge — it runs in this
verb and in the runner's full run only — and it reimplements nothing of `deploy.mjs`;
the one thing it hands the script is `MEMORO_DEPLOY_SKIP_REMOTE_PREFLIGHT=1`
(step 10) — an environment variable, not a new flag. The record keeps the verdicts (below).

## No lease, and one deploy at a time

Until ruling 26 the verb held memoro's repository lease for the whole deploy;
from it, only for the fast-forward and the read of the sha; since ruling 30
(2026-10-09) not at all. A merge round holds that lease for its whole gate, so
any hold made a deploy wait for the merges. A merge landing on
`origin/main` after the placing changes nothing the build sees.

What keeps two deploys apart is the record: a `running` row whose pid is alive
is a deploy in progress (`runningDeploy`,
[`src/mc/deploys.js`](../../src/mc/deploys.js)). It is read before the preparation
— nobody prepares for a deploy that cannot start — and again under the register's lock,
where the new row is written. There is no queue (Martin, 2026-10-09: *"Vi skulle
kunna låta deploy vara utan kö."*): a second `mc deploy` is refused and run again
when the first is done.

### Memoro's lane is the deploy's while it builds (2026-10-18)

No repository lease, but the machine's heavy gate lock: once the rounds in
flight are done (`waitForGate`), the deployer takes `gate-running.json` with
`mode: 'deploy'` and gives it back when the script ends, whatever the outcome
(`holdHeavyLane` in [`src/mc/commands/deploy.js`](../../src/mc/commands/deploy.js)).
`mc test`, the nightly loop and the page see a heavy round, and a `mc gate`
started meanwhile runs [`src/mc/await-deploy.js`](../../src/mc/await-deploy.js)
in its detached child before its tests, so the wait is in the gate's own log and
the verb's budget and `--wait` are unchanged. Martin, 2026-10-18: *"Deploy ska ta
tung lease."* That day the merger waited behind a deploy as it should while
session gates went on beside the bundle, and the deploy took 40 minutes instead
of two, the bundle alone 15. A deployer that dies leaves a lock whose pid is
gone, which is nobody's.

A language run is kept apart the same way. Its record
(`liveRun`, [`src/mc/language-runs.js`](../../src/mc/language-runs.js)) is read
in the same places. `mc language` reads the deploy record under the same lock
before it writes its own, so the two never write to production at the same
time ([`mc-language.md`](mc-language.md)).

### One holder of the deploy worktree at a time (2026-11-15)

mc's own worktree (`~/.memoro/mc/deploy/memoro`) is *placed* — fast-forwarded,
reset back, cleaned — by whoever uses it, so two users at once would move the tree
under each other. It is therefore used by **one holder at a time**. The holder is a
record file beside the worktree, `~/.memoro/mc/deploy/memoro.holder.json` (`{ pid,
verb, started, token }`), written and read under a lock, by `takeHolder` in
[`src/mc/deploy-worktree.js`](../../src/mc/deploy-worktree.js):

- **Who holds it, and for how long.** The exercise of the suites (`deploy suites`),
  for its whole length: from before the placing until its servers are stopped. The
  deployer (`deploy`), from before its placing until the script has exited. `mc
  language` (`language`, [`mc-language.md`](mc-language.md)), for the whole of its
  use: a status read from its fast-forward to its last read, a run or resume from
  its fast-forward until its last act has exited. It is taken before the tree is
  placed or read, and the existing refusals made under the register's lock — a
  deploy or a language run already running — come first.
- **A holder whose pid is gone** is stale: its record is taken over, with a line
  saying so. A record carrying the caller's own pid is the caller's. A holder is
  released only by the one who took it (the record's `token`).
- **A waiter waits while the holder's pid lives**, saying each minute what it waits
  for and since when (`mc: waiting for the deploy worktree — held by <verb> (pid
  <n>), since <time>, <n> min ago`), up to **90 minutes**. After that an exercise's
  suites are cannot-run naming the holder, a deployer's row is completed `failed`
  with `stopped_at: 'held'` (and `mc deploy` again waits for it once more), and `mc
  language` reads nothing.
- **Only mc's own worktree has one.** Where main is held in the person's checkout,
  nothing here is taken: that tree is the person's, and the shared-checkout route
  is as it was.

The deploy worktree has several users, and the holder is what keeps them apart. It is not a lease on the
repository — none of this touches the merge lane.

## A stop that is repaired

*Martin, 2026-11-15: "Ja. Omstart ok."* A typed `mc deploy` that stops on a technical fault is repaired by a mend session
and shipped by the runner once more, without Martin. Each use of that session counts as a fault of mc deploy's design to
remove: the session writes a proposal naming it.

**The request.** One file, `runner/deploy-mend.json`, written under the runner's lock like `runner/main-mend/`. A request
has an `id`, `rows[]` (each: `started`, `sha`, `stopped_at`, `note`, `holder`, `accept_red`, `copies`), a state (`queued`,
`running`, `published`, `repaired`, `retrying`, `Martin`; finished: `deployed`, `stopped`, `not-retried`, `dropped`),
`failures`, `created`. The deploy log and the preparation log are one file each, emptied by the next deploy, so each stop copies
them to `runner/deploy-mend/<id>/<row started>/` and the settlement removes the directory. At most one request is unfinished:
a later technical stop joins it with its own copies. A joined request carries `--accept-red` if any row did, takes the first
row's holder and counts its age from the newest row's `started`. Queueing is done by the typed deploy (or its deployer) after
the row is written and outside the deploy lock; a failed write or copy changes neither the exit code, the row nor the output.

**The repair.** The runner offers a queued request at the main-red mend's rank, with its machinery: `mend-session`, class
fast, a worktree each of memoro-cli and memoro on `mend/deploy-<digest>` from each `origin/main`, no goal identity, two
attempts (a failed one returns the request to the queue; the second waits on Martin with the last session log). The
session's role page has a *Deploy mend* section: find the cause from the rows and logs; fix it at its cause (memoro-cli or
memoro through `mc publish` and the merger, or state mc owns through mc's verbs); never discard a file it cannot show is mc's;
never run `mc deploy`; never touch production data or credentials; write a proposal. `mc publish` on a `mend/deploy-` branch
records the pull request per repository before it queues the merge. It ends with a published pull request, or `mc repo mend
deploy <id> repaired --reason "…"`, accepted only from a mend session for the request its prompt named (`MC_DEPLOY_MEND`),
while it is running with no pull request recorded. A session that ends with neither is a failed attempt, and so is a
closed or red pull request. The request is **repaired** when every recorded pull request landed, or the session said so.

**The retry.** Once, through the same path as a typed deploy — the same pick, the same gate, the same admission, the same
never-backwards guard — with the holder `runner for <holder>, <newest row's started>`. It never carries `--accept-red` and
the headless refusal does not apply to it: it is not a session, the runner is. It starts only when the runner's own code has
every landed memoro-cli merge commit as an ancestor and the pick descends from every landed memoro merge commit; until then
the request stays `repaired` and the reading says what it waits for. It is not made ("repaired, not retried", with its
reason) when the request carries `--accept-red` (a red accepted by a person is not accepted again by the runner), when it is
older than 24 hours — also after waiting — or when a deploy has shipped since its newest row. A retry that ships ends the
request `deployed`; a stop that is not technical ends it `stopped` with the reason. The one retry is then spent: a technical
stop of it, or a retry the runner ended in the middle of that did not ship, puts the request on Martin with the reason and
**queues no new request**, and the request is never retried again — a desk `requeue` gives it two mend attempts, and a repair
after that ends "repaired, not retried". At most, then, a stop costs two mend sessions and one retry. Nothing loops.

**What is shown.** An open request is one line in `mc deploy`'s reading: *a repair of the deploy of `<time>` is
queued|running|repaired, waiting for `<the handover|a green commit with the fix>`|waiting on Martin*, or the reason of a
request repaired and not retried, until a deploy ships after that request ended. It is on the page and, when it waits on Martin, in `mc martin
get`. A person ends or requeues one with `mc repo mend deploy <id> requeue|drop --reason "<text>"`. No form of `mc deploy` is
added: the decision stays typed.

## Grammar is not promoted here

The deploy no longer promotes curated grammar: that is
`mc language promote`, after its own question. memoro's check prints a line
when grammar rows are waiting. `--dry-run` ends with one language line, read
from the cache `mc language status` leaves and the language run records, and
nothing is read anew. The line is one of:

- `mc: language — sv 724 rows waiting (read 2h ago) · mc language promote`;
- `… nothing waiting (read …)`;
- `… no reading; mc language status <lang>`.

When a run stopped inside an `opens_gap` window, a second line names the
stopped run and `mc language resume`. `--json` has the same information as
`language`.

## The record

`~/mc/runner/log/deploys.tsv`, written by
[`src/mc/deploys.js`](../../src/mc/deploys.js) — 172 lines, and the shape follows
`runs.tsv`: a header written once, rows appended whole, read back keyed by the
header the file actually carries rather than the one this module knows.

| column | what it holds |
|---|---|
| `started` | when the row was written, before the spawn |
| `ended` | when the script exited — empty on a deploy that never came back |
| `sha` | what was shipped: the deploy worktree's `HEAD` after the fast-forward (a refused row: `origin/main` as the reading saw it) |
| `build` | the build number from the script's success banner |
| `holder` | who typed it (`currentHolder()`); the runner's one retry of a repaired stop writes `runner for <holder>, <started>` |
| `outcome` | `running`, `deployed`, `failed` or `refused` |
| `live_commit`, `live_build` | what production answered when the script verified it |
| `stopped_at` | the last `▸ <step>` header before a non-zero exit |
| `note` | the reason: the failure message, the refusal, an unverified deploy |
| `pid` | the deployer's process |
| `full_commit`, `full_verdict` | the commit the full run measured and its verdict — `green`, `red`, `stalled`, `unmeasured` or `moved`; empty when none was read |
| `suites` | each suite's result, `name:state` joined by commas — `ok`, `red`, `skipped` or `cannot-run`; `cannot-run:<why>` when none could start; empty when the suites were not run |
| `accepted_red` | the reason given to `--accept-red`, when a red was accepted |
| `take_back` | `yes` when the release could be taken back, `no` when it could not — or when the reading could not be made; empty when no reading was made (a refusal before the plan was known or for a backwards pick) and in rows written before the column |
| `take_back_why` | for `no`, the reasons on one line — `<kind>: <what> (<sha>, …)`, joined by `; `, at most five and `and N more` — or `reading not made: <why>`; empty for `yes` |
| `versions_before` | the Cloudflare Worker version each Worker served before the deploy, `<worker>:<id>` joined by commas, `<worker>:missing` for one that is not known — `memoro:<id>,memoro-tail:<id>`; empty on a row written before the script ran and before the column |
| `versions_made` | the version the deploy made, in the same form; a Worker the deploy did not change has no entry, and `<worker>:missing` is a change whose id is not known; empty as above |
| `versions_why` | why a version is missing, `<worker> before\|made: <why>` joined by `; `; `not reported by the deploy script` when the script printed no version line; empty when none is missing and on a row written before the script ran |
| `check` | the verdict of the check after the deploy (*The check after a deploy*): `green`, `red` or `could-not-run`; empty while it is not made, on a row that is not `deployed` and on a row written before the column |
| `check_at` | when the verdict was reached (UTC, ISO) |
| `check_why` | for `red` and `could-not-run`, what was found, `<part>: <why>` joined by `; ` — the parts are `version`, `database`, `suites` and `errors`, and a part that was not reached reads `<part>: not run`; empty for `green` |
| `takes_back` | on a take-back row, the `started` of the release row it took back; empty on every other row (*The take-back*) |
| `takes_back_sha` | on a take-back row, the commit of that release |
| `takes_back_why` | on a take-back row, what asked for it: the runner's — the release's `check_why` — or the verb's, `typed: <reason>`, with `(despite the reading)` when `--despite` was given |

Two properties are the point of it:

- **The row exists before the deploy does.** `recordStart` appends it with
  `outcome: running`; `recordEnd` completes that same row. A deploy that dies
  half-way — the terminal closed, the laptop slept, a `^C` in the middle of
  wrangler — stays `running` with no `ended`, which is the true thing to say
  about it. Nothing sweeps the file, so that row stands until a person looks at
  it; the page draws a `running` row older than an hour in yellow, which is where
  a person looks.
- **Completing a row rewrites the file through its own header.** A `deploys.tsv`
  written by an older mc keeps its columns, and a column this mc sets that the
  file has no room for is dropped rather than shifting every cell after it. One
  `writeFileAtomic`, so a reader sees the file before or after and never
  half-way. `take_back` and `take_back_why` came before the three version
  columns, which are the last: a refusal made after the reading carries the
  take-back's as the started row does, and a file with the header of any version
  before them is given the new header on its next row, its old rows' cells empty.
  The three check columns are after those, and the three take-back columns are
  the last (26 columns in all); a file with any older header, the 23-column one
  included, is given the current one the same way on its next row. An mc of the
  version before keeps the 26-column header it finds only if it is one, and
  otherwise writes its rows with the new columns empty: it reads a take-back
  row as an ordinary `deployed` row, so what is live is right, and it lacks only
  the pick floor.
- **Every writer takes one lock, once.** `withDeploysLock` (`deploys.js`) is the
  `deploys` lock of the runner (`runner-lock.js`), held through an admission and
  re-entered by the writers inside it without taking it again; `recordStart`,
  `recordEnd`, `recordRefusal` and `recordCheck` take it when they are called
  outside one. `recordCheck` takes it strictly (a held lock throws, it is never
  written around) and writes only the three cells of the one row, reading the
  file again if its size or mtime changed between its read and its write.

The version columns are what taking a release back needs: rolling a Worker back
is returning it to the version it served before the deploy, so the row names
that version and the one the deploy made. They are written when the script
ends, from the script's own lines (below), and a script that printed none leaves
`versions_why` saying so rather than three empty cells that read as a deploy that
changed nothing. A take-back reads `versions_before` and rolls each Worker to
that version only when every Worker it must return is present there; a `missing`
or an empty cell is a take-back that is not made, with the cell's `versions_why`
as the reason, and never a guess from the latest deployment (*The take-back*, D5).

`build` and `live_commit` are deliberately different claims: the banner is what
mc stamped, the verified line is what production answered. A deploy run with
`MEMORO_DEPLOY_SKIP_LIVE_VERSION_VERIFY` therefore gets a row with a `build`, no
`live_commit`, and the note *the script verified no live version*.

`sha` and `live_commit` can still differ on a deploy that took (a script that
was not handed `MEMORO_DEPLOY_SKIP_REMOTE_PREFLIGHT=1`, or a row from before it was
always handed, fast-forwarded to `origin/main` again before it built); the live
commit is therefore read as `live_commit` first and `sha` after it (step 3). The digest (`helper-collect.js`) therefore compares
`/api/version` with the row's `live_commit` when it has one, and with `sha` only
when it does not, so such a deploy is not reported as *somebody deployed another
way*.

### What is read out of the script's output

The spawn pipes stdout and stderr and echoes every chunk straight on, rather than
inheriting them, so the row can say what happened while the person still watches
the steps as they happen. Four lines are matched, after the colours are
stripped, from `~/memoro/scripts/deploy.mjs` as it stood on 2026-09-04 (a fifth,
`Deploy branch: <branch>`, since 2026-11-09, and the Worker version lines, since
2026-11-15, below the table):

| line | where | what it fills |
|---|---|---|
| `▸ <label>` | `step()`, line 63 | `stopped_at` — the last one before a non-zero exit |
| `Live /api/version verified: build <n> · <sha>` | `verifyLiveVersion()`, line 495 | `live_commit`, `live_build` |
| `✓ Deploy complete build <n> · <sha>` | the success banner, line 801 | `build` |
| `✗ Deploy failed` + the line under it | the catch, line 814 | `note` |

The fifth line is the script's last: `Deploy branch: <branch>`, matched exactly,
anywhere in the kept output, the last one winning. It is the only thing mc reads
of a change the script made on its own; it fills no cell, and step 11 acts on it.

The Worker version lines are `Worker version before: <worker> <id>` and `Worker
version made: <worker> <id>`, or `<worker> missing — <why>` for either, one for
each of `memoro` and `memoro-tail`. The script prints a before line right before
its first upload and a made line after each Worker's upload, and repeats all of
them in its closing block, after the summary and before `Deploy branch:`, so
they survive the 256 KB tail. The last line for a kind and a Worker wins. They
fill `versions_before`, `versions_made` and `versions_why`, and `--json` carries
them as `versions: { before: { <worker>: <id>|null }, made: { … }, why: […] }`.
A Worker with no made line is a Worker the deploy did not change. They are
written for a deploy that failed or was interrupted too, since a take-back after
a half-made deploy needs the same two versions.

The parsing is tolerant on purpose, and only the last 256 KB of output is kept —
a container build prints megabytes before any of these. **A deploy that worked
must never be recorded as a failure because mc could not parse the banner it
printed**, so a line that is not there is an empty cell and the exit code alone
decides the outcome.

The deployer also publishes complete `▸ <label>` lines as they arrive in
`runner/log/deploy-progress.json`. Split UTF-8 and colour sequences are buffered
until the line is complete; noisy output never displaces the last observed
step. Each atomic snapshot names the attempt's start time and deployer pid.
The page accepts it only when both match its latest deployment record.

The progress bar groups the current script's steps by phase:

| Phase | Script steps |
|---|---|
| Prepare `[●···]` | Source, dependency, Wrangler auth/API and pending-migration preflights; container image pins |
| Build `[━●··]` | Ajv validators, CSS, assistant 3D avatar runtime, public-page pre-rendering, app bundle/shell and retaining the previous generation |
| Publish `[━━●·]` | Post-build git preflight, version and service-worker stamps, reviewed language grammar, reading the live Worker versions, main Worker deployment, optional after-build migrations and tail-worker deployment |
| Verify `[━━━●]` | Verify live version |

Before the script starts, the same snapshot shows waiting for the deployment
lane, preparing the worktree, checking disk capacity or starting the script.

Disk capacity is the shared admission in `disk-pressure.js`, asked at the spawn
itself. When another mc process holds the admission lease (the runner holds it
through a session's allocation and spawn), the deploy says once that it is
waiting, asks again every second, and refuses with `stopped_at: disk` only if
the lease is still held after ten minutes. Too little space or an unreadable
reading refuses at once.
The empty bar `[····]` means waiting or an unknown phase. An unfamiliar script
step is still shown by its actual label, with no guessed position. A successful
deployment removes its attempt frame; a failed attempt stays red with its stop
reason. The page shows a pid only while that attempt is alive. The completed
record retains its historical pid without holding any process or deployment lane.
The bar marks phases rather than time or a percentage; optional migrations
and retries therefore do not distort an estimated total.

The cost of piping is that the child sees a pipe and not a terminal, so a tool
inside the deploy that draws a progress bar only for a TTY prints plain lines
instead. stdin stays inherited: `deploy.mjs` asks nothing, but wrangler's own
login flow might. If that ever matters, the fix is a pty, not a smaller record.

## The check after a deploy

Every deploy that ends `deployed` is checked afterwards, with nobody present
([`src/mc/deploy-check.js`](../../src/mc/deploy-check.js)). The runner's chore
pass starts it detached (`deploy-check-run.js`, its own process group, output in
`~/mc/runner/log/deploy-check/<started>.log`); the verdict is the row's `check`,
`check_at` and `check_why`. **A red is acted on** (*The take-back*): a release
whose reading said it can be taken back is taken back by the runner at once;
any other red comes to the desk with the steps that can act in its case; and
every red opens a main-red repair, one member per red part. A red does not stop
the runner, hold a merge or refuse the next deploy, except that the commit
taken back is no pick until a later one is green; it is also a word on the
page, in `mc deploy` and in the digest.

**The four parts.** The check is `green` only when all four are present and
green; a `red` part beats a `could-not-run` one; `check_why` names each part
that is not green, and `<part>: not run` for each one never reached.

| part | what it asks | green when |
|---|---|---|
| `version` | production's `/api/version`, read through `sameCommit` (`commit_full` when it answers one, else `commit`) | it answers the row's `sha`; read again after the wait, and a commit that differs then is `could-not-run`, since somebody has deployed since |
| `database` | `/ping-d1` | `d1` is `healthy` |
| `suites` | the gating suites of `mc test prod` (`isGate`), through `productionRound` (`test-environment.js`) with `gateOnly`, as the seeded test account, in the deploy worktree put at the row's `sha`, under the holder verb `deploy check`; no dev or static server is started | every suite passes |
| `errors` | `scripts/admin/survey-errors.mjs --env production --since <time> --limit 200`, read twice: once before the deploy (`takeBeforeReading`, inside the deploy's holder, before the script is spawned) and once after the wait, from the row's `sha` | no fingerprint in the second reading is new since the deploy: first seen at or after the row's `started` (compared to the second), or absent from a complete first reading (*returned*). Any one is red. When nothing is red, a reading that is truncated, missing or unreadable is `could-not-run`, never green |

The before-reading is kept in `<started>.before.json` as `{ ok, survey }` or
`{ ok: false, why }`. A reading that cannot be made never changes the deploy: it
says so on stdout (*the error reading before the deploy was not made*) and the
deploy ships as it would have. The check then has nothing to compare with and
its `errors` part is `could-not-run` with that reason.

Every request is bounded at 30 s. The check waits until the deploy's `ended` plus
30 minutes before it reads the errors, so that a fault that needs traffic has had
it. Its attempt has a deadline of `max(start, ended + 30 min) + 30 min`; one past
it has its process group killed and is written `could-not-run`.

**The chore** (`deployCheckTick`, a step of the runner's chore pass — `mc-run.md`,
*What runs beside it*). It copies a verdict file into a row whose check is empty
(the check wrote its verdict to a file first, so a lock held by another writer
loses nothing); settles an attempt in flight — a dead process is written
`could-not-run` (*the check ended without a verdict*), a live one past its
deadline is killed and written so — and then returns, leaving the next row to a
later pass; and otherwise starts the oldest *due* row: `deployed`, `ended` at or
after `from` (written into `~/mc/runner/deploy-check.json` on the first pass and
never moved, so a row from before this existed is not checked, once), with an
empty `check`. A due row with a later deployed row is written `could-not-run`
(*superseded by <short> before it was checked*) and never started. One start per
pass; nothing starts under STOP or UPDATE or while a deploy is running; a start
that fails is written `could-not-run` (*the check could not be started*).

**Refused to a session.** `deploy-check-run.js` exits 2 under `MC_HEADLESS=1`
before it does anything, and the hook `headless-deploy-check` (`hooks.js`) refuses
a session command that runs it. The check reads production and signs in as the
test account; it is the runner's, and nobody types it. `mc test prod` is the
same round, still typed by a person and never run by itself.

**Where it is said.** The page's RECORDED line, `mc deploy`'s plan line and
`--json` (`last.check`, `last.check_at`, `last.check_why`, `last.checking`) and
the helper's digest say it in the same words (`checkWords`): `checked green`,
`check red: <why>`, `check could not run: <why>`, `checking` (an attempt of this
row is alive) and `not checked`.

## The take-back

A release whose check is red is put back at once, whole, by the runner, when its
reading says it can be; the same take-back is a verb for a person. It is
[`src/mc/release-take-back.js`](../../src/mc/release-take-back.js) (the function,
`takeBack`), [`src/mc/take-back-run.js`](../../src/mc/take-back-run.js) (the
runner's reaction and the desk entries),
[`src/mc/check-red-ledger.js`](../../src/mc/check-red-ledger.js) (the red
ledger) and [`src/mc/commands/deploy-take-back.js`](../../src/mc/commands/deploy-take-back.js)
(the verb). What a rollback does not undo, and how to take a release back by
hand, are memoro's:
[`docs/technical/release-take-back.md`](../../../memoro/docs/technical/release-take-back.md)
and its `docs/runbooks/deploy.md`.

**The provider call is memoro's.** mc calls no Wrangler and no Cloudflare API
itself. It runs memoro's `scripts/release/take-back.mjs`, exported from the
release's own sha (`scripts/` as that commit had it) into a scratch directory,
with the deploy worktree as its working directory, under the holder verb `take
back`. Its arguments are `--worker <name>=<from>:<to>` once per Worker, `--message`
and `--dry-run`; it prints `{ schema_version: 1, ok, workers: [{ worker, from, to,
state, serving, why }] }` and exits 0 when every Worker was taken back, 1 when not
and 2 on a usage error. A Worker already serving `to` is counted as taken back,
so a second attempt finishes what a first left. mc reads only that JSON, strictly:
anything else is a take-back that did not take every Worker back.

**The gate (what is refused, and the reason is said in words).** The release
`R` is the last `deployed` row of the record, and:

- it is not itself a take-back row (*a take-back is not taken back; ship a
  later commit*);
- no `deployed` take-back row names it (`takes_back` is its `started`);
- `versions_made` has at least one Worker, each with an id there and in
  `versions_before`, and `versions_why` is empty;
- a `deployed` row exists before it, and what that row made equals `R`'s
  `versions_before` (production was not changed between them);
- `R`'s sha has `scripts/release/take-back.mjs` and the deploy worktree has
  `node_modules/.bin/wrangler`.

Each Worker goes from the id `R` made back to the one before it; a Worker `R`
did not change is left alone, memoro before memoro-tail. The commit that is live
again is the earlier row's `live_commit`, else its `sha`. `--despite` overrides
the reading's `take_back` and nothing above. A `failed` take-back row blocks the
runner, which takes a release back once, and not the verb, which finishes it.

**The admission is atomic.** The function takes the deploy worktree's holder
first (a busy one is waited for, up to 10 minutes, and the take-back is then not
made and untried), then one `deploys` lock under which it reads the record again,
asks the gate again, finds no deploy running and writes the take-back's `running`
row, and only then runs the script. A deploy, another take-back, or a later
release that came first makes it not made, with no row. The take-back row is an
ordinary deploy row whose `sha` is the commit returned to, `take_back` is `no`
(the reading of a take-back is not made) and `takes_back*` name `R`; it ends
`deployed` only when every Worker was taken back, and `failed` with
`stopped_at: take-back` otherwise, with `versions_before` the versions served
before the take-back, `versions_made` those serving now (`<worker>:missing` for
a Worker not taken back) and `versions_why` the reason for each. The check
after a deploy runs on that row like any other.

**The reaction.** When `executeCheck` records a `red` it starts
`take-back-run.js <started>`, detached in its own process group, so the check's
deadline kill does not reach it; the first step of every chore pass
(`takeBackTick`, before the helper day and the desk turns) starts it for every
red row whose entry is not done in the red ledger when no reaction for it is
alive. The reaction holds the row's ledger entry by pid; a second for the same row
exits at once. It takes `R` back when the gate holds, the row is `red`, the
reading is `yes`, and `R` is still the last release; otherwise it records why not
and acts on the desk path. It always asks for the repair. Under `MC_HEADLESS=1` it
exits 2.

**The repair.** One main-red member per red part, `check:<part>@<started>`, each
with the part's reason, the verdict file's path and whether the release was taken
back; once-only in any state, so two reds of different releases are two members
and a repeat never asks again (`requestMainRepair`). The ledger records the
member ids and the reaction asks only while that record is empty. The repair does
not deploy: the next deploy of a later green commit ships it. `mainMendPrompt`
words these members in the mend role's own terms
(`canon/roles/mend-session.md`).

**The red ledger,** `~/mc/runner/check-red.json` (`check-red-ledger.js`): `{
version: 1, from, entries: { "<started>": { sha, parts, pid, repair, take_back,
desk, reason, steps, created, done } } }`, written whole under a lock of its own
and read strictly (a file that does not parse is an error said, not an empty
ledger). `from` is when the ledger began: a red recorded before it is not a
reaction's to make, and the first chore pass only begins the ledger.

**What reaches the desk.** A red that was not taken back (the reading is `no` or
empty, `R` fails the gate, the take-back failed or was partial, the red row is
itself a take-back, or the holder stayed busy) has `desk: Martin` and `steps`:
what was red, what serves now, the main-red mend, and the one path that acts —
`mc deploy take-back --despite "<reason>"` with what the reading says would not
be undone; or `mc deploy take-back`, which finishes a partial one, with the
`npx wrangler rollback <id> --name <worker> --message "…"` lines still needed, run
in the deploy worktree; or, for a take-back that is itself red, to ship the
repair. `mc martin get` lists it as a `take-back` item (`take-back:<started>`,
read from the ledger, not synced as a desk item). It ends when a later
`deployed` row ships after it, or when a person ends it with `mc deploy
take-back --end <started> --reason "…"`.

**The verb.** `mc deploy take-back [--dry-run] [--despite "<reason>"] [--json]`
calls the same function as the reaction with `by: 'verb'` and takes the last
`deployed` row back, red or not. A reading that is `no` or empty is refused unless
`--despite`, whose reason is the row's `takes_back_why`. `--dry-run` runs only the
script's own `--dry-run` and writes nothing. Exit 0: every Worker was taken back;
1: a take-back that ran and did not take every Worker back (its row is `failed`;
the verb again finishes it); 2: a refusal, with the condition in words, and no
row. Under `MC_HEADLESS=1` only `--dry-run` is allowed; the verb refuses the rest
and the hook `headless-deploy` refuses it to a session. `mc deploy` itself gains
no flag.

**Refused to a session.** `take-back-run.js` exits 2 under `MC_HEADLESS=1`, and
the hook `headless-take-back` (`hooks.js`, reserved act `deploy`) refuses a
session command that runs it, or memoro's `scripts/release/take-back.mjs`
without `--dry-run`. Taking production back is a person's act or the runner's.

## Who reads the record

Three readers, and they agree because they read the same row.

- **The page** — the DEPLOY frame in MERGE & DEPLOY, drawn by `deployLines` in
  [`src/mc/page-operations.js`](../../src/mc/page-operations.js) from `productionSection`
  in [`src/mc/page-collect.js`](../../src/mc/page-collect.js). It also draws a
  deploy running now, a deploy that failed after the last good one with the step
  it stopped at, and — when the two sources disagree — the difference, in yellow.
  See [`mc-ui.md`](mc-ui.md).
- **The brief** — the session reads DEPLOY on the page: the last deploy and
  what has not shipped. `canon/roles/manager.md` says what to do with it: a
  `main` well ahead of production with a green nightly is a deploy to
  **propose**, one line, for Martin to type. (Until 2026-09-19 the gathered
  brief carried a *Production* section of its own.) See [`mc-manager.md`](mc-manager.md).
- **The helper** — `deployState` in
  [`src/mc/helper-collect.js`](../../src/mc/helper-collect.js) takes the row
  beside `/api/version`'s build time, and the age is the fresher of the two.
  (It read `/admin/deploy/logs` beside the row until memoro removed that route
  and the GitHub webhook behind it, 2026-10-03.) See [`mc-helper.md`](mc-helper.md).

### Why `/api/version` is cached, and by whom

The page is offline and instant, so it must not fetch. `mc helper --collect`
therefore asks `/api/version` as a sixth source — public, no token, beside
`/ping-d1` — and writes the answer with the moment it was asked to
`~/mc/runner/version.json`
([`src/mc/live-version.js`](../../src/mc/live-version.js)). The page reads that
file and carries its age.

`mc deploy` does **not** use that cache. It asks production *now*, because a
person is about to ship and "what was live when the helper last ran" is a
different question from "what is live". The two are ten lines each rather than
one seam neither would fit.

The row and the version are separate readings on purpose, and the page draws the
difference between them: the row says what mc shipped, the version says what is
answering requests, and a deploy somebody made another way is exactly the case
where they differ.

## Where `deploy.mjs` ends and mc begins

The boundary is a rule, not a judgement call:

- **mc does not deploy.** No step of `scripts/deploy.mjs` is reimplemented here,
  no flag is invented for it, and it is not edited from this repository. The
  environment variable it is always handed is one the script itself reads. If a
  preflight mc wants is missing there, that is a memoro pull request made on its
  own terms.
- **mc chooses where the script runs, and moves that checkout in one way only.**
  `deploy.mjs` keeps its own preflight — it refuses a dirty tree and a branch that
  is not `main` (`REQUIRED_PROD_BRANCH`, `ensureCleanWorktree`) — and mc reimplements none
  of it. Its remote step, `ensureUpToDateWithOrigin`, which would fast-forward to
  the remote main, is skipped under `mc deploy` by
  `MEMORO_DEPLOY_SKIP_REMOTE_PREFLIGHT=1`: the commit was chosen here. What mc adds
  is a `cwd` that is always a `main`, and one placement at the sha that was
  measured after the admission, by the deployer: `git merge --ff-only <sha>` when
  behind, and `git reset --keep <sha>` in mc's own worktree only, when the pick
  is an ancestor of HEAD, HEAD is an ancestor of `origin/main` and the tracked
  tree is clean. Anything else in that worktree is
  refused with the path in the row; nothing is ever stashed or discarded.
  Before ruling 16 (2026-09-06) the spawn's `cwd` was `~/memoro` whatever branch
  it stood on, and two deploys died at *Deploy source preflight* for exactly
  that.
- **mc knows nothing about containers, Docker or Wrangler auth.**
  `MEMORO_DEPLOY_CONTAINERS`, the OrbStack preflight and every credential the
  deploy needs are the environment's, passed through untouched. A stale
  container image is the script's to build, push and pin; what reaches mc is
  only a branch.
- **mc reads the Worker versions the script prints, and reads none from
  Cloudflare.** `deploy.mjs` runs `wrangler deployments status` and reads
  wrangler's output file; mc matches the lines the script prints from them and
  writes them into the row. A read that failed is a `missing` in the script's
  line, and never a deploy that failed.
- **mc handles a branch the deploy produced, not what is on it.** The script
  must leave the checkout clean on `main` (mc refuses anything else there and
  never resets it), so a change it made — the pin lines of an image it built —
  is committed on a new branch from the deployed sha with git plumbing (HEAD and
  the index never move), pushed, and named in one line, `Deploy branch:
  <branch>`, whether the deploy succeeded, failed or was interrupted. mc opens a
  pull request from that branch and queues it for the merger (step 11); it never
  pushes to `main`, never opens a branch of its own, and does not look at the
  diff. The only way a change reaches `main` is the merger, as for every other
  change. A failure to open or queue the pull request changes nothing about the
  deploy.
- **The exit code is the script's.** mc adds no verdict of its own to a deploy
  that ran.

What is deliberately not here: memoro's **release race**
(`scripts/release-race.mjs`), whose deploy stage could one day call this verb;
whether it should is a question for after this change. Rollback is no longer
among them: *The take-back*.

## How it is tested, and what has not been measured

[`tests/mc/commands/deploy.test.js`](../../tests/mc/commands/deploy.test.js)
drives the whole verb with every process boundary faked — git, the spawn, the
version fetch, the nightly, the deployer (`startDeployer` runs
`ship` in the test's own process) — because they are all on `deps`. The record
is the exception, and deliberately so: it is what this verb exists to leave
behind, `env` already points it at a throwaway directory, and a faked writer
would only prove that the fake was called. One test
starts a real `npm run deploy` against a `package.json` whose script only prints,
and asserts both the echo and the capture.
The gate has one test per case in the same file, its boundaries — the history,
the full run, the mends, the servers and the suites — on `deps` too: a green run
reaches the deployer, asked nothing; an older commit, a red run and a stalled run each refuse; no
run starts one and follows it; `--dry-run` starts nothing; `--accept-red` reaches
the deployer with the reason in its line and the record; every refused case asserts that
`deploy.mjs` was not started. The suites have a modelled runner (all pass, one
fails, one cannot start, one exits with the skip code) and assert the commit the
server was started on. The pick has a case per decision (newest green after the live
commit, red and stalled and unmeasured tips passed over, nothing green, live
unknown, never backwards), the reading has the exact lines for four situations,
and the exact-commit suites have cases for the hold order, a server that leaves
mid-run and a revive at another commit. A non-gate suite and a stale preparation
have one case each. The headless cases assert that no git, history, full-run or
suite call was made. A fault check holds the first set: accepting a green run of
an older commit makes the "older commit" case fail, and the test file is green
again without it.
The reader and the two writes had a test until 2026-11-01, removed with the
tests that never caught anything; the page, brief and helper readings are
covered in their own suites from fixtures.

The own route has its own cases in the same file, asserted through the
verb's and the gate's seams with an injected clock: the worktree is placed at the
pick before any ensure and every ensure and revive is given it and never the
shared checkout (also when that is dirty, on another branch or held, and no git
call is made on it); a server serving another commit makes the rest cannot-run;
each way `placeWorktree` refuses (modified tracked files, commits `origin/main`
lacks, off the line, a failed reading) is cannot-run naming what stood, and
untracked strays are removed; a slot not had is cannot-run with the pool's
reason; the servers the exercise started are stopped after a pass and a
refusal, and one already there is left; a finished preparation reused after
the worktree was moved elsewhere on `origin/main`'s line ships because `ship`
places it at the pick again; and the holder — a live one waited for and the
exercise then runs, 90 minutes of a live one is cannot-run naming it, a
holder whose pid is gone is taken over, a deployer waits the same way and ends
`failed` stopped at `held`, and a dry run without mc's own worktree makes it.
The route choice has a case each way: main in a worktree that is not mc's own
keeps the shared-checkout route (pinned, no placing, no holder). `mc language`'s
holder is tested in `tests/mc/commands/language.test.js`. Seven fault checks hold
them (the exercise handed the shared checkout, `ship` not placing again, the
served-commit check dropped, a started server left running, placing without the
holder, a dead holder waited for, `mc language` releasing the holder after its
fast-forward): each turns a named test red, and the files are green again
without it.

Where `main` is has a test per case — in another worktree, behind, dirty, ahead,
checked out nowhere with mc's worktree absent, and mc's worktree present — and
each asserts the spawn's `cwd` where there is a spawn and the refused row where
there is not. The fake `git` answers `worktree list --porcelain` with a stanza
set the test chooses and `status` / `rev-list --count` per worktree path, so a
whole machine's shape is one object. `worktreeOnBranch` (and `mainWorktree` over
it) in [`src/mc/git.js`](../../src/mc/git.js) is a pure function over the
porcelain text with its own tests, including `detached`, `bare`, a path with a
space and a branch merely *starting* with `main`.

**The reading half has been run for real**; the deploying half has not.
`mc deploy --dry-run` was run on 2026-09-07 (both outputs above: once with the
repository checkout on `main` and once with it on a feature branch), and on
2026-09-04 (at `c061d74` and `e30fd83`). Everything from the gate's end onwards —
the fast-forward, the deployer, the spawn, the completed row — has only ever run
against a faked script. The own route's reading has been run for real too: `mc
deploy --dry-run` in mc's own worktree, with the suites served in it at the pick
and the shared checkout's commit the same before and after (the goal's log has
the shas and the seconds to the first suite).
The one real deploy is Martin's to type, watched, and this note should say what
it did when it has happened.
