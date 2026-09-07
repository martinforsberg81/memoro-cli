# mc deploy — one door to production, and a record of every time it opened

`mc deploy` is the verb a person types to put memoro's `main` in production, the
way `mc merge` is the verb that puts a pull request on `main`. It is not a
deploy tool. memoro's own `npm run deploy` — `scripts/deploy.mjs`, 820 lines and
seventeen steps ending in *Verify live version* — is the deploy, and this verb
reimplements no part of it, passes it no flag it does not already take, and does
not edit it.

What the verb adds is everything around the script:

- **the reading**, so the person deciding sees what would ship before they say
  yes: the sha, what is live now, the gap between them, whether the nightly
  ever measured that tree whole, and which worktree it would run in;
- **a `main` to run it in**, found where `main` is already checked out or made
  and kept by mc, so nobody checks `main` out by hand to deploy;
- **one question**, always, with no flag that skips it;
- **the lease**, so a gate round or a landing cannot move `main` under the build;
- **the record**, written before the deploy starts and completed after it ends,
  so a deploy that dies half-way is a row that says so rather than a silence
  somebody reconstructs from `/admin/deploy/logs` afterwards.

Before it, mc knew about a deploy only after the fact, and only through that
webhook log — which had been writing nothing for weeks
([`mc-helper.md`](mc-helper.md) § *the deploy section*).

## The sequence

```
mc deploy [--dry-run] [--json]
```

It takes no repository argument and never will: memoro-cli is installed, not
deployed. `REPO` is `memoro` in
[`src/mc/commands/deploy.js`](../../src/mc/commands/deploy.js), resolved to a
path through `defaultRepos(env)`, the same reading `mc brief` uses.

1. **Fetch and read.** `git fetch origin main` in `~/memoro`, then
   `rev-parse origin/main` — the sha that would ship — and its subject. Refs
   are shared by every worktree of a repository, so these reads stay here
   whatever branch this checkout is on, and so does the lease in step 7.
2. **Where the script will run.** `git worktree list --porcelain` in `~/memoro`,
   and the worktree whose branch is `refs/heads/main` is the one — git allows at
   most one, so there is nothing to choose between. When no worktree has `main`
   out, mc makes its own at **`~/.memoro/mc/deploy/memoro`**
   (`git worktree add`, from `main` or from `origin/main` when the branch is not
   local) and says so in one line. Then, in that worktree: `status --porcelain`,
   `rev-list --count origin/main..HEAD` and `rev-list --count HEAD..origin/main`
   — dirty and diverged are refusals (below), behind is fast-forwarded in step 8.
   `--dry-run` makes nothing: it names the worktree it *would* make.
3. **What is live.** The last `deployed` row of `~/mc/runner/log/deploys.tsv`
   when there is one; otherwise `GET https://meetmemoro.app/api/version`, which
   is public, tiny (`{ commit, build, build_time }`) and asked with `no-store`.
   The row is preferred because it is mc's own record of what mc shipped.
4. **The gap.** `git rev-list --count <live>..<sha>`. A sha the checkout does not
   have is *"the gap is unknown"*, never a number.
5. **The nightly.** `readNightlyHistory`
   ([`src/mc/nightly-history.js`](../../src/mc/nightly-history.js)) has the last
   full-suite measurement per repository with the commit it measured. When that
   commit is not the one about to ship, the line says so plainly and the verb
   still asks — it is a reading a person weighs, not a gate.
6. **The question**, at a terminal: `deploy <short sha> to production? [y/N]`.
   Anything but `y`/`yes` ends it.
7. **The lease.** `claimLease({ repoPath, errand: 'deploy <sha>', … })`
   ([`src/mc/repo-lease.js`](../../src/mc/repo-lease.js)), keyed on `~/memoro`
   because that is the path the runner's merge rounds claim against, held for
   the whole deploy and released in a `finally` however it ends.
8. **The fast-forward**, when the worktree is behind: `git merge --ff-only
   origin/main` in it, under the lease, after the yes. It is the one movement of
   somebody else's checkout this verb makes, and it moves it to exactly the sha
   the person just said yes to, on a tree already proved clean and not ahead.
9. **The script.** `npm run deploy` in that worktree, the process's environment
   passed through untouched, its output echoed as it happens.
10. **The row completed** — outcome, build, the live version the script verified,
    and the step it stopped at when it failed.

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
checkout is neither a project nor something the board should draw.

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

Deploying to production is Martin's word every time (his letter: *"Deploy till
produktion"* is one of the things to ask about first), so the verb refuses
rather than assumes wherever there is nobody to ask.

