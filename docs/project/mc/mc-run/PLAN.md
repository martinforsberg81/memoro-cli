---
status: ready
next: "Step 4 — Close-out: `docs/technical/mc-run.md` grown from the lanes note into the whole runner, `project_log.md` row — done when the document describes the runner as it now is (two lanes, archive, close-out, helper, both tools) and the row is on main. Was: Step 3 — Codex: a project whose frontmatter says `tool: codex` runs its step with `codex exec` through the adapter — done when one codex step is logged in runs.tsv with a `codex` launch in runner.log."
budget: 150k
needs: []
---

# mc run — the runner, inside mc, tool-agnostic

## Goal

The runner is the one thing that lives all day: it takes the next step of the
next project, in a fresh headless session, and merges the result. It was
`~/mc/bin/runner.sh` (bash, ~220 lines) calling `claude -p` directly.
This project moved it into mc so that the tool is a per-project choice
through the existing launch adapter, the prompts are role files in
`canon/roles/`, and the log is something `mc status` can read. Behaviour
stays what the shell runner measured over nights 1–2: one step per project
per round, merge direct, no model in the runner itself.

## Success criteria

- [x] `mc run [--rounds N|0] [--once] [--no-merge] [--idle-sleep S]` with the
      defaults the shell runner had (rounds 0 = forever, merge on). The flag
      is `--no-merge`, not `--merge 0|1` — mc's own idiom for a default-on
      boolean.
- [x] Queue = lines of `~/mc/queue.md` (comments and blanks ignored) followed
      by every `docs/project/*/*/PLAN.md` with `status: ready` on origin/main
      of both repos that the queue did not name.
- [x] Per project: skip if a tmux session `mc-<name>` exists or the worktree
      is dirty; create the workarea with `mc work add <name> <repo> <name>
      --from origin/main` when missing; `git merge origin/main` (never
      rebase); on conflict run a `reconcile` step with the merge left in
      progress; otherwise `step` when `status: ready`, and nothing at all for
      any other status. Not `triage`, and not a decision file: see What the
      code taught us.
- [x] Session per step: fresh, headless, model from the project frontmatter
      (`model:`, default opus), tool from `tool:` (default claude), role
      overlay `canon/roles/{step,reconcile}.md` + Coding Profile, the
      PLAN.md as the prompt body, wall-clock cap `budget_minutes` (default
      90). Through `resolveLaunch` — no direct `claude` spawn in the runner.
- [x] After the step: find the open PR for the branch; wait until GitHub
      reports mergeable (poll ≤ 60 s); squash-merge with the PR title as
      subject; on failure merge main in, push, retry once; else leave open
      and log `open`.
- [x] Log: `~/mc/runner/log/runs.tsv` with the shell runner's columns
      (ts name kind exit seconds pr turns input output cache_read cache_write
      session note) and `runner.log` lines; `--output-format json` usage
      fields are the source for claude, the adapter's equivalent for codex
      (or `-` when unavailable, never a guess).
- [x] On a quota/rate-limit signal in the step output: sleep 30 min.
- [x] Tests: queue assembly (file + main scan), status resolution, merge-wait
      logic, and runs.tsv row formatting — all without starting a session.
- [x] `~/mc/bin/runner.sh` deleted. Done ahead of the close-out step; a
      supervisor took its place, which is not the same thing — see What the
      code taught us.

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

