---
name: scratch-and-probes
description: Where files that are not the change go in mc — probes, output, body files, scripts, a commit's exported files — and how to run mc's own code from a worktree without writing Martin's state. Use before writing a file outside the change, exporting a commit, or running node src/mc-cli.js or an mc function by hand.
---
# Scratch files and probes

Files that are not the change — probes, output, a PR body, a script — go in `$MC_SCRATCH`, never the worktree.
Initialize once and reuse:
```sh
MC_SCRATCH="${MC_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/mc-probes.XXXXXX")}" || exit 1
export MC_SCRATCH
```
A session's `MC_SCRATCH` is its runner scratch directory; only eligible registered exports may be reclaimed when the session ends; the root, receipts, logs, patches, results and all unregistered or changed contents remain protected ([mc-tidy.md § Registered source exports](../../docs/technical/mc-tidy.md#registered-source-exports)).

To read a commit's files, export only the paths you need from the commit you mean: `mc scratch export --repo <repo> --ref <sha> --path <path>…`. It writes the committed bytes, never the working tree, and reuses an unchanged export. Release each one (`mc scratch release <id>` previews, `--apply` removes) before the next. Never export a whole tree per commit in a loop, and never `git worktree add` or copy a `.git` to read a file.

A probe that runs mc's own code from a worktree — a review trying a branch, a page drawn from it, a runner function called by hand — sets `MC_HOME="$MC_SCRATCH/mc-home"` and `MC_WORK_ROOT="$MC_SCRATCH/mc-root"` first. Otherwise it writes Martin's state: `~/.memoro/mc/lanes.json` was rewritten that way on 2026-11-02 and the runner dropped to one lane per repository. A goal that changes gate worker code (`src/mc/session-gate-run.js`, `repo-gate.js`, `test-times*.js`) cannot prove itself end to end with `mc gate`, which spawns the installed `~/mc/self` worker, main's code, not the branch's. Its end-to-end checks run through tests that import the branch's `src` (for example `realTests` in `tests/mc/repo-gate.test.js`), or through `node <worktree>/src/mc/session-gate-run.js <copied request.json>`, and the evidence names which was used.

For a worktree's `mc skills sync` or `mc hook install`, isolate `HOME` and `CLAUDE_CONFIG_DIR` under that root too; otherwise it writes `~/.claude` and `~/.agents`.

An evidence manifest or checksum is written only after every writer of the files it covers has exited, or the completed gate receipt is cited instead.

## Independent fault replay

For a commissioned source fault, replay in the goal's own worktree: the one checkout of the goal branch, `goals/<goal>/<repo>`. Add no git worktree or other checkout. Name the judged SHA, the worktree and the source file, then record HEAD and status:
```sh
sha=<judged-sha>
reviewed=<goal-worktree>
source=<source-path>
git -C "$reviewed" rev-parse HEAD
git -C "$reviewed" status --short
```
Stop unless HEAD equals `$sha` and the status is empty. Stop a dev server the goal started first with `mc dev stop <instance_id>` (`mc dev list` names it). Stop too if another process stands in the worktree: `lsof -a -d cwd -Fpcn` lists each process's working directory; the only processes in `$reviewed` may be the agent, its shell and the processes it runs for the check, matched by pid (the session's agent process is its shell's parent, `$PPID`; it shows as its version string).
Save the source before the fault, then apply only the commissioned deliberate delta and inspect it:
```sh
before=$(git -C "$reviewed" rev-parse HEAD)
cp "$reviewed/$source" "$MC_SCRATCH/source-before"
# apply only the commissioned delta to $source, then:
git -C "$reviewed" diff -- "$source" > "$MC_SCRATCH/fault.patch"
git -C "$reviewed" status --short
```
`status --short` must list only `$source`. For a criterion covering every route or caller, replay one deletion per call site, not one shared-function change: a shared-function fault proves nothing about routes it does not reach. Run only the commissioned check, `mc gate <test-files…>`, and record its printed log path and the observed assertion failure. An import or setup failure is not that: the relevant assertion must fail. An invocation-local loader is an alternative with two guards, its target URL and an exact source match, recorded with the activation; if the source guard fails, stop and never fall back silently. Keep the loader and output in `$MC_SCRATCH`. Then restore and verify:
```sh
git -C "$reviewed" checkout -- "$source"
git -C "$reviewed" diff --exit-code
test -z "$(git -C "$reviewed" status --short)"
test "$(git -C "$reviewed" rev-parse HEAD)" = "$before"
```
Rerun the normal `mc gate <test-files…>` and record its log and green result, then repeat the HEAD and status checks. A rerun that reports `reused` at the judged HEAD with a clean status is valid evidence, since reuse needs identical tree bytes (`findResumable`); use `mc gate --fresh` only when the earlier GREEN is itself in doubt. mc-code probes isolate `MC_HOME`/`MC_WORK_ROOT`; skill-install probes isolate `HOME`/`CLAUDE_CONFIG_DIR`. This is bounded evidence, not a mutation framework or a repeated full-suite requirement.
