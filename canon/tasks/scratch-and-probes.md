---
name: scratch-and-probes
description: Where files that are not the change go in mc — probes, output, body files, scripts — and how to run mc's own code from a worktree without writing Martin's state. Use before writing a file outside the change, or running node src/mc-cli.js or an mc function by hand.
---
# Scratch files and probes

Files that are not the change — probes, output, a PR body, a script — go in `$MC_SCRATCH`, never the worktree.
Initialize once; reuse this root throughout:
```sh
MC_SCRATCH="${MC_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/mc-probes.XXXXXX")}" || exit 1
export MC_SCRATCH
```
A probe that runs mc's own code from a worktree — a review trying a branch, the page drawn from it, a runner function
called by hand — sets `MC_HOME="$MC_SCRATCH/mc-home"` and `MC_WORK_ROOT="$MC_SCRATCH/mc-root"` first. Reading mc's
state can write it (a migration, a heal), and without them it writes Martin's: `~/.memoro/mc/lanes.json` was rewritten
that way on 2026-11-02 and the running runner dropped to one lane per repository.

For a worktree's `mc skills sync` or `mc hook install`, also isolate `HOME` and `CLAUDE_CONFIG_DIR` under that root; otherwise
it writes `~/.claude`/`~/.agents`.

## Independent fault replay

For a commissioned source fault, replay in the goal's own worktree — the one checkout of the goal branch, `goals/<goal>/<repo>`.
No step adds a git worktree or any other checkout. Name the judged SHA, the worktree and the source file, then record HEAD and status:
```sh
sha=<judged-sha>
reviewed=<goal-worktree>
source=<source-path>
git -C "$reviewed" rev-parse HEAD
git -C "$reviewed" status --short
```
Stop unless HEAD equals `$sha` and the status is empty. A dev server the goal started is stopped first with `mc dev stop <instance_id>` (`mc dev list` names it), before the cwd check below; `mc shot dev` restarts it afterwards. Stop too if another process stands in the worktree:
`lsof -a -d cwd -Fpn` lists each process with its working directory, and the only one in `$reviewed` may be this
session's own shell. Then save the source before the fault and record the pre-replay state:
```sh
before=$(git -C "$reviewed" rev-parse HEAD)
cp "$reviewed/$source" "$MC_SCRATCH/source-before"
```
Apply only the commissioned deliberate delta to `$source`, then save and inspect it:
```sh
git -C "$reviewed" diff -- "$source" > "$MC_SCRATCH/fault.patch"
git -C "$reviewed" status --short
```
`status --short` must list only `$source`. Record the changed path and the before/after source. Run only the
commissioned check from the worktree: `mc gate <test-files…>`. Record its printed full log path and the observed
assertion failure. Import/setup failures are insufficient: the relevant assertion must fail. An invocation-local
loader is an alternative only with guards for its target URL and exact source match. Record both guards, source
identity and activation. If the source guard fails, stop; never fall back silently. Keep loader and output in
`$MC_SCRATCH`. Restore the source (or remove the loader), then verify the worktree is back at the judged HEAD with a
clean status:
```sh
git -C "$reviewed" checkout -- "$source"
git -C "$reviewed" diff --exit-code
test -z "$(git -C "$reviewed" status --short)"
test "$(git -C "$reviewed" rev-parse HEAD)" = "$before"
```
Rerun the corresponding normal `mc gate <test-files…>` and record its log and green result. Repeat the HEAD and status
checks after it. mc-code probes also isolate `MC_HOME`/`MC_WORK_ROOT`; skill-install probes isolate `HOME`/`CLAUDE_CONFIG_DIR`
above. This is bounded evidence, not a mutation framework or repeated full-suite requirement.

## Gate-code goals

A goal that changes gate worker code (`src/mc/session-gate-run.js`, `repo-gate.js`, `test-times*.js`) cannot prove itself end to end with `mc gate`, which spawns the installed `~/mc/self` worker, main's code, not the branch's. Its end-to-end checks run through tests that import the branch's `src` (for example `realTests` in `tests/mc/repo-gate.test.js`), or through `node <worktree>/src/mc/session-gate-run.js <copied request.json>`, and the evidence names which was used.
