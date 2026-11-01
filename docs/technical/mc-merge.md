# mc test and mc merge — one measurement, two doors

A pull request lands through `mc merge <repo> <pr>`, and through nothing else.
It is measured by `mc test <repo> <pr>`, which is the same round stopping at the
verdict. There is one implementation: `mc merge` runs `mc test`'s round and then
lands what it cleared. A second implementation is the thing this arrangement
exists to prevent — two measurements drift, and the one that drifts is always
the one the merge trusted.

The verb has two forms, and which one runs is decided by what the pull request
touches:

- **the gate round** — lease, **one** worktree holding the pull request's head
  with main merged into it, the test files the change reaches run there, the
  command gates the same selection named run beside them, squash. This is what
  `mc repo merge` was; only the name moved.
- **`--docs`** — a pull request whose every file is under `docs/`, squash-merged
  after the repository selector's document tests and command gates pass. A script is not a document,
  under `docs/` or not: one is refused here and goes through the gate. The flag
  is not needed: `mc merge <repo> <pr>` reads GitHub's file list first
  (`prFiles`, `docsOnly` in [`src/mc/docs-merge.js`](../../src/mc/docs-merge.js)),
  and a pull request that passes the same rule lands this way, in the call,
  after one line saying so — it is never queued. A file list gh cannot read,
  `--check` or several pull requests go to the gate as before.

`mc repo merge` is gone rather than aliased: it prints *mc repo merge is now
mc merge* and exits 2, and it is in neither `mc repo`'s usage nor `mc --help`
([`src/mc/commands/repo.js:53`](../../src/mc/commands/repo.js)).

## Why the second form exists

A docs pull request is the deliverable of `mc plan` for a programme's documents,
and of the programme archive. It touches
only `docs/project/`, so the gate would build a worktree and run a suite to
learn nothing. Before `--docs` it did not even do that — it waited for Martin
to click Merge, and until it merged the runner could not see the plan at all,
because the runner then read plans from `origin/main`. Martin, 2026-08-26: *"inte
tillräckligt smidigt"*.

So `--docs` lets the session that opened the plan PR land it, seconds later,
itself. Merge authority is unchanged by this: docs-only-lands-directly is a
standing rule Martin gave, written once into the roles, and everything else is
still the gate.

## The grammar, in one place

Both forms parse through `parseMergeArgs`
([`src/mc/commands/repo.js:791`](../../src/mc/commands/repo.js)), exported so the
new door and the old pointer answer the same way about `#346` versus `346`, a
number that is not a number, and the same pull request named twice.

```
mc test  <repo> <pr> [<pr>...] [--json]            measure it; merge nothing
mc test  <repo> --full [--json]                    the whole suite, on the default branch
mc merge <repo> <pr> [<pr>...] [--check] [--json]   the same round, then squash
mc merge <repo> <pr> --docs [--json]                docs-only: the tests that read documents, then squash (also chosen without the flag)
mc merge <repo> <pr> --watch [--json]               queue it, then follow it to the answer
mc merge watch <repo> <pr> [--timeout <min>] [--json]   follow a job already queued
```

`--docs` with several pull requests is refused (it lands one at a time), and so
is `--docs --check` — there is no measurement to stop at. Both refusals happen
before `gh` is asked anything
([`src/mc/commands/merge.js`](../../src/mc/commands/merge.js)).

## The gate form

Unchanged, deliberately: `mc merge` calls the same `gate()` in `repo.js`, which
calls the same `runGate` and `runMergeRound`. The round, its lease, its one
throwaway worktree, the red names read out of it by name, the deploy pull and
the merge-log line are all described where they live —
[`src/mc/repo-merge.js`](../../src/mc/repo-merge.js),
[`src/mc/repo-gate.js`](../../src/mc/repo-gate.js) and
[`docs/mc-command-matrix.md`](../mc-command-matrix.md). There is still no flag
that merges a red gate. The squash is pinned with `--match-head-commit` to the head the round measured or freshened, once GitHub reports it (ruling 43).

**The lane** (ruling 61). Every repository has one merge lane, its own, named by
the repository (`gateLaneOf`, lock `gate-running-<repo>.json`, `gate-lock.js`).
Two rounds of one repository exclude each other; two repositories run side by
side. There is nothing to declare and no class of lane: `light` and `heavy`
were a claim about a suite's cost, and memoro-cli's went unmeasured from 60 s to
seventeen minutes. A deploy and an iOS build hold memoro's lane. A refusal and
the page name the lane they wait on.

## The door

Before the wait and before the gate, the door refuses a pull request GitHub
reports CONFLICTING, and one whose branch the caller's worktree holds at a head
origin does not have (ruling 43).

**The plan's last step lands only with its criteria met.** A plan is done when
every step is done and every success criterion is `met: true` (Martin,
2026-10-18), and the last step is where it becomes done. So
`criteriaDoor({ repoPath, pr, gh, step })` in
[`src/mc/merge-boundary.js`](../../src/mc/merge-boundary.js) reads the project's
plan under `~/mc/programs/` with the register's criteria laid over it, and
refuses the pull request of the plan's last step while a criterion there is not
`met: true`: `mc: unmet-criteria — <problem>` on stderr, exit 1, nothing queued.
`mc merge` records it in `gate-rounds.jsonl` with `stopped_at:
'unmet-criteria'`. It covers a docs-only pull request too, the usual close-out:
`mc merge --docs` (and a docs-only pull request routed there) asks
`criteriaDoor` before it merges, finding the step as `stepForMerge` does. The
runner's own queueing of a session's open pull request (`landForSession`) asks
it too, and a refusal there is the step's red, `ready` again with reason
`unmet-criteria — …`. A pull request that is nobody's step, or any step but the
last, passes; so does a project with no plan under `~/mc/programs/`. The door
fails open on anything it cannot read — `gh` or the plan failing to answer is
not a refusal. The session measures each criterion's `check` and records it
with `mc project criterion met`, or ends with `mc step failed` naming what it
could not measure.

**Known gap:** the door checks one pull request. `mc merge <repo> <pr1>
<pr2>` — a batch — does not run it; a batch is out of this step's scope, not a
believed-safe case.

**A branch flow lands once, at its review** (ruling 58, 2026-10-25). In a plan
whose last step is `kind: review`, `criteriaDoor` refuses the pull request of
any step before it with `stop: 'before-review'`: `mc: … step n is built on the
project's branch and does not land by itself`, on stderr, exit 1, nothing
queued. The step's pull request is the project's one, and the review's landing
is what lands it. The refusal is the same for `mc merge` and `mc merge --docs`.
Two paths book such a step `built` instead of asking the door: `mc publish` from
the step's own session (`publish.js`, `builtPatch`), which pushes, records
`built` with the head it pushed, and queues nothing; and the runner's queueing
of a session that ended `success` without publishing (`landForSession`).

The review's own pull request passes the door as the last step's does: every
criterion `met` in the register, or it is refused as `unmet-criteria`. Its
landing, from the merger's round, from the docs form or from `--admin`, books
every `built` step of the project `done` with the same landed sha and no body of
their own (`bookBuilt`, `merge-step.js`; the register's `built` is what names
them). A `built` step counts as done when the merger orders jobs (`stepsDone`,
`merge-queue.js`), so the review is not held behind the steps it lands.

### Watching a merge

Past the door the pull request is the merger's, and `mc merge` returns at once
(ruling 30). A session that wants the answer — a hand session, a close-out that
needs its predecessors on main, a session about to `mc deploy` what it landed —
asks for it (ruling 36):

```
mc merge watch <repo> <pr> [--timeout <min>] [--json]   follow a job that is queued
mc merge <repo> <pr> --watch [--json]                   queue it through the door, then the same
```

[`src/mc/merge-watch.js`](../../src/mc/merge-watch.js) is both. `watchState`
reads one job out of `merges.json` — queued with its place and the numbers
ahead of it, waiting for the parent it is stacked on, landing (with the other
jobs of the same batch, the entries sharing its `started`), red with
`markRed`'s reason, or gone — and `watch` prints one line each time that state
changes and nothing in between. The exit code is the answer:

| code | outcome |
|---|---|
| 0 | merged — the last line names the merge commit |
| 1 | red — the reason the merger recorded |
| 2 | usage, or a pull request neither in the queue nor merged (open, closed, unknown) |
| 3 | `--timeout` elapsed (30 minutes by default); the job stays in the queue |
| 4 | no merger alive for two polls while the job waits; the job stays in the queue |

`--json` prints no lines and one object at the end: `{ repo, pr, outcome,
merge_commit, reason, place, seconds }`. With `--watch` the queueing's own
lines come first, and with `--watch --json` the queueing says nothing, so the
watch's object is the only output.

**Opt-in and read-only.** Nothing starts a watch, and the step-session prompt
does not mention it: a step session queues and ends, because the next step
stacks on top. The watch never writes `merges.json`, the register or
`merger.json`, never starts a merger and never cancels or re-queues a job — a
3 or a 4 leaves everything where it was. `--watch` is refused with `--docs`
(it lands in the call; there is nothing to watch), with `--check`, with several
numbers (one call per pull request), and by `mc test`. A queueing that is refused at
the door — an unmet criterion, say — is returned as it is, with no watch.

