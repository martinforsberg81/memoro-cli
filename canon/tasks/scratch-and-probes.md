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
