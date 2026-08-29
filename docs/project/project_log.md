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
