section: Fixed

- **A landed pull request no longer stands in MERGES as waiting.** An
  `mc merge` that timed out keeps its place in `merges.json`, and the next
  call for the same pull request that found the machine free returned `go`
  without reading the queue, so the entry outlived the landing: memoro #12353
  was drawn as `1 waiting`, behind a gate round whose pid was long gone, for a
  day after it merged (2026-10-02). The free path now takes its own pull
  request's entry away, and the page and `mc status <name>` leave out an
  entry whose pid is not alive — the rule `dropDeadEntries` already gave the
  waiters themselves.