| situation | code | what happens |
|---|---|---|
| a positional argument, or a bad flag | 2 | usage; nothing read |
| `--dry-run` | 0 | the reading, and it stops there — no lease, no row, no spawn |
| no checkout of `memoro` on this machine | 1 | says so; this verb deploys that repository and no other |
| the checkout has no `origin/main` | 1 | says so |
| **`main` is dirty** where it is checked out | 1 | names the path and the first five files; refused row *"main is dirty in `<path>` — `<n>` file(s)"*. Nothing is stashed, reset or discarded — that tree may be somebody's |
| **`main` has commits `origin/main` does not** | 1 | refused row *"main in `<path>` has `<n>` commit(s) not on origin/main"*: what would ship is not that tree |
| `git worktree add` for mc's own `main` failed | 1 | says so; refused row. There is no checkout of `main` to run the script in |
| the fast-forward failed | 1 | refused row, lease released, nothing spawned |
| **no TTY** | 2 | *"mc deploy asks before it deploys, and there is no terminal here to ask"* |
| the question answered `no` | 1 | *"nothing was deployed"* |
| the repository lease is held | 1 | names the holder and the errand, as `mc merge` does |
| the script ran | its own | whatever `npm run deploy` exited with |

`main` checked out **nowhere** is not on this list and is not a refusal: mc makes
its own worktree and deploys from that. A `main` merely *behind* `origin/main` is
not one either — it is fast-forwarded in step 8.

The decisions among them — `no`, no terminal, a held lease, and the three
worktree refusals — are each written to the record as `outcome: refused` with
the reason. They are deploys somebody meant to make, and the brief can only see
them if they exist.

A deliberate `no` is exit **1** rather than 0 on purpose, so `mc deploy && …`
does not carry on as though it had shipped.

`--dry-run` writes no row at all. Nothing was attempted, and a row per person
checking what would ship would drown the ones that matter.

## The lease

The verb claims memoro's repository lease with errand `deploy <sha>` before the
spawn. That is the same lease a merge round takes
([`mc-merge.md`](mc-merge.md) § *One round at a time*), so while a deploy runs,
the runner's next gate round waits and a person's `mc merge` is refused by name.
The reason is narrow and worth saying: what `deploy.mjs` reads out of the working
tree must still be the tree the person said yes to. It carries the holder's pid
like every other claim, so a deploy that was killed rather than finished is
reaped by the next claim instead of blocking for ever.

It blocks no git at all. The lease is an agreement between mc's own verbs.

## The record

`~/mc/runner/log/deploys.tsv`, written by
[`src/mc/deploys.js`](../../src/mc/deploys.js) — 172 lines, and the shape follows
`runs.tsv`: a header written once, rows appended whole, read back keyed by the
header the file actually carries rather than the one this module knows.

| column | what it holds |
|---|---|
| `started` | when the row was written, before the spawn |
| `ended` | when the script exited — empty on a deploy that never came back |
| `sha` | what was shipped: `origin/main` as the reading saw it |
| `build` | the build number from the script's success banner |
| `holder` | who typed it (`currentHolder()`) |
| `outcome` | `running`, `deployed`, `failed` or `refused` |
| `live_commit`, `live_build` | what production answered when the script verified it |
| `stopped_at` | the last `▸ <step>` header before a non-zero exit |
| `note` | the reason: the failure message, the refusal, an unverified deploy |

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
  half-way.

`build` and `live_commit` are deliberately different claims: the banner is what
mc stamped, the verified line is what production answered. A deploy run with
`MEMORO_DEPLOY_SKIP_LIVE_VERSION_VERIFY` therefore gets a row with a `build`, no
`live_commit`, and the note *the script verified no live version*.

### What is read out of the script's output

The spawn pipes stdout and stderr and echoes every chunk straight on, rather than
inheriting them, so the row can say what happened while the person still watches
the seventeen steps as they happen. Four lines are matched, after the colours are
stripped, from `~/memoro/scripts/deploy.mjs` as it stood on 2026-09-04:

| line | where | what it fills |
|---|---|---|
| `▸ <label>` | `step()`, line 63 | `stopped_at` — the last one before a non-zero exit |
| `Live /api/version verified: build <n> · <sha>` | `verifyLiveVersion()`, line 495 | `live_commit`, `live_build` |
| `✓ Deploy complete build <n> · <sha>` | the success banner, line 801 | `build` |
| `✗ Deploy failed` + the line under it | the catch, line 814 | `note` |