**GitHub is asked once.** The queue is a local file, read every
`WATCH_POLL_MS` (10 s) for nothing. A job that leaves the queue has either
landed or been dropped, and only GitHub knows which, so `gh pr view --json
state,mergeCommit` is asked then — once, at the end — or at once for a pull
request that was never queued. There are no GitHub calls in the loop.

**In a Claude session**, run it with Bash's `run_in_background`: the session is
woken when the command exits, reads the few lines and the exit code, and spends
nothing on a queue that has not moved while it waits.

## The docs form

[`src/mc/docs-merge.js`](../../src/mc/docs-merge.js), about eighty lines, is the
whole of it. It takes a repository path and a number and:

1. reads the pull request with `gh pr view --json number,title,state,isDraft,baseRefName,files,headRefOid`, the head beside the file list; a pull request with no head is refused as `read`;
2. refuses a pull request that is not `OPEN`, a draft, one that changes no
   files, and one whose file list holds **any** path outside `docs/` — naming
   that first path, so the reader knows what to do instead;
   and one whose file list holds a script — any path ending `.js`, `.mjs`,
   `.cjs` or `.ts`, in any directory — naming that first script and saying to
   land it through the gate (`mc merge <repo> <pr>`): a script under `docs/` is
   not a document, because a tree-wide check in the repository's gate reads it
   and this form runs no gate (memoro #12534 landed an instrument `.mjs` this
   way on 2026-10-04 and turned `main` red); and one that adds a line to a repository plan file
   (`isRepoPlanPath`), stopped as `plan`: plans live under `~/mc/programs/` and no
   repository holds one any more (ruling 48);
3. waits for GitHub's mergeability, up to twelve five-second turns, because
   `UNKNOWN` for a few seconds after a push is normal and merging then fails for
   no real reason; `CONFLICTING` is a refusal that says which base to merge in;
   then it reads the head again, and a head that moved since step 1 is `drift`:
   not merged, because the files checked are not the files that would land;
4. measures the documents before anything is squashed. It builds a candidate of
   the head with `origin/<base>` merged in, under `<work root>/gate/<repo>/docs-<n>`,
   prepares it as a round does, asks the repository's selector (`selectFiles`,
   the gate round's own) which tests read the files, runs those files and the
   command gates it names, and refuses on any red: `red`, with the names. A
   measurement that could not run is `measure-<stage>` — `measure-candidate`,
   `measure-merge`, `measure-prepare`, `measure-selection` or `measure-suite` —
   and is not merged either. The head is read again after the tests, and a head
   that moved is `drift`, as above. The code is
   [`src/mc/docs-measure.js`](../../src/mc/docs-measure.js);
5. squash-merges with subject `<title> (#<n>)`, pinned with `--match-head-commit`
   to the head it checked, so the squash lands that head and no other (ruling 43);
6. reads the state back and refuses to claim a merge it cannot see — a `gh` call
   that returned an error after the merge had in fact happened is `merge-unknown`,
   not a silent success;
7. prints one line: what merged, into what, as which commit, how many files
   under `docs/` it was, and how many test files were green in how many seconds.

**Why it measures.** Four documents-only landings turned memoro's `main` red
between 2026-10-20 and 2026-10-24 (#13980, #13995, #14138, #14188):
`tests/docs/doc-links.test.js` found dead relative links that a document it had
not read introduced, and this form ran no test at all. The selector draws eight
files for #14188's paths, and `doc-links.test.js` is red on its commit, so the
measurement in point 4 refuses that landing instead of letting `main` go red.

**The file list comes from GitHub, never from a local diff.** A stale checkout
must not be able to make a code pull request look like documentation, and the
one thing this form must never do is land a file the suite would have had an
opinion about.

The docs measurement reserves the repository's gate lane before creating or
preparing its candidate and releases it after cleanup, including on failure.
It uses one worktree and the selector's files and commands, with no model or
deploy pull. Raw test and command output survives candidate cleanup under
`~/.memoro/mc/gate-output/`. A failed result names the log, failing files,
assertion locations and a focused rerun command; JSON retains the details.

It does leave a line in the round log
([`src/mc/repo-round-log.js`](../../src/mc/repo-round-log.js)) with `mode: docs`,
alongside `merge` and `check`. Every round mc runs is countable, including the
ones that did not run a suite.

## The admin form

`mc merge <repo> <pr> --admin` lands one pull request past the gate. It is
Martin's alone: a session runs it only when he tells it to, and no other form
of the verb changes for it. [`runAdmin`](../../src/mc/commands/merge.js) does,
in order:

1. reads the pull request with `gh pr view --json number,title,state,headRefOid,headRefName,baseRefName,body,mergeCommit`. Unreadable is refused; a closed one is refused as nothing to land; a merged one is booked without a merge call;
2. squash-merges an open one with `gh pr merge --squash --admin --subject "<title> (#<n>)" --match-head-commit <head>`: GitHub's admin override, pinned to the head it read. No round is formed: no candidate, no suite, no gate;
3. reads the state back. Anything but `MERGED` is `NOT merged`, with the last line of gh's error, exit 1, and nothing booked;
4. takes its queue entry out under the register's lock. An entry the merger is landing (`landing`) is left as it is, for the merger;
5. books the step — the entry's own, else the one the pull request's branch stands on — `done`, with its landing, unless the step is already `done` or `blocked`;
6. drops the pull request from the page's cached list. A page that cannot be written costs nothing;
7. writes one round-log line with `mode: admin`;
8. prints what landed, into what, as which commit, and the step it booked. `--json` gives the same as one object. Exit 0.

It never stops a round itself. A round in flight on the pull request is the
merger's to stop: its watch (`watchSubject` in
[`src/mc/merger.js`](../../src/mc/merger.js)) notices within a minute that the
pull request is merged, and answers its `landing` entry as landed. So `--admin`
leaves a `landing` entry to that watch and does not touch the round.

It is refused with several pull requests, with `--check` (it lands; a check
only measures), with `--docs`, and with `--watch` (it lands in the call, so
there is nothing to watch).

**Why it exists.** Six raw `gh pr merge --squash --admin` calls between
2026-10-17 and 2026-10-24 left the merger's round for each pull request
running, and nothing was booked until the merger noticed. The verb does the
merge and the booking together, and the merger's watch does the rest.

## The three places that say it

A role is not the last word a session hears, which is what step 2 of this
project cost a session to learn. All three now end with the merge:

- `canon/roles/plan.md` — *when the PR is open, land it yourself*;
- `planLaunch()` in [`src/mc/commands/plan.js`](../../src/mc/commands/plan.js) —
  `mc plan` builds its own first prompt, and that prompt used to end with "open
  a PR … and stop", which is the most recent instruction a session reads and
  contradicted the role two screens above it. It now ends with the merge, and
  names the repository so `<repo>` is filled in rather than guessed;
- the triage prompt in `~/mc/bin/runner.sh`, which is not in this repository and
  no test can reach; the repository's half is locked by assertions on the role
  overlay and on `planLaunch()`'s last line.

## What it has done

Six `mode: docs` rounds in `~/.memoro/mc/gate-rounds.jsonl` between 2026-08-28
23:04Z and 2026-08-29 07:44Z: memoro-cli #419, #420, #428, #429 and memoro
#11025, #11039. All six merged, none refused, 4.8–6.1 s each. None was clicked.
One of them was the runner's own: the `canonical-response` triage on 2026-08-29
opened memoro #11039 and landed it in the same session
(`~/mc/runner/log/canonical-response-20260829T033139Z.json`). The same log holds
131 `merge` rounds and 10 `check` rounds — the gate is still where code goes.

## Known defect — the round does not converge under concurrent landings

Measured 2026-08-29 in memoro, four sessions merging — before the baseline
side was removed, so the window is roughly half that now and the shape of the
defect is unchanged. The gate round measures a candidate for 20–35 minutes and
then, before merging, requires
that `origin/main` is still the commit it fetched (`repo-merge.js`,
"origin/main moved … measured again rather than merged on"). Any landing
from another session during the round voids the verdict. With several
sessions landing, main moves every round: memoro #11096 was green twice
(candidate 0 red, extra gate passed) and stopped both times for main
moving; then "could not re-check the base"; then the lease was held by a
session that was itself re-running its own round for the same reason. Two
sessions re-measuring against each other's landings is a livelock, and a
retry loop around it only hides the defect.

