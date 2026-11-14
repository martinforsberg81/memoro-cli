# mc test and mc merge — one measurement, two doors

A pull request lands through `mc merge <repo> <pr>`, and through nothing else.
It is measured by `mc test <repo> <pr>`, which is the same round stopping at the
verdict. There is one implementation: `mc merge` runs `mc test`'s round and then
lands what it cleared. A second implementation is the thing this arrangement
exists to prevent — two measurements drift, and the one that drifts is always
the one the merge trusted.

Drop is a cancellation boundary. Merge admission refuses a PR owned only by a
dropped goal, including a manual job with no goal pointer. The merger rechecks
ownership before a queued round and immediately before the GitHub merge call;
a drop during a gate therefore cannot land afterward. Finalization removes the
abandoned PR's queued/red row under the queue lock. A PR still owned by another
unfinished goal is neither closed nor dequeued. An old merger answer never
reactivates a dropped goal; close/read uncertainty leaves cleanup pending for
retry.

The verb has two forms, and which one runs is decided by what the pull request
touches:

- **the gate round** — lease, the pull request's **existing** checkout holding its head
  with main merged into it, the test files the change reaches run there, the
  command gates the same selection named run after them, squash. This is what
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

A docs-only pull request needs the tests that read documents, not every code
gate. The docs form measures those tests on a candidate before landing, and
is also used for a programme archive. Goal records themselves live outside
the repositories; creating or changing a goal needs no docs pull request.
Build sessions publish with `--no-merge`; their review owns the landing hand-off.

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
calls the same `runGate` and `runMergeRound`. The round, its lease, its measurement
checkout, the red names read out of it by name, the deploy pull and
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

## The round runs to its verdict

Martin, 2026-11-09: regardless of load a merge, check or whole-suite round
runs to completion robustly, and never takes all cores. A round ends green or
red on the change: a failed assertion, a thrown error or a test that never
ends. An assertion red in the round that passes alone is still red; the
2026-11-04 rule, standing main evidence and explicit `retry_once` remain.

A test cut at its declared stall guard, a file cancelled by a hook node cut
at its timeout, a file killed from outside, and a command gate exiting 124 or
by signal are **unmeasured**, not red. `report.unmeasured` names their files
and gates. Genuine assertion red ends red without retrying these members,
which remain named as not measured beside the red. A thrown hook is red with
its own message; cancellation by itself is not evidence of a hook timeout.
A killed file cannot finish its reporter output: a signal naming that same
file in the parent TAP explains that file's output cut in suite, selected,
own-test and alone runs. Other cut files still refuse measurement, even beside
a named kill; nonempty completed TAP totals remain required.

After the suite, command gates and PR's own tests, the round measures each
unmeasured file alone, one at a time with `MC_TEST_LANES=1`. Declared loaders
and flags remain, but mc replaces `--test-timeout` with `600000`
(`TEST_TIMEOUT_MS`). The declaration timeout floor governs the suite, not this
execution override. A passing file is green; passed tests over the declared
limit are kept under the PR in the too-slow file. An assertion or thrown error
is red through the ordinary attribution rules. A test cut at 600 s is red,
"never ends", by name. Another external kill is retried; the third kill
stalls. Unmeasured command gates follow the files, serially through
`runSelectedCommands`. Every round command receives `MC_GATE_ROUND=<mode>`;
memoro's contract gates disable their hand/CI wall under it. `report.alone`
records `files: [{ file, outcome, seconds, argv }]` and
`gates: [{ name, outcome, seconds }]`; both alone and unmeasured are retained
in `gate-rounds.jsonl`.

`round_timeout_ms` and `round_timeout_why` retain their values: 20 minutes for
memoro and 15 for memoro-cli. The ceiling only reports
"past its N s ceiling at load L — F of S files finished, going on".
Only **no progress** — no test file finished, test file's process exited
(a whole suite's heartbeat, *A whole suite's progress*), command gate ended or
alone member ended — for `MC_ROUND_STALL_MINUTES` (default 15, `ROUND_STALL_MS`)
stops the process group early. The `stalled` report names files and gates in
flight, phase and load, and releases the lane. The sixty-minute process bound
(`MC_GATE_SUITE_MINUTES`) remains a last bound and also stops stalled.
The merger's `REQUEUE_STOPS` is only `['stalled']`: it puts the round back in
line after fifteen minutes, without a session, with `MAX_REQUEUES` unchanged.
Exhausted requeues are answered as before. The session's `mc gate` retains its
own hard ceiling and stall guard; this round policy does not change it.

