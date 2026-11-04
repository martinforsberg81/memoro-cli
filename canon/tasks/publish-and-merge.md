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
- It answers within 540 s with GREEN or RED, the failing lines and the log
  path; give the Bash call `timeout: 600000`. Past the budget: `RUNNING`,
  exit 3, and `mc gate --wait` reads the same log. Nothing goes in the
  background to be polled. Red: fix, then run the `re-run:` line it printed.
- `--full` is refused, and so is bypassing the lane with `npm test`,
  `npm run ci` or a bare `node --test`: the whole suite is the merger's.
  Dependencies are attached for you: never `npm ci` or a bare `npm install`;
  in memoro `npm run deps:ensure` re-attaches the shared cache.
- Never lower a threshold, or skip, weaken or delete a test to turn it green.

## `mc publish` — push and open the pull request
- Refuses on `main`, on a dirty tree, and when `origin`'s branch has moved; it
  never forces. Then `git push -u` and `gh pr create`, or, for a branch with an
  open pull request, edits only the fields given (`--title`, `--body`,
  `--body-file`, `--base`).
- Then it queues the pull request for the merger in the same call.
  `--no-merge` pushes and opens and queues nothing; so does `--json`.
- The body says what changed, why, the user impact, the root cause of a fix,
  what was run and what was not, known gaps, and each new or changed test with
  its time from your `mc gate` (`test <file> › <name> — 0.xyz s`). Never claim
  a run you did not make: "suite not run" is an acceptable sentence.

## `mc merge <repo> <pr>` — the one door to main
`mc goal stage merge` is the session's final decision: merge every registered
PR directly, without gate, criteria or head checks; done after all land.
Conflicts go to a session. The rounds below apply to ordinary PR jobs.

- Queues the pull request and returns. The merger takes the queue one at a
  time per repository lane, runs the gate round on a candidate with the
  current base and squashes only on green. No flag lands a red.
- A pull request whose every file is a document under `docs/` (no script) runs
  the tests that read documents and lands in the call when they are green.
- `mc merge <repo> <a> <b>` takes only pull requests aimed at one base, and is
  not atomic: a red lands a prefix and stops.
- Do not poll: no loop, no `sleep`, no `mc merge watch` unless asked. One
  `gh pr view --json …` snapshot is the state; an empty check list is normal.
- A red's files are in `~/mc/runner/merge-red/<repo>-<pr>.txt`; rerun them
  with `mc gate` before fixing. A round that hit its ceiling left the
  unfinished files unmeasured, not green. Stopped for a reason not the PR's
  (main moved, a lease): `mc repo who <repo>`, then queue it again.
- `--admin` squashes with GitHub's admin override and no gate round: for a
  change the round cannot measure, after you measured what it reaches; the
  PR says what ran. The hook refuses it headless. `gh pr merge` skips mc's
  books (the landed line, the installation pull).
