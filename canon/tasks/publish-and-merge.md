---
name: publish-and-merge
description: How a change in an mc repository (memoro, memoro-cli) is tested and gets from a branch to main with mc gate, mc publish and mc merge. Use before running any test, pushing a branch, opening or editing a pull request, or merging one.
---
# Publish and merge
The verbs replace `node --test`, `npm test`, `npm run ci`,
`git push`, `gh pr create`/`edit` and `gh pr merge`; `mc hook pre-tool` turns
those to the verb. When the raw command is really meant, put `MC_HOOK_ALLOW=1`
in it and say why in the reply.
## `mc gate` — the tests your change reaches
- Bare: the repository's selector maps the branch's and the tree's changes
  against `origin/main` to test files and command gates. `mc gate <files…>
  [--test-name-pattern <p>]` is a focused rerun.
- Before review or finish authorizes `mc goal stage merge`, run `mc gate
  --whole-selection` on the final judged worktree; require completed GREEN.
  Record scope, frozen base, revision and log. `mc gate --wait` must complete
  the same RUNNING request. Named reruns, deferred green, red, timeout,
  interruption or incomplete results are not acceptance. Direct landing adds no
  gate or base/head validation.
- A rerun on identical content reuses each file and command gate that passed
  there and runs the rest; a resumed whole selection is a completed GREEN. Any
  content change means a new whole selection. `--fresh` forces a full run.
- It answers within 540 s with GREEN/RED, failing lines and log path; give the
  Bash call `timeout: 600000`. Past budget: `RUNNING`, exit 3; `mc gate --wait`
  reads the same log. Do not poll or run in the background. Red: fix, then run
  its `re-run:` line.
- `--full` and bypasses (`npm test`, `npm run ci`, bare `node --test`) are
  refused: the whole suite is the merger's. Never run `npm ci`/`npm install`;
  memoro re-attaches its cache with `npm run deps:ensure`.
- Never lower a threshold, or skip, weaken or delete a test to turn it green.
## `mc publish` — push and open the pull request
- Refuses on `main`, a dirty tree or moved origin; never forces. Then pushes and
  opens a PR, or edits only requested fields (`--title`, `--body`, `--body-file`,
  `--base`) on an open one.
- Then it queues the pull request for the merger in the same call.
  `--no-merge` pushes and opens and queues nothing; so does `--json`.
- The body says what changed, why, impact, root cause, what did and did not run,
  known gaps and each changed test's `mc gate` timing (`test <file> › <name> —
  0.xyz s`). Never claim a run you did not make; "suite not run" is acceptable.
## `mc merge <repo> <pr>` — the one door to main
`mc goal stage merge` directly merges every registered PR, without gate,
criteria or head checks; the goal is done after all land.
Conflicts go to a session.
- Queues the pull request and returns. The merger takes the queue one at a
  time per repository lane, runs the gate round on a candidate with the
  current base and squashes only on green. No flag lands a red.
- A pull request whose every file is a document under `docs/` (no script) runs
  the tests that read documents and lands in the call when they are green.
- `mc merge <repo> <a> <b>` takes only pull requests aimed at one base, and is
  not atomic: a red lands a prefix and stops.
- Do not poll: no loop, no `sleep`, no `mc merge watch` unless asked. One
  `gh pr view --json …` snapshot is the state; an empty check list is normal.
- A red's files are in `~/mc/runner/merge-red/<repo>-<pr>.txt`; rerun with
  `mc gate` before fixing. A ceiling leaves unfinished files unmeasured. For a
  non-PR stop (main moved, a lease), run `mc repo who <repo>` and requeue.
- `--admin` squashes with GitHub's admin override and no gate round: for a
  change the round cannot measure, after you measured what it reaches; the
  PR says what ran. The hook refuses it headless. `gh pr merge` skips mc's
  books (the landed line, the installation pull).
