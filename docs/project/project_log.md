# Project log

One row per project closed out of `docs/project/`. Append-only — a row is
never edited to reflect later events; a project reopened after being logged
gets a new row when it closes again.

Same file, same fields and same rule as memoro's `docs/project/project_log.md`;
`mc helper` reads whichever of the two the repository it is looking at keeps.

## Why these fields

The test for each field is: what would someone need, reading this in two
years, having forgotten everything about the project except that it once
existed?

- **date** — when it was archived. Without this the log cannot be read in
  order, and "recent" or "old" becomes a guess.
- **programme** — which initiative it belonged to, so entries can be grouped
  without re-deriving the mapping from memory or from `docs/project/`, which
  by then no longer has the directory.
- **project** — the mc workarea name. This is the join key back to git
  history: `git log --all -- docs/project/<programme>/<project>` (or its
  pre-archive path) is how a real question about *why* gets answered, once
  the one-line summary here isn't enough.
- **outcome** — `delivered`, `abandoned`, or `superseded`. A closed project
  is not always a finished one, and "what happened to it" is usually the
  first question, before "what did it do".
- **summary** — one line: what it built, or why it stopped. Enough to decide
  whether to dig further, not a report.
- **doc** — the path under `docs/technical/` that now describes the resulting
  architecture, per the close-out rule in `README.md`. `none` when the project
  produced no lasting architecture (abandoned before shipping, or superseded
  before merging).
- **pointer** — a PR number, commit SHA, or short git-log-worthy reference
  into the history that this row summarizes. The row is a one-line index,
  not the record; this is how a reader gets from the index to the record.

## Log

| date | programme | project | outcome | summary | doc | pointer |
|---|---|---|---|---|---|---|
| 2026-08-29 | mc | mc-ui | delivered | Made bare `mc` the one page — NOW, QUEUE, DECISIONS, INTAKE, WORK with the menu under it — in 0.1 s offline instead of 1.9 s, gave the runner and the foreground verbs the two files that say what is running this second, and removed every other surface that printed a list. | [docs/technical/mc-ui.md](../technical/mc-ui.md) | [#430](https://github.com/martinforsberg81/memoro-cli/pull/430), [#435](https://github.com/martinforsberg81/memoro-cli/pull/435), [#440](https://github.com/martinforsberg81/memoro-cli/pull/440), [#441](https://github.com/martinforsberg81/memoro-cli/pull/441), [#443](https://github.com/martinforsberg81/memoro-cli/pull/443) |
| 2026-08-29 | mc | mc-ui-polish | delivered | Gave the page a palette: a step kind and a plan status one colour each wherever they are printed, the header, the five sections and the clock painted for meaning, every escape added after the width was decided — no new section, datum or flag, and the plain page unchanged but for one always-drawn `●` on a DECISIONS row. | [docs/technical/mc-ui.md](../technical/mc-ui.md) | [#446](https://github.com/martinforsberg81/memoro-cli/pull/446) |
| 2026-08-29 | mc | mc-helper | delivered | Gave production a reader: `mc helper --collect` writes a daily digest of five memoro sources into `~/mc/intake/errors-<date>.md` with the delta against the previous one — the digest is its own state, because memoro records no baseline anywhere — and `mc helper` then runs one headless Sonnet turn that writes proposals nobody acts on but Martin. `mc run` runs it once a day, gated by its own runs.tsv row; `mc brief --collect` lists the proposals and the page shows the loud lines. Retiring memoro's `sync-todo.mjs` (decision mc-2, on or after 2026-09-05) is handed to a memoro-side plan. | [docs/technical/mc-helper.md](../technical/mc-helper.md) | [#424](https://github.com/martinforsberg81/memoro-cli/pull/424), [#439](https://github.com/martinforsberg81/memoro-cli/pull/439), [#445](https://github.com/martinforsberg81/memoro-cli/pull/445) |
| 2026-08-29 | mc | mc-run-lanes | delivered | Made `mc run` drive one lane per repository at the same time inside the one process: the round splits the queue by the repo each plan lives in, `~/mc/runner/current.json` became one `current-<repo>.json` per lane and NOW a list, the Claude quota is one sleep both lanes wait out and STOP ends both after the step each is in, and the session became a promise because a synchronous wait held the event loop for the whole budget. No new command or flag, and one repository with ready plans is still one lane. | [docs/technical/mc-run.md](../technical/mc-run.md) | [#450](https://github.com/martinforsberg81/memoro-cli/pull/450) |
| 2026-08-29 | mc | mc-tidy | delivered | Made `status: done` the whole trigger: `mc run` archives the plan (directory `git rm`'d, `project_log.md` row written unless the close-out step wrote one, one PR per repository) in the round it reads it, and at the end of that round closes every workarea whose plan is done, whose worktree is clean and whose last run merged — worktree handed back, local branch deleted, whatever the folder kept moved to `runner/log/closed/`. `queue.md` became a strict list of names that empties itself, the page and the runner agree that a workarea is a folder holding `memoro/` or `memoro-cli/`, and the two things a machine must not decide — a project archived with no `docs/technical/` note, a workarea with no plan on main — are written to `~/mc/intake/` and raised in `mc brief`. No new command, flag or prompt key. | [docs/technical/mc-tidy.md](../technical/mc-tidy.md) | [#451](https://github.com/martinforsberg81/memoro-cli/pull/451), [#454](https://github.com/martinforsberg81/memoro-cli/pull/454), [#455](https://github.com/martinforsberg81/memoro-cli/pull/455), [#456](https://github.com/martinforsberg81/memoro-cli/pull/456) |