Measured reason (2026-11-09): of 128 non-green memoro rounds since November 5,
38 ended on time cuts at median load 25 on eight cores, 32 at load 15 or more;
green rounds had median load 17.75. Suite seconds per selected file doubled
above load 15 (0.45 → 0.93). memoro#15171 fell ten times that day, five on
browser cuts under load. Raising the contract wall from 180 to 300 s
(memoro#15161, 16:43Z) did not hold: at 19:20Z, load 40, browser-contracts
exited 124 again. At 22:29 load was 60 with five session gates beside the
round. Eight of fifteen historical red-under-load rounds met the same cut
on automatic remeasurement. Machine time cuts must not judge the change.

## Mend eligibility independent of goals

Martin, 2026-11-09: merge recovery is attached to the failed PR and repository,
not restricted to a goal. A failed eligible merge must be recoverable by mend
whether it came from a goal, interactive planning, Manager or a direct merge
request. Goal metadata supplies additional contract and lifecycle context;
its absence must not suppress recovery or require inventing a goal.

Use the PR's one existing checkout and exact failed revision, preserve its
author's intent, establish acceptance for the repaired final tree and requeue
through the ordinary merger. Preserve existing capacity/provider routing,
retry limits, reserved-act restrictions and stopped/closed PR safety. A goal
and a PR recovery must never acquire concurrent ownership of the same branch.
For a PR without a goal, retain recovery attempts, logs and outcome against
the repository/PR identity. Failed command gates need their command identity
and diagnostic evidence even when no Node red file was reported.

This decision supersedes goal-only eligibility below. It specifies required
behaviour; the existing goal-only runner is not evidence of implementation.

## The measurement checkout

Every repository round — an ordinary or goal PR, batch, documents-only
measurement, branch freshening and a person's whole-suite run (`--full`) — uses
mc's standing checkout at `<work root>/gate/<slug>/candidate` (`~/mc/gate/…`), implemented by
[`measurement-checkout.js`](../../src/mc/measurement-checkout.js). The
runner's scheduled full run uses a sibling standing checkout,
`<work root>/gate/<slug>/full`, made and healed the same way, because it runs
beside the merge lane rather than in it (Martin, 2026-11-13; *The full run
nobody asks for*). First use
creates it from the repository with `git worktree add --detach <dir> <sha>`;
subsequent rounds keep it. No round borrows a session or planning checkout or
creates a per-round worktree. No branch needs to be held by another checkout.

The repository's merge lane is the exclusion: every user holds its atomic
claim for the whole use of this checkout. Gate rounds and documents
measurements already hold it; freshening takes the lane with `takeLane` and
releases it only after its push (or failure). Two users cannot own it at once.
A foreign process standing in the directory is refused as `worktree`, naming
its pids; the round's own ancestry is excluded. Incomplete process evidence
also refuses mutation. Nobody is directed to work in this directory.

Before use mc heals its own workspace: `git worktree prune`, re-add a missing
directory, abort any unfinished merge, cherry-pick or revert, then
`git reset --hard` and `git clean -fd`. Ignored files, including dependencies,
stay; preparation replaces a cached `node_modules` clone rather than nesting
inside it. Finally `git checkout --detach <sha>` selects the candidate.
Discarding this tree never discards a session's work.

A PR starts at its pushed head and merges the fetched `origin/<base>`; a batch
starts at the fetched base and merges its heads in order. Documents start at
the branch head and merge the base. Freshening starts at the pushed head,
merges the base, regenerates declared derived paths and pushes
`HEAD:refs/heads/<branch>`. It never advances the session's local branch: that
checkout may now be behind origin, which `mc publish` explains. A whole-suite
run starts detached at the fetched default base in this same directory.

Derived artefacts are declared by the repository that writes them. memoro's
derived list is in its `.mc/test.json`; mc ships none for memoro and the
operator table keeps none. The layers merge field by field, and the highest
layer that states `derived` replaces the others whole, so a copy kept beside
the repository's went stale: measured 2026-11-10 at memoro 3af1dc93b0, the
operator copy kept four commands, the shipped list had five and the
repository needed six (goal mc/derived-list-one-layer).

After measurement the checkout stays detached at the measured commit with
its merged tree, for `git diff` and `git log` inspection. Nothing is restored;
`worktree-restore` is no longer a stop. A failed or killed round's unfinished
operation or dirt is healed at next use. Round cleanup never removes the
checkout or its workspace; only round-owned temporary files are removed.

This replaces the borrowed-checkout rule of 2026-11-08 and its restore rule
of 2026-11-09 (Martin, manager session, 2026-11-09). The evidence at
`~/mc/programs/mc/evidence/2026-11-09-merge-rounds/measurement.md` records 32
stops in four days: `measure-candidate` 16 (checkout in use), `worktree` 13
(in use, worktree preparation, no checkout), `worktree-restore` 1 and
`dependencies` 3 (restored outside the work root). Those bucket counts total
33 in the five-day table; the evidence's four-day borrowed-checkout reading
is 32. They were infrastructure failures, not the change's red. Keeping a
standing checkout preserves the original aim of avoiding per-round creation
and deletion without borrowing working areas.

Protection stays in the existing gate, docs-measure, freshen, merge
integration and preparation-cache fixtures: first creation and later reuse,
healing dirt, missing directories and unfinished operations, foreign-process
refusal, the lane across freshening and its push, and session branch/HEAD
preservation. No new test file, scanner, framework or lane is commissioned.

## The door

Before the wait and before the gate, the door refuses a pull request GitHub
reports CONFLICTING, and one whose branch the caller's worktree holds at a head
origin does not have (ruling 43).

**A session decides when a goal merges.** Before a review, finish or mend session
authorizes goal landing with `mc goal stage merge`, the canonical
[`publish-and-merge` task](../../canon/tasks/publish-and-merge.md) requires a
completed `mc gate --whole-selection` on the final judged worktree: green,
or with only adjudicated `SETTLED` failures on the untouched frozen base
(Martin, 2026-11-11). A baseline-only settled result permits handoff without
waiting for the owning repair; it does not make an incomplete receipt green.
Only passed members are reusable, and the round independently measures and
adjudicates the candidate against its current base. Partial, deferred,
interrupted, unattributed or change-caused failures do not authorize handoff.
The session records scope, frozen base, judged revision, log and any named
baseline failures and failed members. A content-changing
mend establishes acceptance for the repaired worktree; an unchanged delivery
retry may retain still-valid evidence under the existing reuse rules. Explicit
verification exceptions keep their approved scope. These are session
requirements, not merger enforcement.

`mc goal stage merge` records that decision and queues every PR registered on
the goal. `landJob` sends goal jobs through the ordinary `runMergeRound`: a
candidate with the current base, exact reuse of the session's whole-selection
receipt when tree and selection match, delta reuse when the selector can measure
main's movement, and measurement of the rest. The squash is pinned with
`--match-head-commit` to the head the round measured. Every round is recorded.
The merger does not re-check criteria or the reviewed head and does not resolve
content conflicts. Each landing is recorded under the shared lock; the final
landing sets `done`. A failed round goes to mend under the ordinary retry and
offline rules. A new push during a goal's round leaves the queue and keeps the
goal in merge for mend to re-judge the head. Dropped-goal ownership is checked at
admission and again before the squash. The runner recovers missing queue entries
for goals already in `merge`; it does not make the merge decision. Existing
`merging` records are read as `merge`.

This closes the direct-landing gap (Martin, 2026-11-09): a goal's final gate was
measured at a frozen base, while main moved every few minutes — 86 goals landed
in 24 hours. A clean textual merge does not establish that the combined tree is
green. Main's red was the third cause of pull-request rounds failing for reasons
not theirs: 10 of 128 non-green rounds in the last five days, after load/time
sensitivity and infrastructure. Evidence and method are in the programme's
`~/mc/programs/mc/evidence/2026-11-09-merge-rounds/measurement.md` (986 rounds,
2026-10-26 through 11-09).

The merger measures the combined candidate and reuses the session's evidence;
the session's acceptance remains required because it is what the merger reuses.
Necessary integration of a named prerequisite still belongs before final
acceptance and authorization, under
[mc-goals.md](mc-goals.md#integrating-main-into-a-goal). A clean textual merge
does not establish that the judged tree contains its required dependencies.


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

**Opt-in and read-only.** Nothing starts a watch. A build session publishes
and ends without watching the merger. The watch never writes `merges.json` or
`merger.json`, never starts a merger and never cancels or re-queues a job — a
3 or a 4 leaves everything where it was. `--watch` is refused with `--docs`
(it lands in the call; there is nothing to watch), with `--check`, with several
numbers (one call per pull request), and by `mc test`. A queueing that is refused at
the door — a conflict, say — is returned as it is, with no watch.

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
   way on 2026-10-04 and turned `main` red);
3. waits for GitHub's mergeability, up to twelve five-second turns, because
   `UNKNOWN` for a few seconds after a push is normal and merge then fails for
   no real reason; `CONFLICTING` is a refusal that says which base to merge in;
   then it reads the head again, and a head that moved since step 1 is `drift`:
   not merged, because the files checked are not the files that would land;
4. measures the documents before anything is squashed. It heals the standing
   measurement checkout, detaches at the branch head and merges `origin/<base>` there,
   prepares it as a round does, asks the repository's selector (`selectFiles`,
   the gate round's own) which tests read the files, runs those files and the
   command gates it names, and refuses on any red: `red`, with the names. A
   measurement that could not run is `measure-<stage>` — `measure-candidate`,
   `measure-worktree`, `measure-merge`, `measure-prepare`, `measure-selection` or `measure-suite` —
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
the repository's document-reading tests found dead relative links that a document it had
not read introduced, and this form ran no test at all. The selector draws eight
files for #14188's paths, and `doc-links.test.js` is red on its commit, so the
measurement in point 4 refuses that landing instead of letting `main` go red.

**The file list comes from GitHub, never from a local diff.** A stale checkout
must not be able to make a code pull request look like documentation, and the
one thing this form must never do is land a file the suite would have had an
opinion about.

The docs measurement reserves the repository's gate lane before creating or
preparing its candidate and releases it after cleanup, including on failure.
It reuses the branch's checkout and the selector's files and commands, with no model or
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
4. takes its queue entry out under the runner's queue lock. An entry the merger is landing (`landing`) is left as it is, for the merger;
5. drops the pull request from the page's cached list. A page that cannot be written costs nothing;
6. writes one round-log line with `mode: admin`;
7. prints what landed, into what, as which commit. `--json` gives the same as one object. Exit 0.

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

## What it has done

Six `mode: docs` rounds in `~/.memoro/mc/gate-rounds.jsonl` between 2026-08-28
23:04Z and 2026-08-29 07:44Z: memoro-cli #419, #420, #428, #429 and memoro
#11025, #11039. All six merged, none refused, 4.8–6.1 s each. None was clicked.
One of them was the runner's own: the `canonical-response` triage on 2026-08-29
opened memoro #11039 and landed it in the same session
(`~/mc/runner/log/canonical-response-20260829T033139Z.json`). The same log holds
131 `merge` rounds and 10 `check` rounds — the gate is still where code goes.

## Known defect — the round does not converge under concurrent landings

Measured 2026-08-29 in memoro, four sessions merge — before the baseline
side was removed, so the window is roughly half that now and the shape of the
defect is unchanged. The gate round measures a candidate for 20–35 minutes and
then, before merge, requires
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

The standing candidate lives under the work root, so Node's parent walk can
resolve the shared `~/mc/node_modules`. A suite run
where the declared packages cannot be resolved does not fail — it runs the
tests that happen to need nothing and prints a number with the right shape
(D-0152: 2162 tests and 30 failures, where 206 tests never ran and were not
counted as skipped; 2368 of 2368 once the tree was linked). A number from such
a run is not low, it is invalid, and nothing about the number says so.

The round calls `ensureSharedDeps` on the standing measurement checkout, then runs the
repository's declared preparation. A cached dependency clone replaces any
existing checkout-local `node_modules`; it must never nest inside it or write
through a link into the shared tree.

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

**A repository may declare what only main measures** (`main_only`; memoro: eleven
ratchets and snapshots, Martin 2026-11-01). `selectFiles` takes those files out of
a pull request's selection, in the merge round and in `mc gate` alike, so both
hash the same selection. They still run in the whole suite on main, in a pull
request that edits the test itself, and when nothing else was selected. A change
that moves a pinned number therefore lands, and turns main red until it is
re-pinned.

**A suite finds the toolchain's git first** (`directGitDir` in
[`src/mc/repo-gate.js`](../../src/mc/repo-gate.js)). macOS's `/usr/bin/git` is a
shim that asks xcrun on every call, 67 ms against 23 ms for the git behind it
(2026-11-01), before model migration, autonomy tests made about 400 calls each. `suiteEnv`
puts `$MC_HOME/direct-git`, a directory holding one link, first on the suite's
PATH for production rounds. A round started by a test (MC_GIT_CALLS is set)
keeps its model/counting shim first; off macOS, or when no link can be made,
PATH is unchanged.