What the operator does meanwhile is written in memoro's `AGENTS.md`
(§ *When the gate stops a green pull request for a reason that is not the
PR's*): investigate briefly, report, `gh pr merge --squash --admin`. No
loop.

What the gate should do instead — not built: when main has moved, compare
the moved range against the candidate's change set and the tests the round
ran; if the range touches neither, the verdict still holds and the merge
proceeds (a fast-forward re-check, seconds), and only an overlap costs a
new round. The lease should likewise be released between the measurement
and the merge attempt rather than held for the whole round.

## How it is tested

[`tests/mc/docs-merge.test.js`](../../tests/mc/docs-merge.test.js) drives
`runDocsMerge` against a stubbed `gh`: a docs-only pull request merges with the
right squash subject and the merge commit read back; one file outside `docs/` is
refused by name before any merge is attempted; a draft, a closed one and a
conflicting one are each refused; a red measurement, one that cannot run, and a
head that moves during the tests are refused before any merge too. Then the verb itself: `--docs` with a batch and
with `--check` refused before `gh` is asked, the round run on the resolved
repository, and `mc repo merge` pointing at `mc merge` while `mc --help` no
longer mentions it. The gate form's argument errors live with the gate, in
[`tests/mc/repo-merge.test.js`](../../tests/mc/repo-merge.test.js) and
[`tests/mc/repo-gate.test.js`](../../tests/mc/repo-gate.test.js).

## Where the candidate's dependencies come from

The candidate is a fresh worktree with no `node_modules` in it, and a suite run
where the declared packages cannot be resolved does not fail — it runs the
tests that happen to need nothing and prints a number with the right shape
(D-0152: 2162 tests and 30 failures, where 206 tests never ran and were not
counted as skipped; 2368 of 2368 once the tree was linked). A number from such
a run is not low, it is invalid, and nothing about the number says so.

**So the candidate stands where the tree already is.** It is built at
`<work root>/gate/<repo>/candidate` — `WORK_GATE` beside `WORK_DEPS` in
[`src/mc/paths.js`](../../src/mc/paths.js) — which puts `~/mc/node_modules` two
parents above it, found by node's own walk up the directory chain. That is the
same one tree every workarea resolves through, described in
[`mc-work.md`](mc-work.md) § *Where a workarea's dependencies come from*: one
copy for the workareas and the rounds together, no `npm ci` in the round, and
nothing inside the checkout for git or the selector to trip over. The gate
directory used to live under `mcHome()`, and moving it is the whole of that
half. The round calls the same `ensureWorkDeps` on the **candidate** rather
than on the repository's checkout, so a pull request that changes
`package-lock.json` is measured against a tree installed from *its* lockfile;
the shared tree then stands at that lockfile until the next workarea or round
moves it, which is the one-tree-one-lockfile trade the work root already makes,
said out loud.

**And the round measures the resolution instead of believing a declaration.**
After the prepare step and before the suite, `dependencyTree(candidate)` asks
whether every declared name resolves from the worktree or any directory above
it; one that does not stops the round by name. There is no vouching branch left.
memoro-cli's entry used to read `prepare: null` with a `prepare_why` saying the
suite was *"node:test over source only; verified across every gate round since
the verb existed"* — and it was false for months, while the five test files
under `src/runtime/session-host/` went unrun and uncounted every round and the
round printed a line about the missing `node_modules` once per round, read as
reassurance. `prepare` says what the *round* must run; whether the suite can run
at all is now measured. `tests/mc/repo-gate-table.test.js` reads the entry
against `package.json` and allows `prepare: null` beside declared dependencies
only while both halves of the mechanism are in place — the repository on
`SHARED_TREE_REPOS`, and the gate root under the work root.

Measured 2026-09-03 on the round for #570: the selected round was 73 files,
952 tests, 0 red in 39 s, and `--full` on the same candidate 143 files, 1538
tests, 0 red in 74.5 s. Neither ran a prepare step, and neither printed the
`no node_modules` line.

**A repository that prepares with `npm ci` gets it from a cache when the
lockfile matches** (merge-throughput, ruling 34;
[`src/mc/prepare-cache.js`](../../src/mc/prepare-cache.js)). memoro declares
`prepare: 'npm ci'`, which took 15 s at the median and 26 s mean over 80
rounds on 2026-10-09/10, 332 s at the worst, and most rounds install the
lockfile the round before installed. After a green `npm ci` the round stores
the candidate's `node_modules` under
`<work root>/gate-cache/<repo slug>/<key>/` (`WORK_GATE_CACHE`), where the key
is the first 16 hex of sha256 over the candidate's `package-lock.json`, the
install-affecting fields of its `package.json` (`INSTALL_FIELDS`: the four
dependency maps, `overrides`, `engines`, `workspaces`, `packageManager`,
`bundleDependencies`), node's major version and module ABI, and the platform
and architecture. (Until 2026-10-18 the whole manifest and the full node
version were hashed, so a version bump or a node patch release was a miss.) A candidate with the same key gets a
clone of the stored tree — `cp -cR`, APFS clonefile, blocks shared until
written — no prepare shell, and the line `prepare: cloned node_modules from
the cache (<key>)`; the time stays under the round's `prepare` timing. Any
other key is a miss and runs `npm ci` as before. The cache is used only for
`npm ci`, on darwin, and for a `package.json` without a `preinstall`,
`install`, `postinstall` or `prepare` script (with one, `npm ci` may write
outside `node_modules`, and scripts are not in the key). A key
that cannot be read, a clone that fails or a store that fails is said and
becomes the `npm ci` it replaced; the cache never stops a round. At most
`PREPARE_CACHE_KEEP` (4) entries are kept per repository, oldest evicted. It
was 2, one for main's lockfile and one for a pull request that changed it,
and a second lockfile-changing pull request evicted main's. memoro's tree is
about 500 MB as a copy, but clones share blocks until written.
Measured at close-out (74 memoro rounds, 2026-10-10 18:01 – 2026-10-11 08:11
UTC): 72 hits at 6.8 s median (7.4 s mean), 2 misses at 22.7 s median.

## What the round measures

Not "the suite", necessarily. A repository may declare `select` in the gate
table ([`src/mc/repo-gate-table.js`](../../src/mc/repo-gate-table.js)): a command
printing JSON with a `files` array, run in the candidate worktree. With one, the
round measures the test files the change reaches; without one, the whole suite,
exactly as it always did.

**A suite finds the toolchain's git first** (`directGitDir` in
[`src/mc/repo-gate.js`](../../src/mc/repo-gate.js)). macOS's `/usr/bin/git` is a
shim that asks xcrun on every call, 67 ms against 23 ms for the git behind it
(2026-11-01), and memoro-cli's autonomy tests make about 400 calls each. `suiteEnv`
puts `$MC_HOME/direct-git`, a directory holding one link, first on the suite's
PATH. Off macOS, or when no link can be made, PATH is unchanged.

**A merge round runs at least four lanes.** `realTests` passes
`--test-concurrency=<testLanes()>` — unless the repository's own flags already
name a concurrency. A session's `mc gate` takes the free cores,
`cores - 1 - round(loadavg()[0])`, between 2 and `cores - 1`. A merge, check or
full round takes `max(4, the free cores)`, never above `cores - 1`
(`MERGE_LANES_MIN`), because the free cores were two all day: with four step
sessions the load sits at 10–16 on eight cores, and at two lanes the standard
batch took 178 s at the median (p90 377 s) over 159 suite runs from 2026-10-20 to
24. The floor is four and not seven because seven lanes beside the sessions are
what went red under load on 2026-10-19; the sessions' load cannot take the round's
lanes away, and the reds-under-load requeue (`markRequeued`) stays underneath it.
A whole-suite round hands the same count to its own runner as `MC_TEST_LANES`,
which still overrides all of it. The round record names the `lanes` and the
`load` it ran at, so a round's speed is read against the lanes it had. And the
selector's `resourceClasses` are honoured (`testBatches`): a file classed `sqlite`
or `heavy` runs after the standard batch, each class in its own `node --test`,
`sqlite` at the round's lanes and `heavy` one file at a time (sqlite since
2026-10-24: its files share nothing; 646 files green at four lanes, 247–300 s
against 770 s at one) — as memoro's own runner runs them — and the batches' TAP
is read as one run. A session's
`mc gate` takes no lane and waits for nobody (ruling 61): its detached worker
starts at once at low priority beside any merge round, and only a deploy or an
iOS build of memoro goes first (`await-deploy.js`). A session's gate uses affected selection or explicitly named files, with
resource-class batching, bounded concurrency and timeouts. Completed local
measurements now leave [immutable evidence](mc-gate-evidence.md): exact content,
frozen base and check scope. Only complete, unchanged, unfiltered affected
selections populate the existing green cache; named runs remain limited.

