---
status: blocked
next: "Blocked until mc-brief step 2 and mc-plan step 1 are on main (they establish canon/roles/ and the foreground launch). Then Step 1 — `mc run` reproduces ~/mc/bin/runner.sh inside mc: queue = ~/mc/queue.md plus every ready PLAN.md on origin/main of memoro and memoro-cli; one fresh headless session per step through the launch adapter (claude -p today; codex exec when the project frontmatter says tool: codex); merge origin/main in, never rebase; reconcile step on conflicts; wait for GitHub mergeability then squash-merge — done when one full round over the real queue runs under `mc run --rounds 1` with the same runs.tsv columns as the shell runner and the shell runner can be deleted."
budget: 150k
needs: []
---

# mc run — the runner, inside mc, tool-agnostic

## Goal

The runner is the one thing that lives all day: it takes the next step of the
next project, in a fresh headless session, and merges the result. Today it
is `~/mc/bin/runner.sh` (bash, ~220 lines) calling `claude -p` directly.
This project moves it into mc so that the tool is a per-project choice
through the existing launch adapter, the prompts are role files in
`canon/roles/`, and the log is something `mc status` can read. Behaviour
stays what the shell runner measured over nights 1–2: one step per project
per round, merge direct, no model in the runner itself.

## Success criteria

- [ ] `mc run [--rounds N|0] [--once] [--merge 0|1] [--idle-sleep S]` with the
      defaults the shell runner has now (rounds 0 = forever, merge 1).
- [ ] Queue = lines of `~/mc/queue.md` (comments and blanks ignored) followed
      by every `docs/project/*/*/PLAN.md` with `status: ready` on origin/main
      of both repos that the queue did not name.
- [ ] Per project: skip if a tmux session `mc-<name>` exists or the worktree
      is dirty; create the workarea with `mc work add <name> <repo> <name>
      --from origin/main` when missing; `git merge origin/main` (never
      rebase); on conflict run a `reconcile` step with the merge left in
      progress; otherwise `triage` when PLAN.md is missing, `step` when
      `status: ready`, and `step` with the answered decision files listed when
      `status: waiting-decision` and any `~/mc/*/decisions/<programme>-*.md`
      or `<name>-*.md` carries a line starting `**Beslut:**`.
- [ ] Session per step: fresh, headless, model from the project frontmatter
      (`model:`, default opus), tool from `tool:` (default claude), role
      overlay `canon/roles/{triage,step,reconcile}.md` + Coding Profile, the
      PLAN.md as the prompt body, wall-clock cap `budget_minutes` (default
      90). Through `resolveLaunch` — no direct `claude` spawn in the runner.
- [ ] After the step: find the open PR for the branch; wait until GitHub
      reports mergeable (poll ≤ 60 s); squash-merge with the PR title as
      subject; on failure merge main in, push, retry once; else leave open
      and log `open`.
- [ ] Log: `~/mc/runner/log/runs.tsv` with the shell runner's columns
      (ts name kind exit seconds pr turns input output cache_read cache_write
      session note) and `runner.log` lines; `--output-format json` usage
      fields are the source for claude, the adapter's equivalent for codex
      (or `-` when unavailable, never a guess).
- [ ] On a quota/rate-limit signal in the step output: sleep 30 min.
- [ ] Tests: queue assembly (file + main scan), status/decision resolution,
      merge-wait logic, and runs.tsv row formatting — all without starting a
      session.
- [ ] `~/mc/bin/runner.sh` deleted in the close-out step, after one night on
      `mc run`.

## Contract

- No model call in the runner. Ever. The model is the step session.
- No inbox, no knock, no watcher. The runner is the parent of the process it
  starts; it needs no liveness guess.
- Never rebase an area branch. Never force-push.
- Merge direct is the policy for both repos (Martin, 2026-08-25). The runner
  does not review; `mc brief` shows Martin what merged.
- Do not import from `src/runtime`, `src/vault`, `src/capabilities`, or the
  old `src/cli` session commands. `resolveLaunch` from `src/adapters` and
  `work-open.js` are the allowed seams.

## Steps

- [ ] **0. Wait** — blocked on mc-brief step 2 and mc-plan step 1 (roles dir,
      foreground launch). Done when both are on main.
- [ ] **1. Verb + queue + one step** — `mc run --once` runs one step for the
      first ready project through the adapter and logs it. Done when a real
      step lands a PR and a runs.tsv row.
- [ ] **2. Merge + reconcile + decisions** — the rest of the behaviour above.
      Done when `mc run --rounds 1` completes a full round on the live queue.
- [ ] **3. Codex** — `tool: codex` in a project frontmatter runs that step
      with `codex exec` through the adapter; usage fields `-` if codex gives
      none. Done when one codex step is logged.
- [ ] **4. Close-out** — one night on `mc run`, delete `runner.sh`,
      `docs/technical/mc-run.md`, `project_log.md` row.

## What the code taught us

(empty — but read `~/mc/runner/log/natt-1.md` first: it records what the
shell runner learned on nights 1–2, including why merges failed and why
rebase was wrong.)

## Documents

- `~/mc/bin/runner.sh` — the behaviour to reproduce, line by line
- `~/mc/runner/log/natt-1.md` — nights 1–2 measured
- `~/mc/mc-utredning/utredning-2026-08-24.md` §9–13 — the design
- `docs/project/mc/mc-brief/PLAN.md`, `docs/project/mc/mc-plan/PLAN.md`