The parsing is tolerant on purpose, and only the last 256 KB of output is kept —
a container build prints megabytes before any of these. **A deploy that worked
must never be recorded as a failure because mc could not parse the banner it
printed**, so a line that is not there is an empty cell and the exit code alone
decides the outcome.

The cost of piping is that the child sees a pipe and not a terminal, so a tool
inside the deploy that draws a progress bar only for a TTY prints plain lines
instead. stdin stays inherited: `deploy.mjs` asks nothing, but wrangler's own
login flow might. If that ever matters, the fix is a pty, not a smaller record.

## Who reads the record

Three readers, and they agree because they read the same row.

- **The page** — one line in the RUNNER block, `production <sha> · deployed
  <age> ago by <holder>`, drawn by `productionLine` in
  [`src/mc/page-render.js`](../../src/mc/page-render.js) from `productionSection`
  in [`src/mc/page-collect.js`](../../src/mc/page-collect.js). It also draws a
  deploy running now, a deploy that failed after the last good one with the step
  it stopped at, and — when the two sources disagree — the difference, in yellow.
  See [`mc-ui.md`](mc-ui.md).
- **The brief** — a *Production* section between *Runner* and *Held before
  merge*: the last deploy, `git rev-list --count <it>..origin/main` as what has
  not shipped, and the nightly's verdict. `canon/roles/brief.md` says what to do
  with it: a `main` well ahead of production with a green nightly is a deploy to
  **propose**, one line, for Martin to type. See [`mc-brief.md`](mc-brief.md).
- **The helper** — `deployState` in
  [`src/mc/helper-collect.js`](../../src/mc/helper-collect.js) takes the row
  beside `/admin/deploy/logs`, and the age is the freshest of the two, so a
  deploy Martin typed an hour ago is not called stale because the webhook never
  heard of it. See [`mc-helper.md`](mc-helper.md).

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
  no flag is invented for it, and it is not edited from this repository. If a
  preflight mc wants is missing there, that is a memoro pull request made on its
  own terms.
- **mc chooses where the script runs, and moves that checkout in one way only.**
  `deploy.mjs` keeps its own preflight — it refuses a dirty tree, a branch that
  is not `main`, and a `main` that is not `origin/main` (`REQUIRED_PROD_BRANCH`,
  `ensureCleanWorktree`, `ensureUpToDateWithOrigin`) — and mc reimplements none
  of it. What mc adds is a `cwd` that is always a `main`, and one
  `git merge --ff-only origin/main` after the yes, under the lease, on a tree it
  has just read as clean and not ahead. Anything else in that worktree is
  refused with the path in the row; nothing is ever stashed, reset or discarded.
  Before ruling 16 (2026-09-06) the spawn's `cwd` was `~/memoro` whatever branch
  it stood on, and two deploys died at *Deploy source preflight* for exactly
  that.
- **mc knows nothing about containers, Docker or Wrangler auth.**
  `MEMORO_DEPLOY_CONTAINERS`, the OrbStack preflight and every credential the
  deploy needs are the environment's, passed through untouched.
- **The exit code is the script's.** mc adds no verdict of its own to a deploy
  that ran.

What is deliberately not here: **rollback** — a verb that puts a previous sha
back is a project of its own, now that there is a record to roll back to — and
memoro's **release race** (`scripts/release-race.mjs`), whose deploy stage could
one day call this verb; whether it should is a question for after this project.

## How it is tested, and what has not been measured

[`tests/mc/commands/deploy.test.js`](../../tests/mc/commands/deploy.test.js)
drives the whole verb with every process boundary faked — git, the spawn, the
prompt, the version fetch, the nightly — because they are all on `deps`. The
lease and the record are the two exceptions, and deliberately so: they are what
this verb exists to leave behind, `env` already points both at a throwaway
directory, and a faked writer would only prove that the fake was called. One test
starts a real `npm run deploy` against a `package.json` whose script only prints,
and asserts both the echo and the capture.
[`tests/mc/deploys.test.js`](../../tests/mc/deploys.test.js) covers the reader
and the two writes; the page, brief and helper readings are covered in their own
suites from fixtures.

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
2026-09-04 (at `c061d74` and `e30fd83`). Everything from the question onwards —
the fast-forward, the lease, the spawn, the completed row — has only ever run
against a faked script; mc's own worktree at `~/.memoro/mc/deploy/memoro` has
therefore never been made on this machine, because `main` has always been
checked out somewhere.
The one real deploy is Martin's to type, watched, and this note should say what
it did when it has happened.
