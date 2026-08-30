# mc test and mc merge — one measurement, two doors

A pull request lands through `mc merge <repo> <pr>`, and through nothing else.
It is measured by `mc test <repo> <pr>`, which is the same round stopping at the
verdict. There is one implementation: `mc merge` runs `mc test`'s round and then
lands what it cleared. A second implementation is the thing this arrangement
exists to prevent — two measurements drift, and the one that drifts is always
the one the merge trusted.

The verb has two forms, and which one runs is decided by what the pull request
touches:

- **the gate round** — lease, fresh baseline, a candidate with main merged in,
  what the change reaches measured on both, squash. This is what `mc repo merge`
  was; only the name moved.
- **`--docs`** — a pull request whose every file is under `docs/`, squash-merged
  without a suite, because there is nothing to run.

`mc repo merge` is gone rather than aliased: it prints *mc repo merge is now
mc merge* and exits 2, and it is in neither `mc repo`'s usage nor `mc --help`
([`src/mc/commands/repo.js:53`](../../src/mc/commands/repo.js)).

## Why the second form exists

A plan PR is the deliverable of `mc plan` and of the runner's triage. It touches
only `docs/project/`, so the gate would build two worktrees and run a full suite
to learn nothing. Before `--docs` it did not even do that — it waited for Martin
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
mc merge <repo> <pr> [<pr>...] [--check] [--json]   the same round, then squash
mc merge <repo> <pr> --docs [--json]                docs-only: no suite, squash
```

`--docs` with several pull requests is refused (it lands one at a time), and so
is `--docs --check` — there is no measurement to stop at. Both refusals happen
before `gh` is asked anything
([`src/mc/commands/merge.js`](../../src/mc/commands/merge.js)).

## The gate form

Unchanged, deliberately: `mc merge` calls the same `gate()` in `repo.js`, which
calls the same `runGate` and `runMergeRound`. The round, its lease, its two
throwaway worktrees, the by-name comparison of red sets at every depth, the
deploy pull, the freshening of open branches and the merge-log line are all
described where they live —
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
worktree, no suite, no model, no deploy pull, no branch freshening, and no line
in the repository's human merge log. A docs merge is a `gh` call with a check in
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

Measured 2026-08-29 in memoro, four sessions merging. The gate round
measures a candidate for 20–35 minutes and then, before merging, requires
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

**Both sides run the candidate's list.** This is the part worth stating twice,
because getting it wrong is silent. A selection is a function of the diff, so a
baseline asked to select for itself answers "nothing changed" and returns its
mandatory core. A round that let each side choose would compare the change's 56
files against 6, and every red already standing on main inside those 56 would
read as this change's doing. The list is asked for once, on the candidate, and
run on both.

A selected file that exists only on the candidate — a test the change adds — is
run there and reported as absent on the baseline rather than faked. An empty
selection stops the round: it is not a measurement, and a green from it would be
the most confident kind of nothing.

### What it cost before

Measured on memoro #11104 (2026-08-30), landing two markdown files and a test:

| step | time |
|---|---:|
| `npm ci`, both sides | 15 s |
| suite, baseline | 649 s |
| suite, candidate | 224 s |
| extra gate `msr contract`, candidate | 194 s |

That extra gate globbed exactly the profile the suite already ran, so the
contract suite was bought four times in one round. The same round also reported
`2477 + 9 + 39` tests as **"39 tests"**, because the suite runs in three
processes and `tapTotals` kept the last summary it saw.

Both are fixed: the totals are summed, and memoro declares `select`. A
documentation diff there selects 6 files where it selected 332.
