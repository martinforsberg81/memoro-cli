section: Fixed

- **PULL REQUESTS stays current.** `prs.json` was refilled only by
  `mc --fresh`, `mc prs` and a runner lane's pick. With the runner stopped, or
  every lane an hour into a step, the section said `as of 55 min ago` and
  nothing was going to change that (2026-10-10). The page at a terminal now
  asks GitHub itself when its copy is five minutes old: at most once per five
  minutes per open page, however the ask went, and never a repository the
  runner's backoff (`github.json`) is holding. What answers replaces only that
  repository's entries. A pipe and `--json` read the cache as before. `f` at
  the menu asks now. The merger takes a pull request off the list the moment
  it lands.
