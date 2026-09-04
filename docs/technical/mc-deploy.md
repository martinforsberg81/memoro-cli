# mc deploy — one door to production, and a record of every time it opened

`mc deploy` is the verb a person types to put memoro's `main` in production, the
way `mc merge` is the verb that puts a pull request on `main`. It is not a
deploy tool. memoro's own `npm run deploy` — `scripts/deploy.mjs`, 820 lines and
seventeen steps ending in *Verify live version* — is the deploy, and this verb
reimplements no part of it, passes it no flag it does not already take, and does
not edit it.

What the verb adds is everything around the script:

- **the reading**, so the person deciding sees what would ship before they say
  yes: the sha, what is live now, the gap between them, and whether the nightly
  ever measured that tree whole;
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
   `rev-parse origin/main` — the sha that would ship — and its subject.
2. **What is live.** The last `deployed` row of `~/mc/runner/log/deploys.tsv`
   when there is one; otherwise `GET https://meetmemoro.app/api/version`, which
   is public, tiny (`{ commit, build, build_time }`) and asked with `no-store`.
   The row is preferred because it is mc's own record of what mc shipped.
3. **The gap.** `git rev-list --count <live>..<sha>`. A sha the checkout does not
   have is *"the gap is unknown"*, never a number.
4. **The nightly.** `readNightlyHistory`
   ([`src/mc/nightly-history.js`](../../src/mc/nightly-history.js)) has the last
   full-suite measurement per repository with the commit it measured. When that
   commit is not the one about to ship, the line says so plainly and the verb
   still asks — it is a reading a person weighs, not a gate.
5. **The question**, at a terminal: `deploy <short sha> to production? [y/N]`.
   Anything but `y`/`yes` ends it.
6. **The lease.** `claimLease({ repoPath, errand: 'deploy <sha>', … })`
   ([`src/mc/repo-lease.js`](../../src/mc/repo-lease.js)), held for the whole
   deploy and released in a `finally` however it ends.
7. **The script.** `npm run deploy` in `~/memoro`, the process's environment
   passed through untouched, its output echoed as it happens.
8. **The row completed** — outcome, build, the live version the script verified,
   and the step it stopped at when it failed.

A real reading, run in this worktree on 2026-09-04:

```
mc: would deploy memoro e30fd83298dfe857ee7319c9ed66026c9416b723 — The whole-suite round is green in mc's own path, twice (#11349)
mc: live now b3e65b6 (build 23533) — api/version, 2026-09-04 10:03
mc: 21 commits would ship
mc: the nightly measured fc19465, 79 commits ago; this tree was not measured whole
mc: --dry-run — nothing was deployed
```

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
| **no TTY** | 2 | *"mc deploy asks before it deploys, and there is no terminal here to ask"* |
| the question answered `no` | 1 | *"nothing was deployed"* |
| the repository lease is held | 1 | names the holder and the errand, as `mc merge` does |
| the script ran | its own | whatever `npm run deploy` exited with |

The three of those that are decisions — `no`, no terminal, a held lease — are
each written to the record as `outcome: refused` with the reason. They are
deploys somebody meant to make, and the brief can only see them if they exist.

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
- **mc does not move memoro's checkout.** `deploy.mjs` refuses a dirty tree, a
  branch that is not `main`, and a `main` that is not `origin/main`, and the
  runbook (`docs/runbooks/deploy.md` § *What `npm run deploy` does*, step 2) says
  the script fast-forwards a clean `main` itself. `~/memoro` is Martin's
  checkout; what the verb adds before the question is only the reading.
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

**The reading half has been run for real**; the deploying half has not.
`mc deploy --dry-run` was run against `~/memoro` on 2026-09-04 (the output above,
and an earlier one at `c061d74`). Everything from the question onwards — the
lease, the spawn, the completed row — has only ever run against a faked script.
The one real deploy is Martin's to type, watched, and this note should say what
it did when it has happened.