- [x] **0. Wait** (2026-08-29) — mc-brief step 2 (#416) and mc-plan step 1
      (#414) are on main; `canon/roles/` and the foreground launch exist.
- [x] **1. Verb + queue + one step** (2026-08-29) — `mc run --once` ran the
      continue-section step through the adapter, merged its PR and wrote the
      runs.tsv row (see What the code taught us).
- [x] **2. Merge + reconcile** (2026-08-29) — a night and a day measured on
      `mc run`, 2026-08-28T23:28:38Z → 2026-08-29T20:08:46Z: 77 runs.tsv rows
      (65 step, 10 reconcile, 1 helper, 1 triage from before the rules
      changed), **61 merged and zero left open**, one quota sleep, six clean
      STOP exits, seventeen workareas created on demand, and not one
      `rebase failed, skip`. Every failure mode nights 1–2 recorded is gone.
      Decisions are out of the runner's hands and the round-completion line
      cannot be read from inside the round — both under What the code taught
      us.
- [x] **3. Codex** (2026-08-29) — `tool: codex` in a project frontmatter runs
      that step with `codex exec` through the adapter; usage fields `-` if
      codex gives none. One codex step is logged: `cx step 0 0s pr=- turns=-
      … codex-thread-42 success`, after `cx: step starting (codex own default
      model, 90 min)` in runner.log. The launch was a stub codex, because
      codex is not installed on this machine, and the two faults the lane
      carried are fixed — see What the code taught us.
- [ ] **4. Close-out** — `docs/technical/mc-run.md` grown from the lanes note
      into the whole runner, `project_log.md` row. `runner.sh` is already
      gone; what is left beside mc is `runner-loop.sh`, and it belongs to the
      stale-code proposal, not to this close-out.

## What the code taught us

- The whole of step 2's behaviour (merge with wait-and-retry, reconcile,
  STOP, quota sleep) came with step 1: it shares the step function, and the
  tests cover it on fakes. Step 2 was the live observation, not new code.
- **The runner has nothing to do with decisions.** Martin, 2026-08-29:
  "Runner genomför planer som är ready. Om väntande beslut är ej ready." So
  `waiting-decision` is simply not ready — the runner does not read decision
  files, count them, or start a project because one was answered; a plan
  comes back by being set `ready`. The success criterion that had the runner
  list answered `**Beslut:**` files is retired, and with it step 2's demand
  that answered decisions be exercised in runner.log. The rule lives in
  `chooseKind` in `src/mc/run-plan.js`.
- **`triage` went the same way, same day.** The runner runs plans; it does
  not write them. Planning is `mc plan <name>`, a foreground session with
  Martin in it. There is no `canon/roles/triage.md`. The one `triage` row in
  the era (canonical-response, 03:37Z) predates the 12:11Z restart "on the
  new rules".
- **A step cannot watch its own round end.** This step ran as
  `mc-run: step starting` at 20:09:49Z inside the round that began at
  17:12:50Z (`node /opt/homebrew/bin/mc run --rounds 1`, pid 30529). The
  `round 1 done (N ran)` line is written after the last lane returns, so no
  session the round starts can ever observe it without deadlocking on itself.
  The round is verified by its rows, not by its closing line.
- **The comparison to the shell runner has no baseline left.** `runner.sh` is
  deleted, and `mc run` has deliberately outgrown it — two lanes, archive of
  `done` plans, workarea close-out, the day's `mc helper`, no triage, no
  decisions. What survives of the intent holds: no line in the era shows a
  failure the shell runner handled and `mc run` does not.
- A quota answer came back as `subtype: success` in one turn on
  2026-08-26 and the shell runner logged eleven of them as success. The
  note is now `quota`, from the result text — and it read correctly live at
  09:34:29Z, the one quota answer of the era.
- `exit` and `note` are independent columns and are allowed to disagree:
  mc-helper at 11:15:33Z is `rc=1 … note=success`, the process failing after
  a session that reported success. Both are recorded; neither is guessed.
- `runner.sh` lost its execute bit when replaced (tmux exit 126, no log
  line). `mc run` has no such failure mode: it is a verb.
- **A shell script came back, for a reason this project cannot fix.**
  `mc run` executes from `~/memoro-cli`, which nothing fast-forwards, and
  node caches its module graph at process start — so a runner that merges an
  improvement to itself keeps running the old code. `~/mc/bin/runner-loop.sh`
  closes that at the round boundary. Measured live in the same round: the
  round started 17:12:50Z, `dropFromQueue` merged at 18:27Z in #455, and
  `~/mc/queue.md` still held the names of projects whose steps had run. Owned
  by `~/mc/intake/proposals/2026-08-29-runner-runs-stale-code.md`.
- **The codex lane was wired and would have failed twice, both times on its
  own argument list.** It had never been started, so nothing had read it.
  `codex exec --full-auto` is codex's workspace-write sandbox: no network, so
  no `git push` and no `gh pr create`, and no writes outside the working
  directory — which takes the commit as well, because a workarea's `.git` is
  a file pointing into the main checkout's `.git/worktrees/<name>`. A codex
  step could not have reached the one thing its prompt ends with, "Stop when
  the PR exists." It is `--sandbox danger-full-access` now: the same trust
  the claude lane has had all along with `--permission-mode auto`, because
  the workarea is the boundary the runner trusts, not a sandbox inside it.
  Second, `sessionSettings` defaulted every tool's model to `opus`, a claude
  alias — `codex -m opus` names a model that tool does not have, and the step
  would have died before reading a word of the plan. The default is claude's
  now; another tool with no `model:` in its frontmatter gets none, and picks
  its own.
- **Codex is still not installed here, so the boundary is where the
  measurement stops.** `tests/mc/run-codex.test.js` drives the whole thing on
  `realDeps` — a real git repository with a real origin, a real worktree
  whose `.git` points outside it, a real spawned process — with a stub
  `codex` on PATH that answers in codex's `exec --json` event stream. That
  proves mc's half: `tool: codex` reaches `resolveLaunch`, the argument list
  mc builds is the one the process gets, the Coding Profile and
  `canon/roles/step.md` arrive on `-c instructions=`, the event stream is
  read into the usage columns, and the row and the launch line are written.
  It cannot prove the real codex accepts those arguments. That is one live
  step away, the day codex is on this machine.

(read `~/mc/runner/log/natt-1.md` first: it records what the
shell runner learned on nights 1–2, including why merges failed and why
rebase was wrong.)

## Documents

- `~/mc/runner/log/natt-1.md` — nights 1–2 measured, on the shell runner
- `~/mc/runner/log/runner.log`, `runs.tsv` — the `mc run` era from
  2026-08-28T23:28Z
- `~/mc/intake/proposals/2026-08-29-runner-runs-stale-code.md` — why a shell
  supervisor is still there
- `~/mc/mc-utredning/utredning-2026-08-24.md` §9–13 — the design
- `docs/project/mc/mc-brief/PLAN.md`, `docs/project/mc/mc-plan/PLAN.md`
