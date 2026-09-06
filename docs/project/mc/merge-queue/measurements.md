# merge-queue — the live measurement

This file is the instrument, not the result. It exists so that the pull
request the merge lane was asked to land carries something a reader can
recognise a year from now: what the experiment was, and where its outcome is
written.

**The experiment.** `mc merge memoro-cli <this pull request>` is run while
another gate round holds this machine's one gate lock, so the round is refused
at `busy` — the same refusal that turned `mc merge memoro-cli 671` into
fourteen commands in twenty minutes on 2026-09-06. A refused round now writes
the pull request into `~/mc/runner/merges.json`, and the runner's merge lane
lands it with nobody typing again. Nothing else is being measured here: the
diff is this file, so the gate selects no test and the round is as short as a
gate round can be.

**What was true when this branch was cut** (2026-09-06T23:5xZ, from
`~/mc/runner/`):

- the runner is pid 74508, started 2026-09-06T23:41:26Z — the first process on
  code that has the merge lane in it (#679 landed at 23:09Z and wrote the
  `UPDATE` that handed the runner over);
- `mc run lanes` says `2 per repository, 3 in total`;
- `merges.json` does not exist and `held.json` is `[]` — nothing queued,
  nothing held.

**The outcome** — the refusal line, the exit code, the merge lane's own lines
in `runner.log` and GitHub's merge — is in the close-out pull request of this
project (`docs/project/mc/merge-queue/PLAN.json`, step 4) and in the criteria
it flips. The project's architecture is
[`docs/technical/mc-run.md`](../../../technical/mc-run.md) § *The merge*.

## The first attempt landed, which is the other half of the contract

2026-09-06T23:45Z. The gate round meant to hold the lock (`mc test memoro-cli
680`) took 7 s — the selection for a docs-only change is 9 files and 296 tests
— so by the time `mc merge memoro-cli 680` ran the lock was free, the round
was not refused at all, and #680 landed the ordinary way: green in 4 s,
squashed as `856a8e8`, `merges.json` still absent afterwards. That is the
contract's first line measured rather than assumed: **a round that landed
prints what it printed before this project and touches no queue.**

The refusal the project is about needs a gate that is busy for longer than a
docs selection takes, so the second attempt holds it with the repository's
whole suite (`mc test memoro-cli --full`) and queues this pull request against
it.
