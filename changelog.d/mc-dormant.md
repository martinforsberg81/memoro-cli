section: Removed

- **The `mc watch` programme is gone, and `mc pm`/`mc pm-helper` are
  dormant.** Decision mc-1 (2026-08-26) gave the triage and the queue to the
  runner and the decisions to `mc brief`, which left the resident PM, the
  pm-helper, the PM watcher and the sessions watchman with nothing to hold.
  `mc pm` and `mc pm-helper` answer one line and exit 2 — their machinery
  stays until the wider surface cut — while `mc watch`, every `watch-*`
  module, the wake queue and `~/.memoro/mc/watch/` are deleted. `mc repo
  watch` is a different mechanism and is untouched; `mc status --sessions`
  no longer carries a watchers row. A wake refused on a draft is now
  reported rather than queued: the queue's only flusher was the watchman,
  so "it will be knocked when the prompt clears" had nobody left to knock.
