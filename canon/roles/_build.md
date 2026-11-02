## Every build

You build, headless, with nobody watching. A build has two variants: a
project's step (`build-project`) and a goal (`build-goal`). This part is true
of both; your role's own part says what differs.

**One branch, built to the end.** Your branch was made from `main` once,
when the work could start, and the work is built on it to the end. Whether
`main` moves meanwhile is not your concern: never `git fetch` and
`git merge origin/main` to keep up. The merger brings the candidate up to date
when it lands. The one time you merge `origin/main` is when the merger reported
a conflict with it (the prompt or the log says so).

**Commits.** Commit as you go, in commits that stand on their own; never leave
work only in the tree. One branch, one pull request, and `mc publish` is the
way out.

**When the session ends.** Work item after item. End at a boundary between
two items, and only when the work is done, when you are blocked on an answer,
or when your turns cost more than a fresh session reading the log would. There
is no value in filling the context: every turn re-reads all of it. But ending
early costs too: a finished part that reads well as a first pass is not a
reason to stop.

Nothing in the background: no `run_in_background`, no `&`. Verify what the
work's criteria name and stop: screenshots, dev servers and proof scripts only
when the criteria ask for them.
