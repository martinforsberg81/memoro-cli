---
name: scratch-and-probes
description: Where files that are not the change go in mc — probes, output, body files, scripts — and how to run mc's own code from a worktree without writing Martin's state. Use before writing a file outside the change, or running node src/mc-cli.js or an mc function by hand.
---
# Scratch files and probes

Files that are not the change — probes, output, a PR body, a script — go in
`$MC_SCRATCH`, or the system temp directory when it is unset. Never the
worktree.

A probe that runs mc's own code from a worktree — a review trying a branch, the
page drawn from it, a runner function called by hand — sets
`MC_HOME="$MC_SCRATCH/mc-home"` and `MC_WORK_ROOT="$MC_SCRATCH/mc-root"` first.
Reading mc's state can write it (a migration, a heal), and without them it
writes Martin's: `~/.memoro/mc/lanes.json` was rewritten that way on 2026-11-02
and the running runner dropped to one lane per repository.

The same holds for a home: a worktree's `mc skills sync` or `mc hook install`
writes `~/.claude` and `~/.agents` unless `HOME` (and `CLAUDE_CONFIG_DIR`)
point into the scratch directory.

## Independent fault replay

For a commissioned source fault, keep the reviewed worktree read-only. Before
replay, record its `git rev-parse HEAD` and `git status --short`; require the
prompted judged SHA and a clean status. Start a disposable scratch worktree at
that SHA, never current `main`:

```sh
sha=<judged-sha>
reviewed=<reviewed-worktree>
scratch="$MC_SCRATCH/fault-replay"
git -C "$reviewed" rev-parse HEAD
git -C "$reviewed" status --short
git -C "$reviewed" diff --exit-code
git worktree add --detach "$scratch" "$sha"
git -C "$scratch" rev-parse HEAD
git -C "$scratch" status --short
```
Stop unless both worktrees are clean and scratch HEAD equals judged SHA. Put
only the commissioned original/deliberate delta and all logs in `$MC_SCRATCH`.
Capture source-before (`git -C "$scratch" show "$sha:<source-path>" >
"$MC_SCRATCH/source.before"`) and delta (`git -C "$scratch" diff --
<source-path> > "$MC_SCRATCH/fault.patch"`); inspect and record the changed
paths and before/after source. Run only the commissioned check with `mc gate
<test-files…>`. Record its printed full log path and observed assertion
failures. Import/setup failures are insufficient: the relevant assertion must
fail.
An invocation-local loader is an alternative only with guards for its target
URL and exact source match. Record both guards, source identity and activation.
If the source guard fails, stop; never fall back silently. Keep loader and
output in `$MC_SCRATCH`.
Restore source/remove loader. Verify source matches saved original (`git -C
"$scratch" diff --exit-code "$sha" -- <source-path>`) and scratch diff is
empty; rerun the corresponding normal `mc gate <test-files…>` and record its
log and green result. Repeat HEAD/status in both trees and compare reviewed
values to the saved pre-replay values. Leave reviewed tree untouched. mc-code
probes also isolate `MC_HOME`/`MC_WORK_ROOT`; skill-install probes isolate
`HOME`/`CLAUDE_CONFIG_DIR` above. This is bounded evidence, not a mutation framework or repeated full-suite requirement.