**A merge round runs at least four lanes.** `realTests` passes
`--test-concurrency=<testLanes()>` — unless the repository's own flags already
name a concurrency. A session's `mc gate` takes the free cores,
`cores - 1 - round(loadavg()[0])`, between 2 and `cores - 1`. A merge, check or
full round takes `max(4, the free cores)`, never above `cores - 1`
(`MERGE_LANES_MIN`), because the free cores were two all day: with four build
sessions the load sits at 10–16 on eight cores, and at two lanes the standard
batch took 178 s at the median (p90 377 s) over 159 suite runs from 2026-10-20 to
24. The floor is four and not seven because seven lanes beside the sessions are
what went red under load on 2026-10-19; the sessions' load cannot take the round's
lanes away. Martin, 2026-11-09: the round never takes all cores — at any
moment its test processes are at most cores − 1. Command gates follow the
suite; an alone member takes one lane, never beside another phase.
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

**An ordinary session gate may defer costly selected files.** Every run
records each test file's estimated seconds in `~/mc/test-times/<repo>.json`:
the sum of the file's top-level test durations, an estimate that excludes import
and process startup (`test-times.js`, a second reporter beside TAP; half the new
measurement, half the old). An unnamed ordinary `mc gate` runs the test files the change touches,
then others cheapest first while the estimate fits 180 s, and exposes the
exact files it deferred as unmeasured. Its coverage is `partial`, never
reusable evidence; it cannot replace the session’s required acceptance. The public
`mc gate --whole-selection` uses the same affected selector, tests and command
gates, but runs every selected check without cost deferral. Named files and a
bound gate (`measurementBinding`, `wholeSelection`) also defer nothing, as does
a repository that declares `session_whole` (memoro-cli, whose whole suite took
128 s in a session's gate on 2026-11-01).

**A session's gate times the tests the change touches.** Every test the run
reports, at any nesting, comes back from `realTests` with its name, line and
node's own duration (`testsMeasured` in `src/mc/test-times.js`, from the same
reporter that writes the per-file times). `mc gate` keeps those whose lines the
diff against the merge base changed (`changedRanges`; a test runs to the line
before the next test's, and a new test file counts whole) and prints one line
each, `test <file> › <name> — 0.xyz s`, slowest first, at most eight. The
time is information for the session and never changes GREEN or RED. A test
over 1 s is the writing session's to rebuild before it publishes; the merge
round still runs every file, so a slow test is red there only under the
repository's own per-test limit.

**A suite runs in its own environment, and for at most an hour.** The round
hands a suite the caller's environment without `NODE_TEST_CONTEXT`,
`MC_WORK_ROOT` and `MC_HOME` (`suiteEnv` in `src/mc/repo-gate.js`): the last two
are the runner's real `~/mc`, and `tests/_isolate-home.mjs` replaces them only
when they are unset, so memoro-cli's runner tests once read the real programmes
and one of them waited for a STOP it never wrote. A suite, a selected run, or a
file measured alone that is still running after `MC_GATE_SUITE_MINUTES` (default
60) is killed with its process group, and the round stops with `ran past N min
and was stopped — a test that never ends` as `stalled` instead of holding the lane. Before
2026-10-19 nothing bounded it, and memoro-cli #1009 held the light lane for
hours with no line in the log.

**One tree, and the verdict is its own red.** Ruled by Martin on 2026-08-31: a
round evaluates the diff, and whether main was already red is not the round's
question. Until then the round built a second worktree at the base, ran the same
file list there, and called the difference the verdict — half the wall clock, a
second `npm ci` and four modules of machinery (`repo-baseline-cache.js`,
`compareRed`, the red ratchet) to answer a question a merge does not ask. All of
it is gone.

Martin, 2026-11-09 (manager session): main's evidence is a by-product of every
measured landing. A green round whose landed tree equals its measured tree
writes main evidence for the commit it made — the files it ran or reused and
their results, inheriting the base commit's record for files outside its
selection — and a PR round reads three states at its exact base: covered and
green, covered and red (name and digest), not covered. The exemption below is
unchanged in what it exempts. Measured: in 986 rounds over the fortnight to
2026-11-09 the exemption fired 0 times: before the landing chain, evidence
required a completed whole-suite run and memoro's nightly failed 7 of 7 ticks.
The nightly stays the meter.

**The merge judges the pull request against main; main's red is found and repaired, not blamed** (Martin, 2026-11-10).
A red the standing evidence below does not excuse, in files no pull request
of the round touches, is run once alone at the round's base commit in a
temporary detached worktree (`redAtFrozenBase` in
[`src/mc/gate-settle.js`](../../src/mc/gate-settle.js), the same run a
session's `mc gate` settles with). When every red test of a file is red there
by name, the file is main's red: the round goes on past it exactly as past a
standing `covered_red` (`main_red_files`), lands on green, and carries the
failure into the landed commit's evidence. Main's red is a side matter for
the merge — it neither stops it nor counts as one of the pull request's
failed merges, and it never starts a mend of that pull request. Instead the
round reports `main_repair: { base, files, tests }` and the merger queues a
main-red mend (`requestMainRepair` in
[`src/mc/main-repair.js`](../../src/mc/main-repair.js); Martin, 2026-11-13).
The daily full run uses the same entry point and keeps its once-daily cadence.
No red test becomes a goal; repair goals already in flight finish as goals.

The atomic runner state `~/mc/runner/main-mend/<repo>.json` has version 1 and
one entry per red file, preserving test names/errors, base, finder (round of
`<repo>#<pr>`, or the full run) and state: queued, running, published (with PR),
landed, or Martin. A queued, running or published file asks for nothing new;
Martin also holds duplicates until resolved. A red after landed gets a fresh
entry. All read-patch-write transitions use the shared strict runner lock.
Queued files of one repository and finder run together, at merge-failure mend
priority within the existing lane total. A retry retains its original batch,
branch `mend/main-<repo>-<digest>` and worktree under `runner/work/`; new files
never join a used branch. The initial branch starts from fetched origin/main.
The session uses the mend role's default catalog list and class fast, without
GOAL.json, LOG.md or proposals. It classifies the error, repairs a regression
in the owning code/fixture or declares and provisions a host prerequisite in
`docs/technical/testing.md` with the provider installer (non-interactive sudo
when available). It never weakens, skips or deletes tests, lowers thresholds
or substitutes a runtime, and leaves other red files to their own requests.
It proves the named files GREEN with `mc gate --fresh`, none SETTLED, completes
`mc gate --whole-selection`, commits and publishes through ordinary `mc publish`
with title `Repair main's red: <files>` and cause/gate evidence in the body.
Publication records ownership before queueing so a fast merge cannot lose the
outcome. The merger marks landed and removes the clean worktree after its
session releases it; no force-removal of edits. A session without a published
PR, a dead runner's running request, or a failed merge is an unsuccessful
outcome. One more mend attempt follows the initial attempt on the same branch;
a third waits on Martin with the latest session log, visible in
`mc repo status`, the page's Martin queue and `mc martin get`, without a goal.
Transient merge requeues do not consume an attempt. The runner settlement pass
restores missing published queue handoffs and reconciles merged/closed PRs,
using ordinary idempotent queueing, and retries safe landed-worktree cleanup.

A red test green at the base, absent there, or a base run that
could not be made or did not finish is the change's red, as before. Touched
files are never run at the base. Measured: on 2026-11-09/10 memoro#15168 landed
through the old direct goal landing (closed by #1449) and broke
`subject-context.test.js`; five unrelated pull requests went red on it three
times each and reached `merge · Martin`, because each one's mend could not
repair another programme's fixture. It was repaired by memoro#15203.

This supersedes the 2026-11-04 rule below in one respect only: the round now
runs the untouched red files once at its base. It still does not move the
candidate's checkout, walk history, bisect or attribute a landing.

**Main's red is not investigated on a PR's clock** (Martin, 2026-11-04).
Every green landing whose landed tree is byte-identical to its measured tree
writes `<mc home>/main-red/<repo>/<commit>.json` for its new main commit.
The record is `{ commit, covered, files, tests, from, inherited_from, at }`:
`covered` names the files measured or reused (including the receipt's members),
`files` the red files, and `tests` their file, name and diagnostic digest.
`from` is `landing` or `full`; `at` is the write time. The newest 200 records
are kept, pruning oldest by `at`. The old `<mc home>/main-red/<repo>.json` is
read for its commit only and never written again; its unlisted files are
unknown, not green.

A landing inherits the exact base commit's record outside its selection:
base record minus this round's selection, plus this round's results. The
selector defines the change's reach, so files outside it are unchanged in
reach. The candidate's red (empty on green) and exempted `main_red.tests` are
carried forward: an untouched standing red stays red on the new main.
`inherited_from` names that base, or is null without a base record. Without
one, only this round's coverage is known. A batch writes a record per landed
commit in order, each inheriting from the one before; the documents-only
route writes the same evidence from its measurement after proving tree
identity. A non-identical landing writes nothing. An `--admin` landing writes
nothing and leaves a gap: the next landing cannot inherit through that commit.

A PR round reads three states per asked file at its exact base SHA:
`covered_green`, `covered_red` (with its tests), and `not_covered`. Missing,
stale or malformed records mean `not_covered`, never green by assumption.
A candidate red in a `covered_green` file is named as green on main at the
base commit, so mend knows it is the change's; the verdict remains red.
The reason states the evidence state and which landing (or full run) wrote
it, including an inherited base when present. Every candidate failure must
match the recorded file, name and diagnostic, and the PR must leave those test
files unchanged; otherwise the round remains red. The diagnostic compared is a
digest of the whole error (`diagnostic` in `red_tests`, from `tap-red.js`), not
the first lines kept for display: a deep-equality diff that differs only below
that cut is a new failure. Evidence recorded without the digest never
qualifies. Matching standing failures
are named in `main_red_files` and excluded from the candidate's red, while
command gates and the PR's own tests still run. This is a standing-assertion
exemption, not proof that unchanged failing assertions cannot hide another
cause. Unknown, stale or malformed evidence never becomes green by assumption.

PR rounds do not move the candidate's checkout to main, bisect its history or
write repeated intake notes for an already-known failure. Missing exact-base
evidence is answered by the one run of the untouched red files at the base
described above (2026-11-10), never by a walk. No timeout is raised.

**A declared timing test gets one more run** (ruling 44 § 5). Since 2026-10-07
memoro's JSC start-up budget, `sql:pr-ci`, dead-CSS and build-bundle went red
and then green with no change. A declaration's `retry_once` names such test files and selected
command gates (`{ "files": […], "gates": […] }`, shipped for memoro in
[`src/mc/repo-gate-table.js`](../../src/mc/repo-gate-table.js), overridable in
`.mc/test.json` like any field). After unmeasured interruptions are taken
out and before reading standing evidence, a red whose every file is in `files` is run once
more alone on the candidate: green, and the round sets `flipped: { files, names
}`, says `green alone — … flipped under load`, and goes on as a green suite
would; still red, only existing standing evidence may exempt the remaining
failures, without replaying main. Likewise a round whose every
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
`output`. The field is read from the selector, not from the declaration: it is
a fact about the gate's command, which the selector owns. A gate without `needs`
is run exactly as before.

An empty selection stops the round: it is not a measurement, and a green from it
would be the most confident kind of nothing.

**A green `mc gate` on the same tree is not measured again** (rulings 44 and
47). Completed full, unfiltered affected gates now write durable
[receipts](mc-gate-evidence.md) and populate `gate-greens.jsonl`
([`src/mc/gate-greens.js`](../../src/mc/gate-greens.js)). A round can reuse exactly
by tree and measurement version with equal selection, or with a valid full receipt
whose files and command invocations are supersets of the selected checks on that
same tree. Flags, execution identity and receipt validity remain required;
`reuse.superset: true` names the latter case. A round can also use the PR head's receipt
and ask the repository's dependency-aware selector what main's movement reaches.
Missing or incompatible evidence means measuring the relevant selection. Named
or filtered runs never enter this full-selection cache. Receipt-bound
callers additionally require the matching repository/run/revision and current
gate configuration; legacy v1 callers retain their existing admission path.
Required merge gates and the PR's own tests still run. `reused` in the round log
records the evidence taken, not a new measurement. Beside that unchanged field,
`reuse` records every decision: `mode: exact | delta` carries the existing reused
fields; `mode: none` carries `why`: `no-affected-green-for-head` (no cache entry
for head or candidate), `head-green-but-no-delta-declaration` (a head green but
main moved without `select_changed_path`), `selection-differs` (same tree but
uncovered selection, with receipt/selected file and command counts),
`receipt-invalid` (with `reason`: `version`, `execution`, `configuration` or
`files`), `delta-fallback` (with the fallback `kind` and detail), `batch`, or
`full`. The merger narrates a non-reuse reason in one line and the round record
keeps it, including the counts or refusal/fallback detail.

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
defines the bound consumer boundary, not a publication or merge permission.

**Reservation is atomic.** Each lane uses a prepared nonempty claim directory
published by rename, plus the existing JSON status file for readers and older
running mc versions. A second claimant cannot replace a live claim. A dead
owner is reclaimed by removing only its generation's marker and then the empty
directory; an old cleanup cannot remove a successor's claim. A failed
reservation stops the operation. During rollout, let already-running old
workers finish: old code cannot enforce the new reservation protocol.

**The command gates the selection names run after the suite.** They run one
at a time in selector order, through asynchronous `commandShell`, with the
frozen base commit rather than a moving ref. Every gate is measured even
when the suite has red, and every failed gate is named in `extra_gates`.
`timings['selected gates']` remains; the overlap timing is retired.

The old beside policy was measured on 2026-10-10 with light gates (161 s
beside against 36 s alone). Since the heavy contract gates of November 4/7,
a gate beside the four-lane suite was cut at its wall: memoro#15171 on
November 9 measured gates at 286–477 s beside suites of 238–377 s.
Martin ruled on 2026-11-09 that the round never takes all cores. Sequential
phases preserve that bound rather than adding command concurrency to the
suite's lanes.

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

### Standing main evidence, not a live base probe

The former live reproduction and first-parent attribution walk are no longer
called by `runGate`. `readMainRed` in
[`src/mc/selector-miss.js`](../../src/mc/selector-miss.js) only reads an
exact-SHA coverage record from the landing chain or a completed full run,
returning `covered_green`, `covered_red` and `not_covered`. It never bridges an
`--admin` gap. The historical diagnostic
helpers and old `selector-misses.jsonl` entries remain available; they are not
work a PR round performs. What the evidence does not excuse is run once at the
base in a worktree of its own (*The merge judges the pull request against
main*, above), never on the candidate's checkout.

A landing's record covers what its round ran (`candidate.covered`) and the
members of a receipt it reused, plus its red — never the selection as such.
Until 2026-11-10 it also wrote the whole selection, so a selected file a delta
round neither ran nor reused read `covered_green`: memoro#15193's round (293
selected, 11 run) wrote `subject-context.test.js` green on 3af1dc93 while it
was red, and eleven landings inherited it. The documents-only route runs its
whole selection, so there the selection is its measurement.

**Interrupted files are unmeasured, never excused green.** `killedFiles` in
[`src/mc/tap-red.js`](../../src/mc/tap-red.js) reads a non-null TAP signal;
`cancelledFiles` accepts cancellation only when no test failed and no hook
threw a non-timeout error. These files join the alone phase described above.
The hook-timeout marker is `failed running <kind> hook`; a different thrown
message stays the change's red. A failed test beside cancelled tests stays red.
With genuine red elsewhere the round stops red immediately, naming the
interrupted members separately. There is no green-alone exemption (Martin,
2026-11-04), and an interrupted file is never run at the base: only a measured
red is (2026-11-10). Only a stalled round is requeued; interrupted
members are resolved within the same round, not by a session.

A `before` hook that **throws** is the change's ordinary red, even when all
its children are cancelled and node's totals say zero failed. Its file and
hook message are kept in `red_files` and `red_tests`, with the full-message
diagnostic digest used for standing main-red matching. The reason names
`<file>: before hook failed — <first line of the message>`; the ordinary
merge-red handoff carries the error to mend. Without existing exact-base
evidence the failure remains red, not silently subtracted. Explicit
`retry_once` on the candidate remains as described above. Session gates also
refuse GREEN for a run containing cancelled tests, including after settlement
or a successful worker exit; its receipt is not green.


The queued retry record retains `not_before`, retry counts and a bounded
`retry_diagnostic` (`category` from the actual report's `stopped_at`, and
`explanation` from its actual `reason`). The diagnostic is not an inference
that a check proved machine overload. Offline backoff uses the same durable
shape, with the offline report as evidence. Queue parsing preserves these
additive fields; older entries remain compatible. A legacy queued entry with a
valid future `not_before` is still deferred, but its cause is displayed as
unknown when no diagnostic exists. A deadline is an eligibility time, not a
guaranteed start time. Only a valid future deadline is an active timed pause;
expired, malformed and absent deadlines are due and must not be presented as
delayed. Explicit requeue/new queueing and landing clear obsolete delay
diagnostics for current display. The normal MERGE & DEPLOY panel shows the
cause, local eligibility time with timezone, remaining delay, automatic retry
step and `mc merge <repo> <pr>` retry-now command. An all-deferred queue is
intentional even without a live merger process; a due job without an owner is
still stopped. Mixed queues keep each job's delay attached to its own PR and
repository. Current deploy/gate/lease observations remain separate, and a
completed failed deploy is historical rather than an active merge blocker.

**A test that never ends is a red by name.** Every selected, previous-red and
own test file runs with `--test-force-exit` and one `--test-timeout`, resolved
from the tree actually measured — the session's worktree, or the round's final
candidate after the base merge and derived regeneration, read before any test
starts (`declarationFor(repo, { contentDir })` in `src/mc/repo-gate-table.js`).
The repository is named by its identity (`memoro` for a bare `memoro.git`);
the `.mc/test.json` read is the measured tree's, never the common directory's.

1. **Reference.** The `--test-timeout` in the measured tree's `.mc/test.json`
   `pr_tests_flags`, else a parseable one in its `package.json` `test` script
   (memoro declares 1000 ms in `.mc/test.json`).
2. **Floor.** The winning `pr_tests_flags` (shipped < repository < operator,
   field by field) keeps its loaders. If it states no `--test-timeout`, the
   reference is appended and the gate prints one line,
   `timeout policy: --test-timeout=<ms> from <reference> — pr_tests_flags from
   <layer> states no --test-timeout`. An equal or tighter value stands. A
   larger value, `0`, `Infinity`, a non-number or more than one
   `--test-timeout` stops the gate or round before any test process is
   spawned, naming both sources and values. Arrays are never unioned.
3. **Default.** With no reference, the declared flags (or, with none, the
   script's own flags, its `--test-timeout` included) run as written, and a run
   without any `--test-timeout` gets `--test-timeout=600000` (`TEST_TIMEOUT_MS`
   in `src/mc/repo-gate.js`): a test that runs past ten minutes is a red named
   `test timed out after 600000ms`, not a 60-minute stop that names nothing
   (memoro #14067, 95 minutes, 2026-10-23). Node itself gives no per-test limit
   when none is stated; the round's default is what makes a hang red.

An invalid declaration in the measured tree is a stop too, for the session gate
and the candidate round alike: a malformed `.mc/test.json`, or any other
`declarationFor` refusal that carries a reason (a missing `prepare`, an
unreadable `retry_once`, an invalid `round_timeout_ms` or `select_changed_path`).
It never falls through to the shipped table or the test script. The one
fall-through is a repository with no declaration at all, where the test
script's flags stand — the session gate's documented default.

**One resolution, and what the receipt binds.** `resolveTestPlan`
(`src/mc/repo-gate.js`) resolves the test arguments once, for the session's
`mc gate` (`src/mc/commands/gate.js`), the candidate round and the worker that
spawns the tests. It returns the requested flags (the declared `pr_tests_flags`,
else the test script's `node --test` flags, timeouts as written), and the
effective timeout with its provenance: `declaration`, `script` or `default`.
Every spawned batch takes its argv from that plan (`nodeTestArgv`): `--test`,
the reporters, `--test-concurrency=<lanes>` unless declared, the one
`--test-timeout=<ms>`, `--test-force-exit`, the stdio helper, the requested
flags without their timeouts, then the file paths. The timeout is therefore
always before the files, and it is the only timeout Node is given.

A receipt keeps the two apart. `coverage.flags` is what was **requested**;
`coverage.execution` is the **effective** identity `{ timeoutMs, timeoutSource,
forceExit: true, nodeVersion }`, which is part of the measurement's
configuration and of its check identity. Each batch is recorded **when it is
launched**, from the argv the spawn boundary was given: its resource class, its
files, the lanes it ran at (the `--test-concurrency` it carried), the Node
executable and version, the timeout Node was handed, and the argv with reporter
destinations masked (they are ephemeral). A run a stall or an interrupt cuts
before it returns still says what it launched.

A green receipt needs `executionComplete` (`src/mc/gate-greens.js`): the
requested flags state exactly the identity's timeout (none, for `default`); every
batch's argv carries that one timeout, the same Node version and the forced exit,
with the requested flags before its file paths; and the files the batches ran are
exactly the files the attempt ran itself. A run that ran no test file needs no
batch, so command-only runs are unaffected. Reused members need no batch of this
attempt, and name the run that passed them. A mismatch, a missing batch, a changed
Node or a missing identity is incomplete: never reusable green, never resumed
from, never published. Earlier greens (measurement version 4 and below, bound or
unbound) are not read; `GATE_MEASUREMENT_VERSION` is 5.

The identity excludes what load decides (the lanes) and what is ephemeral (the
reporter paths). It includes the Node version: a green measured by another Node
is measured again. Local measurements were made on Node v24.10.0; other
supported versions were not exercised.

**Declared, invalid and partial timeouts.** Declared flags that state more than
one `--test-timeout`, or one that is not a positive integer (`0`, `Infinity`, a
word), refuse before any test is spawned, and name the file and the values.
A script timeout that is not a positive integer is not a declaration: it is
dropped and the default applies. A script with two timeouts is refused like
declared ones. A declared array that states no timeout takes the default, not the
script's timeout. A repository's declared timeout is still a default for each
test, not a cap: a test that gives its own `{ timeout }` may run longer, and this
is not an exception the round grants or detects.

**What the timeout means in time.** `--test-timeout` bounds each test callback
and each hook from when it starts. It does not bound a file's startup (module
loading, top-level `await`), which is outside every callback clock, nor the
whole file, batch or round: the session has its hard ceiling; a merge round
has the no-progress stall detector and the last process bound. Synchronous JavaScript
that does not yield cannot be interrupted by any timer, so a blocked callback is
measured as long as it ran, not cut at its limit. None of these is an absolute
synchronous CPU cap, and no repository scanner enforces that every explicit
per-test timeout is at most the default.
A session's test cut at the stall guard remains red, with its name and cut
limit for rebuilding. A merge round instead treats that cut as unmeasured and
runs the file in its alone phase with the 600 s never-ends bound; `retry_once`
is the separate policy for declared assertion failures. The declaration floor
above governs declarations and the suite, not the alone override.

**The slow-test indicator is 1 s per test** (`SLOW_TEST_MS` in
`src/mc/test-times.js`, not configurable per repository). Every passed test a
session's `mc gate` or a merger round measured over it is listed as slow, with
its file, name and seconds, slowest first, at most 20 named and then a count
(`slow_tests` in `--json` and the round report). A slow test never changes the
verdict, the exit code or whether the merger lands: a new or changed test over
it is rebuilt, or its pull request says why its cost is warranted and review
judges that.

**A slow or cut test is kept in `~/mc/runner/too-slow/<repo>.tsv`**
(`recordTooSlow` in `src/mc/test-times.js`). Every run that measures times — a
session's `mc gate`, `mc test`, `mc publish`'s round and the merger's — reads
the reporter's lines after the run and writes the tests node cut
(`test timed out after <n>ms`) and the passed tests over the 1 s slow-test
indicator: one row per test with its file, its name, when it was first and last
seen, where (the pull request, `full`, or `gate`) and the limit — the cut limit
for a cut row, 1000 for a slow row. A file written before slow rows existed is
read as it is. A test already there keeps its first-seen time; one that passes
under its row's limit in a later run is removed. The file is written whole
or not at all, and a write that fails never turns a round red. The limit is
the repository's `--test-timeout` (`pr_tests_flags` in
`src/mc/repo-gate-table.js`; memoro-cli's is a ratchet on its way from 30 s
to 1 s, lowered as its slow tests are rebuilt): node cuts the test, not its
describe block, and the round goes on with the rest.

**A project log with a row twice is red.** Once the candidate is built, before
its dependencies or its selection, the round reads the candidate's `docs/project/project_log.md` (`duplicateRow`,
`archive-plan.js`) and, when two rows share date, programme and project, stops
with `stopped_at: 'project-log'` — a red, the change's to fix — and the reason
`project_log.md carries the same row twice: <date> <programme> <project> —
delete the copy and push`. memoro's `.gitattributes` merges that file
`merge=union`, which keeps both sides of a conflicting hunk: on 2026-10-10
memoro's main carried one row five times, each copy from an execution branch that
merged main in. A batch that stops this way falls back to single rounds
(`FALLBACK_STOPS`), so the pull request that brought the copy is the one turned
red. The archive's `appendRow` is the other half: given a log that already has
a row for that programme and project, it returns the text unchanged.

`gateLines` in [`src/mc/commands/repo.js`](../../src/mc/commands/repo.js) builds
them; [`tests/mc/commands/gate-verdict.test.js`](../../tests/mc/commands/gate-verdict.test.js)
asserts the length as a number, so the prose cannot grow back quietly.

## One pull request, and nothing else

A round has exactly one subject: the pull request (or the batch) named on the
command line. It touches no other branch.

Until 2026-08-30 a green round ended by freshening **every open pull request on
the repository** — merge the new main into each, pushing, and writing a line
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
own place, with no attempt counted. A command gate running at that
moment is waited out, not killed. A batch round is not watched, since
`MERGE_BATCH_MAX` is 1. On 2026-10-24 memoro #14169's round ran 13 minutes
after its pull request had been merged on GitHub; the minute of asking is what
ends such a round now.

**`mc merge` waits for neither — the merger does** (ruling 30, 2026-10-09).
`mc merge <repo> <pr>` writes the job
into `~/mc/runner/merges.json` (`repo`, `repo_path`, `pr`, `branch`,
`holder`, `goal`, `sha`, `since`, `state`) and returns at once, saying its place in
line. One process lands the jobs, oldest first, one at a time: the merger
([`src/mc/merger.js`](../../src/mc/merger.js), started detached by the first
`mc merge` that finds none, its pid in `~/mc/runner/merger.json`, its output
in `~/mc/runner/log/merger.log`). It marks a job `landing`, waits while the
gate lock or the job's repository lease is somebody else's (an orphaned lease
is nobody's: the round's own claim reaps it), runs the round as the holder
who asked, records it, notifies the goal, drops the job, and takes the
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
holds, and the successor skips the `landing` entries whose
`merger` pid is alive. Measured 2026-10-17 → 24: 76 handovers
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

**Goals, not an execution register.** A review or finish session sends all of a goal's
registered pull requests to merge. Phases hold later goals back until lower phases are done
or dropped; there is no chain of execution branches for the merger to restack.
The queue orders runnable jobs by arrival within each repository lane.

**The merger is the installed mc** (ruling 37, 2026-10-10). `startMerger`
spawns `merger-run.js` from the checkout the `mc` on PATH resolves to
(`installedMergerRun`), never from the caller's own tree, and the first line
of every merger reads `merger <pid> started — ~/memoro-cli at <sha>`. On
2026-10-10 the merger that served 17:47-18:00 had been started by a build
session from its workarea and ran that branch's code, with batches and
without lanes.

## The async round, SIGTERM and where a red goes

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
answered landed`), dequeued and its goal notified; a CLOSED one is red by itself
(`closed on GitHub`). Both leave the batch, and the rest are measured without
them. Red rows are looked at too, at start and then every `SWEEP_MS` by an
idle loop (`sweepMergedReds`): a red whose pull request has since merged is
dequeued and its goal notified; a closed one leaves the queue. On 2026-10-10 a
hand-merged #13372 turned #13373 and #13374 red with its reason, and #13370
stayed red in `merges.json` after its `--admin` merge.

A job answered before the round — merged, closed, or a reviewed head moved — is
written to `merges.json` the moment it is answered (`landJob` tells `serve`'s
`writeAnswer` through `onAnswer`, after the goal is notified and outside
any lock), so the page and `mc merge watch` never draw it as landing while
the others' round runs. On 2026-10-10 #13400 (closed) and #13397 (a restack
conflict) read `landing` for the whole 9-minute round of #13375 and #13405.
The block after the round writes only what `onAnswer` did not: a round that
threw.

**Where a red goes.** Main's red found by the round is not a red answer: the
round went on past it and the merger queued a goal-less main-red mend
(*The merge judges the pull request against main*). A red answer is red at once, whatever stopped the
round. On a goal's pull request the goal stays in `merge` with the runner's `merger
answered red on #<pr>` entry (`tellGoal`). Failure one or two sets
`merge · blocked` and wakes mend; its completed repair returns `merge · ready`
for delivery again. Failure three sets `merge · Martin`
([`mc-goals.md`](mc-goals.md) § *Finish and mend*).
A pull request is a goal's when the job carries the goal (its review's `mc goal stage merge`
queued it) or when the goal's `prs` name it (`goalOfJob`): one a person or
`mc publish` queued is answered in its goal as well. Landed, it sets the goal
`done` only when the goal carries no other pull request; otherwise the landing
is an entry and the runner sets `done` once the rest has landed
([`mc-goals.md`](mc-goals.md) § *Done when its work has landed*).

Until 2026-11-02 a red the change itself caused got one *mend* first: a
headless session of its own on the branch, while the entry stood `mending`
(ruling 37). The goal `headless-plan` removed it (Martin, 2026-11-02: a red
goes to the session that has the whole picture): `src/mc/mend.js`,
`canon/roles/mend.md`, the merger's mend line and `mc publish --branch` are
gone. A `mending` entry an older merger left in `merges.json` reads as
`queued`, and the next round measures the branch as it stands. `mend` rows in
`runs.tsv` are from before.

**The merger leaves for new code.** On 2026-10-18 a merger served 5 h 22 min
on 3b51ff90 while seven mc pull requests landed, because it read its commit
once and left only on an empty queue. Since then `serve` in
[`src/mc/merger.js`](../../src/mc/merger.js) reads its checkout's HEAD before
each batch. A HEAD past the commit it started on releases `merger.json` and
calls `handover` at once, between rounds: `merger-run.js` starts its successor
through `startMerger` while jobs remain in line (`succeed`), and this merger
takes nothing more. The rounds it holds finish, and the successor takes every
other job in both lanes. A SIGTERM starts none; it
finishes what it holds, as before. The next
`mc merge` starts one when none lives. `mc merge watch` adds
`merger on <commit> · main <commit>` to its line while the merger's commit
and the installed checkout's HEAD differ.

**Every red says exactly what did not pass, and nothing is run again to find
out** (Martin, 2026-11-10). Every stop that is a failure — `red`,
`selected-gate`, `extra-gate`, `pr-tests`, `stalled`, `prepare`, `derived` and
the rest, all but the stops that measured nothing (`NO_DETAIL_STOPS`: lease,
gone, offline, moved, dropped, fetch, pr) — writes the file below, and the
merger says its lines into `merger.log` under the pull request's label (at
most 400, naming the file that has all of them). Each red test keeps its whole
error and stack (`detail`, at most 400 lines a test, from `redTests`), beside
the six display lines (`error`) the reason uses. A failed command gate keeps
its selector id, command, exit, signal and time; its whole stdout and stderr
in a file of the round's own (`<work root>/runner/gate-output/<repo>-<prs>-<time>/<gate>.log`,
`output_path`); and what failed in it (`failure`, `command-failure.js`): its
red tests when it printed TAP, node's spec reporter's `✖ failing tests:`
section verbatim when it printed one, else its last 150 lines. The reason
names a failed gate's red tests too. Until 2026-11-10 a red test kept six
lines of its error — memoro's `subject-context` red showed two lines of a
deep-equality diff — and a failed command gate kept `stderr || stdout`
trimmed and wrote no file: memoro#15149's `test:browser-contracts` left
`exit 1` and a warning.

