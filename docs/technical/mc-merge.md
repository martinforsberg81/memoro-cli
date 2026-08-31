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
  without a suite, because there is nothing to run.

`mc repo merge` is gone rather than aliased: it prints *mc repo merge is now
mc merge* and exits 2, and it is in neither `mc repo`'s usage nor `mc --help`
([`src/mc/commands/repo.js:53`](../../src/mc/commands/repo.js)).

## Why the second form exists

A plan PR is the deliverable of `mc plan` and of the runner's triage. It touches
only `docs/project/`, so the gate would build a worktree and run a suite to
learn nothing. Before `--docs` it did not even do that — it waited for Martin
to click Merge, and until it merged the runner could not see the plan at all,
because the runner reads plans from `origin/main`. Martin, 2026-08-26: *"inte
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
mc merge <repo> <pr> --docs [--json]                docs-only: no suite, squash
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
that merges a red gate.

## The docs form

[`src/mc/docs-merge.js`](../../src/mc/docs-merge.js), about eighty lines, is the
whole of it. It takes a repository path and a number and:

1. reads the pull request with `gh pr view --json number,title,state,isDraft,baseRefName,files`;
2. refuses a pull request that is not `OPEN`, a draft, one that changes no
   files, and one whose file list holds **any** path outside `docs/` — naming
   that first path, so the reader knows what to do instead;
3. waits for GitHub's mergeability, up to twelve five-second turns, because
   `UNKNOWN` for a few seconds after a push is normal and merging then fails for
   no real reason; `CONFLICTING` is a refusal that says which base to merge in;
4. squash-merges with subject `<title> (#<n>)`;
5. reads the state back and refuses to claim a merge it cannot see — a `gh` call
   that returned an error after the merge had in fact happened is `merge-unknown`,
   not a silent success;
6. prints one line: what merged, into what, as which commit, and how many files
   under `docs/` it was.

**The file list comes from GitHub, never from a local diff.** A stale checkout
must not be able to make a code pull request look like documentation, and the
one thing this form must never do is land a file the suite would have had an
opinion about.

What it does *not* do is as much of the design as what it does: no lease, no
worktree, no suite, no model, no deploy pull, and no line in the repository's
human merge log. A docs merge is a `gh` call with a check in
front of it.

It does leave a line in the round log
([`src/mc/repo-round-log.js`](../../src/mc/repo-round-log.js)) with `mode: docs`,
alongside `merge` and `check`. Every round mc runs is countable, including the
ones that did not run a suite.

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
conflicting one are each refused. Then the verb itself: `--docs` with a batch and
with `--check` refused before `gh` is asked, the round run on the resolved
repository, and `mc repo merge` pointing at `mc merge` while `mc --help` no
longer mentions it. The gate form's argument errors live with the gate, in
[`tests/mc/repo-merge.test.js`](../../tests/mc/repo-merge.test.js) and
[`tests/mc/repo-gate.test.js`](../../tests/mc/repo-gate.test.js).

## What the round measures

Not "the suite", necessarily. A repository may declare `select` in the gate
table ([`src/mc/repo-gate-table.js`](../../src/mc/repo-gate-table.js)): a command
printing JSON with a `files` array, run in the candidate worktree. With one, the
round measures the test files the change reaches; without one, the whole suite,
exactly as it always did.

**One tree, and the verdict is its own red.** Ruled by Martin on 2026-08-31: a
round evaluates the diff, and whether main was already red is not the round's
question. Until then the round built a second worktree at the base, ran the same
file list there, and called the difference the verdict — half the wall clock, a
second `npm ci` and four modules of machinery (`repo-baseline-cache.js`,
`compareRed`, the red ratchet) to answer a question a merge does not ask. All of
it is gone.

What that buys and what it costs are the same sentence: a test the change
reaches that is **already red on main** now makes the round red, and cannot land
until that test is green. The differential form let it through, at the price of
measuring main every round to find out. The repair is a selector that reaches
fewer unrelated tests, and it belongs in the repository rather than in a second
measurement here.

An empty selection stops the round: it is not a measurement, and a green from it
would be the most confident kind of nothing.

**`mc test <repo> --full`** is the other reading, and the only one that is about
the code rather than about a change: the repository's declared suite command,
run once on the default branch as `origin` fetched it, reporting its red names.
It is asked for, never scheduled. Measured 2026-08-31 on memoro-cli at `8a34a0d`
— 2468 tests, 23 failures, 28 red names, 107.4 s. Every round used to compute
that on the way past and report it as `standing_red`, which is how it came to be
believed and never checked.

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

## One round at a time

Two leases, and between them a merge round cannot overlap another:

- **the repository lease** — one round per repository. A second `mc merge` on
  the same repository is refused by name, with who holds it and for what.
- **the suite right** — one full suite on this machine, whoever holds it. Two
  rounds on *different* repositories therefore cannot both be measuring at
  once; the second stops at `suite-lease`.

Both carry the holder's pid, so a round that was killed rather than finished
is reaped by the next claim instead of blocking forever. Neither blocks git:
they refuse `mc`, and nothing else.