**A session's gate leaves what costs too much to the merge round.** Every run
records each test file's measured seconds in `~/mc/test-times/<repo>.json`
(`test-times.js`, a second reporter beside TAP; half the new measurement, half
the old). An unnamed `mc gate` runs the test files the change touches, then the
others cheapest first while the estimate fits 180 s, and names the rest as left
to the merge round, which runs them all. Its coverage is then `partial`, which
is never reusable evidence, and the green says what it does not cover. Named
files and a goal's measured gate (`measurementBinding`, `wholeSelection`) defer
nothing, and neither does a repository that declares `session_whole`
(memoro-cli, whose whole suite took 128 s in a session's gate on 2026-11-01).

**A suite runs in its own environment, and for at most an hour.** The round
hands a suite the caller's environment without `NODE_TEST_CONTEXT`,
`MC_WORK_ROOT` and `MC_HOME` (`suiteEnv` in `src/mc/repo-gate.js`): the last two
are the runner's real `~/mc`, and `tests/_isolate-home.mjs` replaces them only
when they are unset, so memoro-cli's runner tests once read the real programmes
and one of them waited for a STOP it never wrote. A suite, a selected run, or a
file measured alone that is still running after `MC_GATE_SUITE_MINUTES` (default
60) is killed with its process group, and the round stops with `ran past N min
and was stopped — a test that never ends` instead of holding the lane. Before
2026-10-19 nothing bounded it, and memoro-cli #1009 held the light lane for
hours with no line in the log.

**One tree, and the verdict is its own red.** Ruled by Martin on 2026-08-31: a
round evaluates the diff, and whether main was already red is not the round's
question. Until then the round built a second worktree at the base, ran the same
file list there, and called the difference the verdict — half the wall clock, a
second `npm ci` and four modules of machinery (`repo-baseline-cache.js`,
`compareRed`, the red ratchet) to answer a question a merge does not ask. All of
it is gone.

**Main's red is main's** (ruling 44 § 4). From 2026-08-31 a test the change
reached that was already red on main made the round red: four SQL snapshot
tests red on main were measured red in 77 rounds of 43 PRs, about 700 minutes in
all charged to changes that had not caused them. Now, when every red file a
round is left with is `red_on_main` by the base probe (below) and the change's
own diff against the base — a batch's is the union of its PRs' — touches none of
them, the round is not red on them: it puts the candidate back at its head, sets
`main_red_files`, says `N red file(s) red on main too, untouched by this change —
not this round's red`, and goes on to the command gates and the PR's own tests as
a green suite would. A green verdict's headline then ends `— N test file(s) red
on main, not counted`, and each such file gets an intake note
(`~/mc/intake/<date>-red-on-main-<name>.md`: repo, file, red names, the landing
the probe blamed, the PR whose round found it) unless a file at the top of
`~/mc/intake/` or `~/mc/proposals/` younger than seven days already names it
(`noteRedOnMain` in [`src/mc/repo-gate.js`](../../src/mc/repo-gate.js)). One red
file the change touches, any red the probe does not call main's, or a diff that
cannot be read, and the round is red as before.

**A declared timing test gets one more run** (ruling 44 § 5). Since 2026-10-07
memoro's JSC start-up budget, `sql:pr-ci`, dead-CSS and build-bundle went red
and then green with no change, and neither `file-killed` nor `red-under-load`
caught them. A declaration's `retry_once` names such test files and selected
command gates (`{ "files": […], "gates": […] }`, shipped for memoro in
[`src/mc/repo-gate-table.js`](../../src/mc/repo-gate-table.js), overridable in
`.mc/test.json` like any field). After the killed and cancelled files are taken
out and before the base probe, a red whose every file is in `files` is run once
more alone on the candidate: green, and the round sets `flipped: { files, names
}`, says `green alone — … flipped under load`, and goes on as a green suite
would; still red, the files that stayed red go to the probe as today, and that
run counts as their sample alone on the candidate. Likewise a round whose every
failed selected command gate is in `gates` runs those once more after the suite;
all green sets `flipped.gates` and goes on, any still failing is `selected-gate`
as today. A red outside the lists is red as before. Every flip is in the round's
line in `gate-rounds.jsonl`. No quarantine: nothing is skipped, and a file that
flips often is a proposal to fix it, not a longer list.

**A command gate that needs Docker gets the runtime first.** A selected command
gate whose selector entry carries `needs: ["docker"]` gets `mc docker ensure`'s
work before it runs: the runtime is started if it is down, and the round takes
a lease with its own pid as the holder. The gate runs with `MC_DOCKER_HOLDER`
(that pid), `MC_DOCKER_RUN` (`<mode> #<pr>`, such as `merge #7`) and
`MC_DOCKER_REPO` (the repository's name) in its environment, so what it starts
can be labelled for the sweep. The lease is released when the gate ends. If the
runtime cannot be started, the gate does not run: it is `unavailable` when it
declared `allowUnavailable`, and red otherwise, with the reason in its
`output`. The field is read from the selector, not from the declaration, because
the operator's `repo-gates.json` replaces the whole entry. A gate without `needs`
is run exactly as before.

An empty selection stops the round: it is not a measurement, and a green from it
would be the most confident kind of nothing.

**A green `mc gate` on the same tree is not measured again** (rulings 44 and
47). Completed full, unfiltered affected gates now write durable
[receipts](mc-gate-evidence.md) and populate `gate-greens.jsonl`
([`src/mc/gate-greens.js`](../../src/mc/gate-greens.js)). A round can reuse exactly
by tree, selection hash and measurement version, or use the PR head's receipt
and ask the repository's dependency-aware selector what main's movement reaches.
Missing or incompatible evidence means measuring the relevant selection. Named
or filtered runs never enter this full-selection cache. Receipt-bound autonomous
callers additionally require the matching repository/run/revision and current
gate configuration; legacy v1 callers retain their existing admission path.
Required merge gates and the PR's own tests still run. `reused` in the round log
records the evidence taken, not a new measurement.

**`mc gate` selects from code changes** ([`src/mc/commands/gate.js`](../../src/mc/commands/gate.js)).
With no files named, the repository selector receives all paths changed against
the merge base, including staged, unstaged and untracked paths and both sides
of renames. Newly
added test files are included even before staging. Named files use the same
bounded test runner and the selector's resource classes. There is no 30-file
limit; `--full` remains refused. No changes is `NOTHING CHANGED`; a changed
branch with no selected checks is not green. The merge still measures its
candidate with the current base; local results do not bypass it.

The detached worker owns the test subprocesses. An interrupt stops its active
test group. Unique log names
prevent simultaneous worktrees from sharing output; the full output and
structured failures remain available through `mc gate --wait` and `--json`.
Budget expiry is `RUNNING` (exit 3), never green evidence: waiting again observes
the same worker without starting tests. A dead worker
without an exit marker is red. Completed immutable receipts survive command
exit and can be rediscovered by run ID even if a crash prevented updating the
reuse cache; missing evidence falls back to measurement. The
[receipt recovery and coverage contract](mc-gate-evidence.md#waiting-and-recovery)
defines the future autonomous consumer boundary, not a new v1 publication or
merge permission.

**Reservation is atomic.** Each lane uses a prepared nonempty claim directory
published by rename, plus the existing JSON status file for readers and older
running mc versions. A second claimant cannot replace a live claim. A dead
owner is reclaimed by removing only its generation's marker and then the empty
directory; an old cleanup cannot remove a successor's claim. A failed
reservation stops the operation. During rollout, let already-running old
workers finish: old code cannot enforce the new reservation protocol.

**The command gates the selection names run beside the suite** (merge-throughput,
ruling 34). Until then they ran after it: 65 s mean on top of every round that
had any on 2026-10-09/10, `sql:pr-ci` alone 36 s at the median over 55 rounds.
Now `runGate` starts them when the suite starts and awaits both halves
(`Promise.allSettled`); the round's `timings.gates_beside_suite_ms` is the wall
time of the two together. They still run one at a time and in the selector's
order, not all at once — this is an 8 GB machine already running the suite's
lanes, and memory pressure was measured stretching rounds on 2026-10-10
(`kern.memorystatus_level` 30, swap 2.4 of 3 GB): one gate beside the suite is
one process more, six would be six. They run through `commandShell`, an
asynchronous spawn, because a `spawnSync` would stop the round reading the
suite's pipes and "beside" would become "after" again. The verdict is what it
was sequentially: every gate runs and is judged and is reported in
`extra_gates` in the selector's order; a failed gate beside a green suite is
`selected-gate` with every failure named; a suite that could not be measured
is the suite's stop, with the gates that ran listed; and a half that throws is
waited out with the other and then thrown, so nothing turns green because one
half threw. A round red in its tests names its failed gates in the same reason, and the mend prompt lists each with its last output, because the mend gets one try (memoro #14169, 2026-10-24). Measured at close-out over 60 memoro rounds (2026-10-10 18:01 –
2026-10-11 07:19 UTC): within a round the two together took 320 s mean where
suite plus gates add up to 546 s, so the overlap saves 226 s a round — but
beside the suite the gates are slower, 161 s at the median against 36 s when
they ran alone on 2026-10-09/10, and the suite itself 179 s against 91 s (it
also selects more files now, see batches in [`mc-run.md`](mc-run.md)
§ *The merge*). The wall time of suite and gates was 236 s at the median
against 155 s for the same pair run one after the other before.

**`mc test <repo> --full`** is the other reading, and the only one that is about
the code rather than about a change: the repository's declared suite command,
run once on the default branch as `origin` fetched it, reporting its red names.
It is asked for, never scheduled. Measured 2026-08-31 on memoro-cli at `8a34a0d`
— 2468 tests, 23 failures, 28 red names, 107.4 s. Every round used to compute
that on the way past and report it as `standing_red`, which is how it came to be
believed and never checked.

*Declared*, since 2026-09-02, and it was not before. `--full` read the suite off
`package.json` — `npm test`, verbatim — on the argument that mc must not keep a
second definition of somebody else's suite. The argument holds; the assumption
under it did not. memoro's `npm test` is `node scripts/testing/ci.mjs`, a
diff-selector, and a `--full` round has no pull request: it checked out
`origin/main` detached and diffed it against itself. 0 changed paths, 6 selected
files, reported as the whole suite. Measured at `58db0f5`, the same tree gives 6
files from `npm test` and 2,021 from `npm run test:full`.

So the gate table carries `suite` and `suite_why` beside `select`, through the
same three layers, and one rule closes the guess: **a declaration with `select`
and no `suite` may not answer a `--full`.** It stops, naming both fields — a
repository that declared a selector has already said that its `npm test`
narrows, so there is nothing honest left to fall back to. A repository with no
`select` keeps `npm test` and needs no declaration. Measured after the change:
`mc test memoro --full` is 17,982 tests in 288.3 s, six failures, eight red
names; `mc test memoro-cli --full` is the same 2,440 tests and the same 47 red
names it was before, byte for byte.

A whole-suite round records which command produced it — `full_suite` in `--json`
and on the `--full` clause of the verdict — because "it was full" and "this is
what full means here" stopped being the same claim, and the round that ran six
files said `full: true` while it did it.

**And the commands the same selection named.** memoro's selector reports a
`commands` array beside `files` — `css:lint`, `css:tokens`, `i18n:contract` and
their kind — and until 2026-08-31 the round read the files and dropped them, so
no gate round had ever run one. They run now, on the **candidate only**: these
are contracts about the diff rather than measurements of a tree, and several of
them take `--base-ref` and are differential in themselves, so a baseline run
would measure main against main. Every one runs even after another fails, and
one that fails makes the round red. Measured on memoro #11185 (2026-08-31), a
css-only diff: `css:lint` 15.1 s, `css:tokens` 1.6 s — against 7 s a side for
its tests, because `css:lint` is stylelint over the whole of `public/css/**` and
does not shrink when the selection does.

### What the second side cost, while it existed

Measured on memoro #11104 (2026-08-30), landing two markdown files and a test —
the last shape of the round before the baseline was removed:

| step | time |
|---|---:|
| `npm ci`, both sides | 15 s |
| suite, baseline | 649 s |
| suite, candidate | 224 s |
| extra gate `msr contract`, candidate | 194 s |

The baseline row is the one that is gone. That extra gate globbed exactly the
profile the suite already ran, so the contract suite was bought four times in
one round. The same round also reported `2477 + 9 + 39` tests as **"39 tests"**,
because the suite runs in three processes and `tapTotals` kept the last summary
it saw.

Both are fixed: the totals are summed, and memoro declares `select`. A
documentation diff there selects 6 files where it selected 332.

## What the round says

Three lines when it is green, and ruled that way by Martin on 2026-08-31: *do
not hand the session information it has to take a position on.* It costs tokens
and turns a yes/no into a judgement call.

```
mc: memoro #11185 (css-fix) → main — GREEN — the test gate passes
mc: ran 17 test files (1876 tests) and 2 command gates on a1b2c3d (the head with main merged in)
mc: 54s — --json for timings, gate output and the file list
```

Red is what failed, and nothing else:

```
mc: memoro-cli #503 (step3) → main — RED — 1 test red, 1 command gate failed:
      readPackageCanon › reads all three packaged canon files from the real package
      i18n:contract — exit 3 — npm run i18n:contract
mc: 54s — --json for timings, gate output and the file list
```

The counts are the reach, and they are what ruling 4's second condition asked
for. They replaced the sentence that used to carry it — *"measured over the 17
test files this change reaches, not the whole suite"* — because the number says
it and the prose was the part a reader had to weigh.

One clause survives on the headline, and only because it changes what to do
with the verdict: when the repository's selector could not narrow the change and
fell back to everything, the round says *"over the whole suite: the selector
could not narrow this change"*. The selector's blindness count went with the
rest — it is a fact about the selector, not about this change.

Everything cut is behind `--json`, which every round already accepts: per-phase
timings, each gate's duration and output, the pull request's own tests, what the
round prepared with, the passing gates. Two lines went that were there on
purpose and are worth naming — *"it says nothing about whether the change is
right"*, which was the guard against reading a green as an approval (the
headline still never says approved), and *"this run was asked to check only"*,
which was true of `mc test`, whose name says it. A merge round still says
plainly that nothing was merged.

### The base probe: whose red it is

A red round runs its red files once more on the base
([`src/mc/selector-miss.js`](../../src/mc/selector-miss.js)). Green there, and
the change broke them. Red there too, and the files are walked back along
`main`'s first parents to the first commit where they pass; the landing after it
is recorded, with the paths it changed (`git diff-tree --name-only`), and the red
reason says `— N of the red files are red on main too, broken by #M`. The walk
only names the landing; whether the round goes on is decided by `red_on_main`
and the change's diff (*Main's red is main's*, above).

A landing whose every path is under `docs/` is measured again before it is
named (`remeasure`). Both ways have happened. On 2026-10-06 (`mc merge memoro
12720`) the walk blamed memoro #12727, six files under `docs/project/staff/`,
for a wall-clock budget test that was red under load at both commits and green
alone — the walk had found where a flaky test happened to pass. On 2026-10-10
it reached #13310, an archive that deleted skill texts a test reads, and ruling
docs-only out by path (the rule from 10-06 to 10-10) left that red unexplained.
So the red file is run once more at the landing and once more at its parent:
red at the landing and green at the parent, both times, is the landing's —
`kind: 'docs-only-landing'`, written to `selector-misses.jsonl` and counted on
the page as a miss beside `not-selected`, and the reason says `— N of the red
files are red on main too, broken by #M (#M changed only docs/ and landed
without the suite)`. Anything else is `flaky`: it names nobody, is not
recorded, is left in the probe's `unresolved`, and the reason ends `— N flaky
under load`. A landing whose paths could not be read is named as before,
without the second measure.

**A file killed from outside the round is no verdict** (ruling 38, since
deleted). When something outside the round ends a test file's process,
`node --test` writes one failing entry for that file with `signal: 'SIGTERM'`
(or another signal) and `exitCode: ~` in its TAP block. `killedFiles(tap,
files)` in [`src/mc/tap-red.js`](../../src/mc/tap-red.js) names every file
whose failing block has a non-null `signal:`. Before the base probe,
`runGate` takes those files' red names out of the red set: when nothing is
left the round stops `stopped_at: 'file-killed'`, `<files> ended by <signal>
from outside the round — not a verdict on this change`, and the base probe
does not run — the base would pass the file and the probe would say the change
broke it, which is what memoro #13337 was told on 2026-10-10 after a session's
`kill 75754`. With other reds beside it the round is `red` over those alone,
and `report.killed_files` lists the killed ones; they are never counted green.
The merger (`landJob`) runs a round that stopped `file-killed` once more,
saying `<files> was killed from outside the round — measuring again`. A second
`file-killed` is answered red with that reason. It is not a mend stop: there is
nothing in the change to mend.

**A red that passes alone is measured again** (`red-under-load`). When the
base probe finds every red file green on the base, `runGate` runs the same
files alone on the candidate head (`redAt` in
[`src/mc/selector-miss.js`](../../src/mc/selector-miss.js), with the round's
own runner and flags). Red there, and the round is `red` as before, with the
line `red alone on the candidate too — this change broke them`. Green there
too, and the files count green (Martin, 2026-10-19): with at most three of them
(`GREEN_ALONE_MAX`) the round goes on as for a `retry_once` flip, saying
`counted green — <files> passed alone on the base and the candidate`, with
`report.green_alone` (`{ files, names }`, also on the round's line) and
`report.under_load_files` naming them; a genuinely order-dependent test is the
nightly full run's to catch. With more than three, the round stops
`stopped_at: 'red-under-load'`, `<files> red in the round, green alone on the
base and on the candidate — measured again`. A red file whose own entries are
cancelled tests and none failed (`cancelledFiles` in `tap-red.js`: a `before`
hook that ran out of time, as memoro's `build-bundle.test.js` on #13470) is
taken out of the red without any re-run, as if it had passed alone; with
nothing else red the round is `red-under-load`. A file with a failed test stays
red whatever else it has. The merger runs a `red-under-load` round once more,
saying `<files> red only under load — measuring again`. A second one — and a
second `file-killed` — is put back in line rather than answered
(`REQUEUE_STOPS`, `mayRequeue` in `merger.js`): the entry is `queued` again with
its place kept, `requeues` one higher and `not_before` fifteen minutes on
(`markRequeued`, `merge-queue.js`), the step stays `landing`, no attempt is
counted and no session is started — the merger says `back in line in 15 min
(requeue n of 2), no session started`. After two requeues it is answered red
with its reason and `red under load in two rounds running`, as before. Until
2026-10-19 the second one was answered red at once, the step went back to
`ready`, and the runner started a session to fix the pull request that found
nothing to fix (note-steps #13897 paid two). It is never counted green, and it
is not a mend stop. Its failures are kept under
`runner/merge-red/<repo>-<pr>-<stop>-<time>.txt` (`loadRedPath`), which a
landing does not remove, and the round's line in `gate-rounds.jsonl` carries
`under_load_files`, `head_alone`, `killed_files` and `cancelled_files`.

**A test that never ends is a red by name** (`TEST_TIMEOUT_MS` in
`src/mc/repo-gate.js`). Every selected file runs with `--test-timeout=600000
--test-force-exit` unless the repository declares its own `--test-timeout`; a
test that runs past ten minutes is a red named `test timed out after 600000ms`,
not a 60-minute stop that names nothing (memoro #14067, 95 minutes, 2026-10-23).

**A project log with a row twice is red.** Once the candidate is built, before
its dependencies or its selection, the round reads the candidate's `docs/project/project_log.md` (`duplicateRow`,
`archive-plan.js`) and, when two rows share date, programme and project, stops
with `stopped_at: 'project-log'` — a red, the change's to fix — and the reason
`project_log.md carries the same row twice: <date> <programme> <project> —
delete the copy and push`. memoro's `.gitattributes` merges that file
`merge=union`, which keeps both sides of a conflicting hunk: on 2026-10-10
memoro's main carried one row five times, each copy from a step branch that
merged main in. A batch that stops this way falls back to single rounds
(`FALLBACK_STOPS`), so the pull request that brought the copy is the one turned
red. The archive's `appendRow` is the other half: given a log that already has
a row for that programme and project, it returns the text unchanged.

**A plan file in the tree is red.** Once the candidate is built, the round lists the candidate's `docs/project` (`lsTreeArgs('HEAD')`, `plansInTree`, `plan-source.js`) and, when one holds a `PLAN.json` or a legacy `PLAN.md`, stops with `stopped_at: 'plan-in-repo'` — a red, the change's to fix — and the reason `<path> is a plan file — plans live under ~/mc/programs/ (mc project new); delete it from the branch and push`. Since ruling 48 no repository holds a plan, so this refuses the branch that brings one back. It sits in `FALLBACK_STOPS` and `MEND_STOPS` beside `project-log`.

`gateLines` in [`src/mc/commands/repo.js`](../../src/mc/commands/repo.js) builds
them; [`tests/mc/commands/gate-verdict.test.js`](../../tests/mc/commands/gate-verdict.test.js)
asserts the length as a number, so the prose cannot grow back quietly.

## One pull request, and nothing else

A round has exactly one subject: the pull request (or the batch) named on the
command line. It touches no other branch.

Until 2026-08-30 a green round ended by freshening **every open pull request on
the repository** — merging the new main into each, pushing, and writing a line
into its owner's inbox (A6). It came from a real measurement and it was still
the wrong shape. Every round reported that two unrelated six-day-old pull
requests conflicted with main; the fact was true and it was about those
branches, restated by every round that had nothing to do with them, until it
read as though the merge that had just succeeded had gone wrong.

It was redundant besides. The gate merges the current base *into the candidate*
before measuring, so every pull request is already measured as the state it
would leave behind. A branch that has fallen behind finds out in its own round,
which is the round that can do something about it — and a conflict needs a
person either way. All the sweep bought was learning about it earlier, at the
price of pushing to branches and messaging people from a round about something
else.

The one freshen left is inside a batch: after each landing, the just-made main
is merged into the next branch *in the batch*, because the squash makes it
unmergeable to the forge otherwise. Every branch it touches was named on the
command line.

## Landing a stack

A stack is a delivery in several pull requests over the same files, where each
branch was cut from the one below it rather than from `main`.

**The batch form does not take one as it stands.** Every pull request in a
batch must aim at the same base — `repo-gate.js` stops the round at `pr`
otherwise, before it measures anything:

```
mc merge memoro-cli 509 510 511
mc: the round stopped at pr — the batch aims at 3 different bases
    (main, intake-no-proposal-parsing, decisions-out) — one round per base
```

The step that makes it work is on the forge, not here: retarget every branch at
`main` first (`gh pr edit <n> --base main`), and the same command is accepted.
Each head already contains the ones below it, so the merges into the candidate
are trivial, and the tree recorded after each one is the tree `main` will have
after that squash.

**A batch is not atomic.** A red or a conflict drops it to a round per pull
request, and that fallback can land a prefix and stop. Measured 2026-09-01 on
the three-step stack above: red on a test already red on `main`, fell back,
landed #509, refused #510 and #511.

**A squashed base leaves the branches above it conflicting.** Not through
anything the caller did between rounds — the round itself merges the current
base into the candidate before measuring, and against a squash of the branch
below, that merge conflicts wherever the two touched the same lines. Both
branches left after #509 landed were plain, linear, carrying no merge commits
of their own, and both reported `CONFLICT (content)` on their next round.

**Rebase is what gets them in.** `git rebase --onto origin/main <the old base's
head>` replays only what has not landed. Five rebases across that stack: three
byte-identical in patch, two conflicting on real overlap with what had landed —
a file two changes had each edited, and a file one change deleted while another
edited it. Neither conflicted because of the stacking. Compare `git show <old>
--stat` with `git show <new> --stat` rather than trusting the replay, and push
with `--force-with-lease`.

The in-batch freshen above is the same fix done inside the round, on
branches the caller named, for the pull requests a batch does land.

## One round at a time

Two leases, and between them a merge round cannot overlap another:

- **the repository lease** — one round per repository.
- **the suite right** — one full suite on this machine, whoever holds it. Two
  rounds on *different* repositories therefore cannot both be measuring at
  once.

Both carry the holder's pid, so a round that was killed rather than finished
is reaped by the next claim instead of blocking forever. Neither blocks git:
they refuse `mc`, and nothing else.

While a round runs, the merger asks GitHub about its pull request every minute
(`SUBJECT_POLL_MS`, `watchSubject` in [`merger.js`](../../src/mc/merger.js)),
and the round is stopped through its `AbortSignal` when the answer says so: a
pull request merged on GitHub is answered landed (`already_merged`), one
closed is answered closed, and one given a new push goes back in line at its
own place, with no attempt counted and no mend. A command gate running at that
moment is waited out, not killed. A batch round is not watched, since
`MERGE_BATCH_MAX` is 1. On 2026-10-24 memoro #14169's round ran 13 minutes
after its pull request had been merged on GitHub; the minute of asking is what
ends such a round now.

**`mc merge` waits for neither — the merger does** (ruling 30, 2026-10-09).
`mc merge <repo> <pr>` checks the plan's criteria (*The door*), writes the job
into `~/mc/runner/merges.json` (`repo`, `repo_path`, `pr`, `branch`,
`holder`, `step`, `since`, `state`) and returns at once, saying its place in
line. One process lands the jobs, oldest first, one at a time: the merger
([`src/mc/merger.js`](../../src/mc/merger.js), started detached by the first
`mc merge` that finds none, its pid in `~/mc/runner/merger.json`, its output
in `~/mc/runner/log/merger.log`). It marks a job `landing`, waits while the
gate lock or the job's repository lease is somebody else's (an orphaned lease
is nobody's: the round's own claim reaps it), runs the round as the holder
who asked, records it, writes the register, drops the job, and takes the
next; with the queue empty it leaves. Since 2026-10-24 (ruling 55) it lands one
job a round: `MERGE_BATCH_MAX` is 1, because a batch of four cost about 430 s per
landed pull request against 210 s alone on memoro's merge rounds of 2026-10-17
to 10-24. The batch machinery stays for a merger resuming a batch it died under:
it takes that repository's `landing` jobs again, in one round, and answers each
by itself. It runs one loop per repository, so
two repositories' rounds are in flight at once — see [`mc-run.md`](mc-run.md)
§ *The merge* for both. A merger killed mid-round leaves its
job `landing`, and the next merger — started by the next `mc merge`, or by
the runner when it reads a queue with jobs and no live merger — lands that
one first; the round itself says whether it had already merged.

On new code the merger hands over at once: it releases `merger.json` and starts
its successor as soon as it sees the new checkout, finishes only the jobs it
holds, and the successor skips the `landing` and `mending` entries whose
`merger` pid is alive — a `mending` entry whose merger is gone goes back in
line on the successor's next pass. Measured 2026-10-17 → 24: 76 handovers
stalled the queue 643 minutes in all, when the merger left only after its
rounds in flight.

Until then every `mc merge` was its own waiter — an entry with its pid,
polling every 15 s, giving up after 8 minutes with exit 3 and "run this
again" — and the runner's landing of a session's pull request waited the
same way. A machine with six lanes could be six processes standing in line
for one lock (Martin: *"Just nu blir flera processer hängande eller väntande
på detta."*). A batch (`mc merge <repo> <pr> <pr>…`) is still measured in the
caller's process, as before.

The gate lock also carries `mode` — `check`, `merge` or `full`, the same word
the round log writes beside it — and `phase`/`phase_at`, rewritten each time
the round's own narration says something new, but only by the pid the lock
still names: a round whose lock was taken over while it was dying must never
overwrite the round that took it. Ruling 20 (Martin, 2026-09-12) asked for a
MERGES section on the page, current round plus queue; this is where the
current round's name, mode and phase come from — `runningMerge` in
`src/mc/merges-collect.js` joins the lock to the repository's name and its
lease's holder, so the page reads a sentence rather than a slug and a pid.

**And the register** (rulings 21 and 30). For a pull request that is a
step's — `MC_STEP=<project>:<index>` in the calling session's environment, or
a branch a register entry stands on (`stepForMerge`,
[`src/mc/merge-step.js`](../../src/mc/merge-step.js)) — `mc merge` makes the
step `landing` with its pull request, and the job names the step. The
session's part is over there: it ends. The merger writes the outcome. On green
the step is `done` with the pull request and the commit it landed as. On red
the attempt is counted and the gate's reason kept, the pull request stays
open, and the step is `ready` again (`redPatch`): the runner's next session
for it is told the reason and the pull request and goes on with the same
branch (`retryPreamble` in `run-plan.js`) — its own open pull request does not
hold the project (`holdingPrs`). At `MAX_MERGE_ATTEMPTS` (3), or a round that
cannot say whether it merged, the step is `failed` and a person's. A step
somebody made `done` or `blocked` meanwhile is left as it is.

**The next step does not wait** (ruling 30, A). A step `landing` is passed
over by the picker (`planState`), and its open pull request does not hold the
project (`holdingPrs`): the runner starts the next step at once on a new branch
on top of the landing step's (`placeBranch` in `run.js`) and writes
`stacked_on: { index, pr, sha }` on it. Its `mc merge` queues it with that as
`parent`, and the door reads the plan from the parent's tip. The merger takes a
job with a parent only once the parent is out of the queue and its step is
`done` (`nextJob`), then moves the branch onto main past `sha` (`restack` in
[`src/mc/merger.js`](../../src/mc/merger.js), in a temporary worktree, pushed
with a lease on the tip it had) — the one below was squash-merged, so its
commits are in the branch under other names. The move replays only the
branch's own commits: `git rev-list --reverse --no-merges <tip> ^<sha>
^origin/main`, cherry-picked one by one onto `origin/main`; a pick that comes
out empty, because main already has it as a squash, is skipped. Until
2026-10-10 it was `rebase --onto origin/main <sha>`, which also replays the
main commits a session had merged into its branch — already on main, they
conflicted with themselves, and #857 and memoro #13375 came back `restack: …
conflicts` though their own commit picked clean (ruling 38, since deleted). When
a pick conflicts, the move starts again from the tip and runs `git merge
--no-edit origin/main`; the log line then reads `moved onto main past #<n>
(merged main in)`. Only when that merge conflicts too is it a red,
`stopped_at: restack`, naming the conflicted paths. When the one below comes
back red the job on top stays in the queue and waits; that step is the
project's next session's first, on its own branch.

**The runner queues what the session published and did not** (ruling 25,
2026-10-07). When a step session's process is gone, the register still says
`running`, the session ended `success`, and a pull request is open on the
step's branch, the runner asks for that merge itself (`landForSession` in
[`src/mc/run.js`](../../src/mc/run.js)) through the same door: the plan's
criteria, then `queueMerge` as the step's workarea. The row's note is
`success,queued-by-runner`; a refusal at the door is a red like any other,
note `success,red`.

**The merger is the installed mc** (ruling 37, 2026-10-10). `startMerger`
spawns `merger-run.js` from the checkout the `mc` on PATH resolves to
(`installedMergerRun`), never from the caller's own tree, and the first line
of every merger reads `merger <pid> started — ~/memoro-cli at <sha>`. On
2026-10-10 the merger that served 17:47-18:00 had been started by a step
session from its workarea and ran that branch's code, with batches and
without lanes.

## The async round, SIGTERM and the mend

**Nothing the merger starts holds its event loop** (ruling 37). Every child
of the gate and the merge round — git, gh, `npm ci`, the derived commands, the
selector — goes through [`src/mc/child-async.js`](../../src/mc/child-async.js):
`runTool` (no shell) and `runShell` (a declaration as written, `npm ci`).
Both resolve to the result shape the synchronous spawn gave, `{ status,
signal, stdout, stderr, error }`, and never reject, so callers read it as
before and a test's sync stub still works (`await` of an object is the
object). `maxBuffer` is 256 MiB per stream, stated because Node's 1 MiB
default killed memoro's selector at 1.3 MB (#12720); a timeout kills with
SIGTERM and says `ETIMEDOUT`. A `grep` test fails if `spawnSync`,
`execFileSync` or `execSync` appears in `repo-gate.js`, `repo-merge.js`,
`repo-freshen.js`, `repo-derived.js`, `prepare-cache.js`, `selector-miss.js`,
`merger.js` or `merger-run.js`. What it replaced: on 2026-10-10 the merger was
blocked from 17:40 to 17:47 through `npm ci` (268 s), derived (33 s) and the
selector (107 s), and the light lane stood still beside the heavy one.
`merger-run.js` now passes the lane it is handed to `landJob`, so a light job
starts and lands while a heavy round is in any phase. `mc test`, `mc merge
--check` and the nightly run go through the same `runGate`, only awaited.

**`signals`.** `runGate` installs its own SIGINT/SIGTERM handler, which ends
the round and leaves, unless it is called with `signals: false`. The merger
always passes `false`. Its own handler in `merger-run.js` only sets
`stopping`: the loops take no new job, say `asked to stop — waiting for <n>
job(s) in flight`, answer the rounds in flight as usual (no `killed`), and
`serve` returns — `left` — within a second of the last answer. What is still
queued waits for the next start. The gate's handler had cut the 17:47 round
short (`repo-gate.js:318-341` then).

**`signal`.** `runGate` and `runMergeRound` take an `AbortSignal`. On abort the
test process group is killed at once (SIGKILL), no further phase starts, and a
running command gate is waited out rather than killed; the round then ends
`stopped_at: 'gone'` with the signal's reason, and its workspace, lease and lock
are released as on any end. Nothing in the round reads the signal as a red or a
stop it can fall back from: `gone` is in no fallback list. The merger's watch
that passes the signal is the next step of round-abort.

**Already merged on GitHub.** Before a round, `landJob` asks GitHub for each
job's state (`prStateOf`). A MERGED one is answered landed by itself with
GitHub's merge commit (`memoro #13372: already merged on GitHub as <sha> —
answered landed`), dequeued and its step `done`; a CLOSED one is red by itself
(`closed on GitHub`). Both leave the batch, and the rest are measured without
them. Red rows are looked at too, at start and then every `SWEEP_MS` by an
idle loop (`sweepMergedReds`): a red whose pull request has since merged is
dequeued and its step `done`; a closed one leaves the queue. On 2026-10-10 a
hand-merged #13372 turned #13373 and #13374 red with its reason, and #13370
stayed red in `merges.json` after its `--admin` merge.

A job answered before the round — merged, closed, or a restack refused — is
written to `merges.json` the moment it is answered (`landJob` tells `serve`'s
`writeAnswer` through `onAnswer`, after the register is written and outside
any lock), so the page and `mc merge watch` never draw it as landing while
the others' round runs; a restack red that gets its mend starts it then, as
soon as the mend line is free. On 2026-10-10 #13400 (closed) and #13397 (a
restack conflict) read `landing` for the whole 9-minute round of #13375 and
#13405, and #13397's mend waited 100 s for that round to end after the mend
before it had. The block after the round writes only what `onAnswer` did not:
a round that threw.

**A plan's steps land in order.** A job for step n goes only once every
earlier step of its plan is `done` in the register (`stepsDone` in
[`src/mc/merge-queue.js`](../../src/mc/merge-queue.js), read by `nextJob` and
`nextBatch`), whether or not it names a `parent`. A `landing` job a restarted
merger would resume while an earlier step is no longer `done` is put back in
line (`heldLanding`). `waitingOn` says what each held job waits for; the page
and `mc merge watch` read it as `waits for <project> step <n>`.

**The mend** (ruling 37, amending rulings 21 and 30 in one point: one mend,
then red). A red the change itself caused — `stopped_at` in `MEND_STOPS`, on a
job with a branch and no `mended` — is not answered red at once. The entry
becomes `mending` (`{ pid, started, reason, stopped_at }`), the step stays
`landing`, the lane goes on with its next job, and a session of role `mend`
([`canon/roles/mend.md`](../../canon/roles/mend.md)) starts in a worktree of
its own on the branch (`runMend` in [`src/mc/mend.js`](../../src/mc/mend.js),
under the work root, never the step's workarea). The prompt carries the
round's reason, its red files or conflicted paths, the step's title and
`done_when`, and the job's last lines of `merger.log`. When the session ends:

| the branch on origin | the entry | the step |
| --- | --- | --- |
| moved past the head the round measured | `queued`, its old `since`, `mended: { at, outcome: 'pushed' }` — measured by a full round like any other job | still `landing` |
| did not move, the session failed or timed out | `red` with `<reason> — the mend pushed nothing: <its last line>` (or `timed out`, `failed`) | through `redPatch`, as any red |

A job that comes back red after its mend is red at once, and so is a red
outside `MEND_STOPS` or one that is main's own (every red file red on the base
too). The mend never merges, never runs `gh pr merge`, never force-pushes,
never touches `main` and edits no `PLAN.json`; whatever it pushes is measured
by the same round. One runs.tsv row of kind `mend` per mend. A `mending` entry
a merger finds at start belonged to a mend that died with the merger before
it: it goes back in line unmended. A SIGTERM drops the mends waiting (their
entries stay `mending`) and waits for the one running.

**The merger leaves for new code.** On 2026-10-18 a merger served 5 h 22 min
on 3b51ff90 while seven mc pull requests landed, because it read its commit
once and left only on an empty queue. Since then `serve` in
[`src/mc/merger.js`](../../src/mc/merger.js) reads its checkout's HEAD before
each batch. A HEAD past the commit it started on releases `merger.json` and
calls `handover` at once, between rounds: `merger-run.js` starts its successor
through `startMerger` while jobs remain in line (`succeed`), and this merger
takes nothing more. The rounds and mends it holds finish — a mend not started
yet is dropped and its entry stays `mending`, a running one is waited for — and
the successor takes every other job in both lanes. A SIGTERM starts none; it
finishes what it holds, as before. The runner's `sweepLanding` and the next
`mc merge` still start one when none lives. `mc merge watch` adds
`merger on <commit> · main <commit>` to its line while the merger's commit
and the installed checkout's HEAD differ.

**What a red round keeps** (ruling 44). Every round that finishes `red` writes
its failures to `~/mc/runner/merge-red/<repo>-<pr>.txt`
([`src/mc/merge-red.js`](../../src/mc/merge-red.js)): one file per pull
request, a batch's from each one's own fallback round. The next red overwrites
it and a landing removes it. The file holds, per red test, its file, its name,
where it failed and the assertion's first lines, at most 200 lines in all. The
gate cuts these blocks out of the suite's TAP and out of the selected files'
TAP (`redTests` in [`src/mc/tap-red.js`](../../src/mc/tap-red.js)) after the
killed and cancelled files are taken out of the red. The path is on the report
as `red_detail`, and it goes into the round's `gate-rounds.jsonl` line with
`red_files`. Two readers get it. The step's next session gets it through the
register's `red` and the retry preamble. The mend gets it through its prompt.
Both are given the same three lines: `Red files: …`, `The failures, as the round
saw them: <path>`, and `Re-run just those: mc gate <files> --test-name-pattern
'<names>'` (at most five names, regex-escaped). The mend is told to run
`mc gate <red files>` until they are green, and never the whole suite (ruling
52). Until then every mend was told `red files:` with nothing after
it. A merge round keeps the gate's verdict under `gate`, and the mend read only
the top of the report. Now `runMergeRound` lifts `red_files` and `main_red` up
to the top when the gate stops.

**Previous red first** (ruling 44 § 2). When a pull request's last
`gate-rounds.jsonl` line ended `red` with `red_files`, the next single round
runs those files alone on the prepared candidate in a timed phase
`previous red` before the selection: still red stops it `red` there, with the
main-red probe as for any red, and all green says `previous red files green —
measuring the selection` and goes on as before (`previousRedFiles` in
[`src/mc/repo-gate.js`](../../src/mc/repo-gate.js)); a batch skips it.

The three numbers are constants with their reasons beside them, not settings:

- **`MEND_STOPS`** — `merge`, `restack`, `red`, `selected-gate`, `pr-tests`,
  `extra-gate`, `derived-outside`, `project-log`, `plan-in-repo`: where the fault is in the
  change. `fetch`, `pr`, `killed`, `threw`, `busy`, `drift` and the deploy
  wait are the machine's, and a session on the branch cannot fix them.
- **`MEND_AT_ONCE`** = 1 — an 8 GB M1 already runs a memoro suite of seven
  lanes; a second session with its own suite beside it makes the round's own
  timings lie. Further mends wait in memory, in answer order (`mendLine`).
- **`MEND_MINUTES`** = 120 — a ceiling for a hung session, not a budget. At
  20 the #13409 mend (2026-10-10) was cut off mid re-record of the SQL
  baselines and the step went red as before: the cut cost the session and
  bought nothing. Step sessions have no wall clock (ruling 18); a mend's
  output is buffered, so it cannot be judged stalled as they are.

## The full run nobody asks for

The runner runs `mc test <repo> --full` for every repository mc knows, once a
day, with nobody typing anything. It is a **chore of the runner**
(`runNightly` in `src/mc/run.js`, the last thing a chore pass does, beside the
helper and the intake drain); until 2026-09-19 it was a detached process of its
own, started with `mc test nightly start`, with a pid file and a `stop`, and
that scheduler is gone — there is no second thing to start, stop and remember,
and nothing on this machine that can start a nightly but the runner. The verb
that is left is `mc test nightly status`; it is under `mc test` because that is
the round the tick runs. It was `mc repo nightly` until 2026-09-04, which now
prints `mc repo nightly is now mc test nightly` and exits 2.

It exists because memoro's whole suite ran only when a person typed `npm run
test:full`, and #10529 is what that produced: four days of merges left 31 tests
red on `main` while every pull request's affected-selection passed, because
nothing ever looked at the whole.

It is a **meter**, and the word is load-bearing (ruled by Martin, 2026-09-02):
nothing it finds refuses a merge, delays a round or changes a verdict. It never
commits, never pushes, never writes inside a repository and never takes a
branch. Everything it writes is under mc's home —
`~/.memoro/mc/nightly/nightly.log` and the per-repository history beside it.
There is no pid file: a `nightly.json` left by the old scheduler is read by
nothing and can be deleted. It is optional in the one way the runner is: no
runner, no tick.

- **The round is the same round.** Not a copy, and not `npm run test:full`
  directly: it calls `runGate` with the `full: true` a person's `--full` passes,
  so the scheduled reading and the asked-for reading cannot disagree about what
  a repository's whole suite is. Every tick is counted in `gate-rounds.jsonl`
  like any other round, so `mc repo rounds` stays true about what this machine
  did.
- **A held lock is a skip, never a wait.** The round lock has no expiry on
  purpose — a round is *supposed* to take minutes, so no clock can tell a slow
  round from a dead one. So the nightly attempts it, and a live holder ends the
  tick then and there with a line naming that round's pid. A machine that merged
  all evening shows a night of skips and one run, and that reads as normal. No
  queue, no backoff, no notion of a run that is "overdue": a missed night is a
  missed night and the next tick runs.
- **The cadence is measured from the last completed tick**, never from a
  wall-clock hour. A laptop asleep at 03:00 never sees 03:00, and a scheduler
  that notices the miss on waking fires a catch-up burst at breakfast. Sleep
  simply stretches the gap here. Once a day, the last tick being the last
  `kind: nightly` row in `runs.tsv` — that row is the tick's whole state, as the
  helper's is, and it is written whether the tick measured, was stopped or
  threw, so a tick that failed is not retried ten minutes later. There is no
  interval to configure.
- **STOP reaches it.** A chore pass that finds `~/mc/runner/STOP` starts no
  tick, and the tick asks for STOP (and UPDATE, which drains the runner) before
  each repository, so `mc run stop` during a tick means the next repository's
  suite is never started. The suite already running is not killed; it ends by
  itself and the tick's row says `stopped`. The runner's own `--once` runs no
  chores, so it runs no tick.
- **Three outcomes stay apart.** A run that found nothing, a run that named
  failures, and a run that produced no suite result at all — the lock was held,
  the preparation failed, the declaration stopped it, the process died. The
  third is not zero failures, and a day of them reported as a green streak would
  be the same false green `--full` was fixed to remove, arriving by another
  road.

Measured 2026-09-03 on this machine: a tick that found a `mc test memoro-cli
--full` round holding the lock recorded `memoro  skipped  another gate round is
running on this machine (pid 77336, memoro-cli-1d5e7a04, since …) — one at a
time` and did not wait.

### Red, and since when

The number that would have prevented #10529 is not "31 tests are red". It is
"these 31 tests have been red since Tuesday": one run's red list looks exactly
like a flake, and the same list twice, dated, does not. So every tick appends to
a bounded history per repository under `~/.memoro/mc/nightly/` — when, which
commit of the branch, and the failing test *names* — and `mc repo status` reads
it back:

```
    full run   4h ago  8 red of 17,982  fc19465
               red since 2d ago (3 runs)  data-bus event names…  +7 more
```

`mc test nightly status` prints those same rows, one block per repository the
tick measures, under a header that says where the tick now comes from — the runner running
(and when the next tick is due), a tick due now, the runner stopping, or the
runner stopped and no tick therefore coming until `mc run start` — the same
`nightlyRows` called rather than copied, so the two pages cannot answer "red,
and since when" differently. `--json` carries `runner` (`running`, `pid`,
`started_at`, `stop_requested`), `tick` (`due`, `detail`), `interval_ms`, `log`
and a `repos` object of one reading per repository — the readings themselves
unchanged. The repository page is where somebody who is asking about a
repository finds the same fact.

- **Since when is the first run of the *consecutive* streak.** A test red on
  Monday, green on Tuesday and red on Wednesday has been red since Wednesday.
  The other reading — earliest occurrence anywhere in the history — is identical
  on every history where nothing ever went green, which is every history there
  is on the day it ships, so it is asserted directly.
- **Names only, and never capped.** Not output, not stack traces: a name is
  enough to say a thing is still red, and more turns a meter into an archive.
  The names are deliberately not capped the way `gate-rounds.jsonl` caps its
  own, because a dropped name comes back next run looking like a test that had
  gone green and broken again. The bound is the number of runs kept — fourteen,
  two weeks at the default cadence.
- **A run that measured nothing is transparent, never green.** It neither
  continues a streak nor breaks one, and it is stored as what it was: the last
  *attempt* is its own row on the page, above the last *measurement* it could
  not replace.
- **When the streak reaches the oldest run kept**, the date is a floor and the
  page says "since at least"; with one run in the whole history it says "first
  seen in this run" rather than dating a test to the day this shipped.
- **Only the scheduled run writes there.** `mc test <repo> --full` typed by a
  person is the same reading, but it can be asked about a pull request, and red
  names from a candidate merge tree would make "since when" a sentence about
  somebody's branch.