**What a red round keeps** (ruling 44). Every round that finishes failed writes
its failures to `~/mc/runner/merge-red/<repo>-<pr>.txt`
([`src/mc/merge-red.js`](../../src/mc/merge-red.js)): one file per pull
request, a batch's from each one's own fallback round. The next red overwrites
it and a landing removes it. The file holds, per red test, its file, its name,
where it failed and its whole error; the pull request's own red tests; and
each failed command gate as above, at most 6000 lines in all. The
gate cuts these blocks out of the suite's TAP and out of the selected files'
TAP (`redTests` in [`src/mc/tap-red.js`](../../src/mc/tap-red.js)) after the
killed and cancelled files are taken out of the red. The path is on the report
as `red_detail`, and it goes into the round's `gate-rounds.jsonl` line with
`red_files`. The goal's mend session reads the merger's reason and this red file, then
reruns the named files with `mc gate <files> --test-name-pattern '<names>'`,
not the whole suite (ruling 52). A merge round keeps the gate's verdict under `gate`;
`runMergeRound` lifts `red_files` and `main_red` up to the top when the gate
stops, so a reader of the report's top finds them.

**Previous red first** (ruling 44 § 2). When a pull request's last
`gate-rounds.jsonl` line ended `red` with `red_files`, the next single round
runs those files alone on the prepared candidate in a timed phase
`previous red` before the selection: still red stops it `red` there, with the
standing-evidence lookup as for any red, and all green says `previous red files green —
measuring the selection` and goes on as before (`previousRedFiles` in
[`src/mc/repo-gate.js`](../../src/mc/repo-gate.js)); a batch skips it.

