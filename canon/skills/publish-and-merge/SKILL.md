---
name: publish-and-merge
description: How a change in an mc repository (memoro, memoro-cli) gets from a branch to main with mc gate, mc publish and mc merge. Use before running tests for a change, pushing a branch, opening or editing a pull request, or merging one.
---
# Publish and merge

What the three verbs do today. Who may land a pull request is not said here;
your role, or the person, says that. These verbs replace `node --test`,
`npm test`, `npm run ci`, `git push`, `gh pr create`/`edit` and `gh pr merge`:
the hook turns those to the verb.

## `mc gate` — the tests your change reaches

- `mc gate` with no files: the repository's selector maps the branch's and the
  tree's changes against `origin/main` to test files and command gates.
  Costly ones may be left to the merge round; the tests the change touches
  always run.
- `mc gate <files…> [--test-name-pattern <p>]`: those files, a focused rerun.
- It answers within 540 s (`--budget <s>`) with GREEN or RED, the counts, the
  failing lines and the log path, at most 2 KB. Past the budget: `RUNNING`,
  exit 3; `mc gate --wait` reads the same log.
- Exit 0 green, 1 red, 2 refused or another gate already running in this
  worktree, 3 still running. `--full` is refused: the whole suite is the
  merger's.

## `mc publish` — push and open the pull request

- Refuses on `main`, on a dirty tree, and when `origin`'s branch has moved
  (it never forces). Then a plain `git push -u`, and `gh pr create` — or, for a
  branch with an open pull request, edits only the fields given.
- Title and body from the last commit, or `--title`, `--body`,
  `--body-file <path>`, `--base <branch>`.
- Then it queues the pull request for the merger, as `mc merge <repo> <pr>`
  does, in the same call. `--no-merge` pushes and opens and queues nothing;
  so do `--json` and `--branch <name>` (a detached HEAD).

## `mc merge <repo> <pr>` — the one door to main

- Queues the pull request for the merger and returns at once. The merger, one
  process per machine, takes the queue one at a time per repository lane: it
  runs the gate round on a candidate with the current base and squashes only
  on green. A red is never landed; there is no flag that lands one.
- A pull request whose every file is a document under `docs/` (no script) runs
  the tests that read documents and lands in the call when they are green
  (`--docs` forces that route).
- `--watch` (or `mc merge watch <repo> <pr>`) follows it until it lands or goes
  red. The page's MERGES section shows the queue; `mc prs` lists every open
  pull request and whose it is.
- `--admin` squashes past the gate with GitHub's admin override. It is the
  person's verb, run only on their word.
- Never `gh pr merge`.