## The full run nobody asks for

The runner runs `mc test <repo> --full` **once a day** for each repository mc
knows whose origin/main has moved since its last measured full run, with nobody
typing anything, **beside all other work** (Martin, 2026-11-13). On mc-server
(12 cores, 31 GB) Martin ruled that the daily whole suite runs in parallel with
all sessions and merges, and that it stays once a day; a run started by hand is
an exception.

It is a **chore of the runner** (`runNightly` in `src/mc/run.js`, the last
thing a chore pass does), implemented in
[`nightly-loop.js`](../../src/mc/nightly-loop.js). Until 2026-09-19 it was a
detached process of its own, started with `mc test nightly start`, with a pid
file and a `stop`, and that scheduler is gone — there is nothing on this
machine that can start a full run but the runner. The verb that is left is
`mc test nightly status`; it is under `mc test` because that is the round a
full run is. It was `mc repo nightly` until 2026-09-04, which now prints
`mc repo nightly is now mc test nightly` and exits 2. The file names, the round
log's `mode: nightly` and the history under `~/.memoro/mc/nightly/` keep the old
word, because the pages read them.

It exists because memoro's whole suite ran only when a person typed `npm run
test:full`, and #10529 is what that produced: four days of merges left 31 tests
red on `main` while every pull request's affected-selection passed, because
nothing ever looked at the whole.

The landing chain supplies PR rounds' evidence; the full run remains the
whole-suite meter and writes `from: full` with every file it ran and no
inheritance when it completes.

It is a **meter**, and the word is load-bearing (ruled by Martin, 2026-09-02):
nothing it finds refuses a merge, delays a round or changes a verdict. It never
commits, never pushes, never writes inside a repository and never takes a
branch. Everything it writes is under mc's home —
`~/.memoro/mc/nightly/nightly.log` and the per-repository history beside it —
and under `<work root>/gate/<slug>/full`, its own checkout. It is optional in
the one way the runner is: no runner, no full run.

- **The round is the same round.** Not a copy, and not `npm run test:full`
  directly: it calls `runGate` with the `full: true` a person's `--full` passes,
  so the scheduled reading and the asked-for reading cannot disagree about what
  a repository's whole suite is. Every run is counted in `gate-rounds.jsonl`
  like any other round, so `mc repo rounds` stays true about what this machine
  did.
- **When: once a day, and only a main that moved** (`nightlyDue`, then
  `fullRunDue`). A day after the last chore pass that started a run, the pass
  reads origin/main of each repository with `git ls-remote origin HEAD` and compares
  it with the commit of the last run that measured something. Equal: the tree
  is the one already measured, so nothing runs and **nothing is written** — a
  branch that has not moved is not measured again, and a line per chore pass
  would push the measurements out of the history. A repository never measured
  is due. A head that cannot be read is measured, but not again within
  `FULL_RUN_RETRY_MS` (an hour) of the last attempt, so an offline machine does
  not start a suite every pass. The day is `NIGHTLY_INTERVAL_MS`.
- **One at a time per repository.** The runner keeps one map of the runs in
  flight across chore passes; a repository with a run in flight is not started
  again. A run that ends starts nothing after it: the next is the next day's.
  Repositories run in parallel with each other. A repository the board lists under two paths is
  measured once, under the first.
- **A run that stopped on a commit waits for main to move.** A suite that
  stalled, could not be prepared, or did not reach its summary will do the same
  on the same tree, and retrying it would pin cores in a loop. A stop that is
  the machine's (`fetch`, `threw`, `worktree`, `lease`, `reservation`, `busy`,
  `base`, `pr`) is tried again after `FULL_RUN_RETRY_MS`. A run the runner cut
  short itself (`gone`, `killed`) is due again at once.
- **Beside the merge lane.** A full run takes no round lock (`gate-lock.js`),
  writes no phase into the lane's lock file and takes no lease: the lease is held
  by holder name, so the runner's run would give back the merger's lease under
  the same name, or keep the merger out under another. It measures in its own
  standing checkout, `<work root>/gate/<slug>/full` (`FULL_RUN_CHECKOUT`,
  `measurementCheckout({ name })`), never in the merger's `candidate`. Merges,
  sessions and full runs of the same repository therefore proceed at once
  (`runGate({ isolated: true })`). A person's `mc test <repo> --full` is
  unchanged: it is a round in the lane, in `candidate`.
- **Two test lanes** (`FULL_RUN_LANES`, `MC_FULL_RUN_LANES` overrides). Fixed
  rather than answered from the load, so a run's length does not depend on when
  it started. Two is the floor `testLanes` keeps for a session's gate at any
  load, and half `MERGE_LANES_MIN` (4), which a merge round is guaranteed: a
  full run and a merge round in each of the two repositories at once take
  2 × (2 + 4) = 12 lanes, the cores of mc-server, before any session's gate. A
  full run is a meter nobody waits for, so it is the one that is slower. The
  lanes reach the suite as `MC_TEST_LANES`: memoro's runner reads it, and
  memoro-cli's `npm test` passes it as `--test-concurrency` when it is set
  (node refuses `--test-concurrency` in `NODE_OPTIONS`).
- **Its reds go to a main-red mend.** A measured run's red on main is main's by
  construction. The round records it as exact-commit evidence
  (`recordMainRed`, `from: full`), and the run hands the red files and tests to
  `requestMainRepair`, the door a merge round's main red goes through, which
  queues a main-red mend session. A red test never becomes a goal (Martin,
  2026-11-13).
- **STOP reaches it.** A chore pass that finds `~/mc/runner/STOP` or `UPDATE`
  starts no run. Before the runner leaves, the chore loop ends
  the runs in flight through their round's signal and waits for them
  (`settleFullRuns`), so no suite outlives the runner; each is written
  `stopped at gone` and is due again for the runner that comes next. The
  runner's own `--once` runs no chores and so no full run. `runs.tsv` gets a
  `kind: nightly` row only for a chore pass that started a run.
- **Three outcomes stay apart.** A run that found nothing, a run that named
  failures, and a run that produced no suite result at all — the preparation
  failed, the declaration stopped it, the process died, it stalled. The third is
  not zero failures, and a day of them reported as a green streak would be the
  same false green `--full` was fixed to remove, arriving by another road.

### A whole suite's progress

The round's stall watchdog (below, *no progress* for `ROUND_STALL_MS`) reads
forward motion from the test-times reporter: a test file finished. A whole
suite run through `npm test` is one `node --test` process, and node reports its
files in the order it was given them, holding every later file's events until
the earlier files have reported; a file is not even reported as started until
one of its tests has ended. So a slow file ahead hides every file finished
behind it, and the watchdog cannot name it. memoro's runner
(`scripts/testing/runner.mjs`) strips inherited reporter flags from
`NODE_OPTIONS`, so for memoro the reporter shows nothing at all.

Measured on mc-server, 2026-11-13: every full run since the move stopped
`stalled — no progress for 15 min — files in flight: none named`. memoro's ran
864 s of suite and was stopped at 900 s from the round's start, the reporter
having shown nothing. memoro-cli's reporter showed 91 files finished within
15 s and nothing for the next 900 s: `tests/mc/logger.test.js`, next in order,
never ended, because `mkdirSync('/proc/definitely/not/writable',
{ recursive: true })` does not return on Linux (node 24), and no timeout can cut
synchronous code. Its fixture now uses a directory under a regular file.

So `realSuite` gives every test file's process a heartbeat: `--import` of
`test-progress-preload.mjs` in `NODE_OPTIONS` (which memoro's runner keeps)
writes one line when a test file's process starts and one when it exits, to a
file named in `MC_TEST_PROGRESS`, whatever the reporter is still holding back
(`processProgress`, `progressTracker().processes()` in `test-times.js`). A file
process that exited is progress; the files whose process is running are the
files in flight the `stalled` reason names. The window is unchanged. The first
stall's reason is kept: later polls do not rewrite it.

### Red, and since when

The number that would have prevented #10529 is not "31 tests are red". It is
"these 31 tests have been red since Tuesday": one run's red list looks exactly
like a flake, and the same list twice, dated, does not. So every full run appends to
a bounded history per repository under `~/.memoro/mc/nightly/` — when, which
commit of the branch, and the failing test *names* — and `mc repo status` reads
it back:

```
    full run   4h ago  8 red of 17,982  fc19465
               red since 2d ago (3 runs)  data-bus event names…  +7 more
```

`mc test nightly status` prints those same rows, one block per repository the
full runs measure, under a header that says where they come from — the runner
running (with when it last started one), the runner stopping, or the runner
stopped and no full run therefore coming until `mc run start` — the same
`nightlyRows` called rather than copied, so the two pages cannot answer "red,
and since when" differently. `--json` carries `runner` (`running`, `pid`,
`started_at`, `stop_requested`), `cadence` (`main-moved`), `tick`
(`last_started`, `detail`), `log`
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
  gone green and broken again. The bound is the number of runs kept — fifty
  (`HISTORY_LIMIT`), raised from fourteen on 2026-11-13, when a run began to
  follow every move of main instead of once a day.
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
