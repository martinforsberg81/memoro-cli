section: Fixed

- **The push-guard installs where the hooks actually live, and chains what
  was there first.** Merged 2026-08-24 and installable on neither of the
  repos it exists for: both set `core.hooksPath` — memoro-cli to the
  default directory spelled out, memoro to a versioned `.githooks/` that
  already held a wrangler-reminder pre-push — and the guard refused one for
  a setting that changed nothing and misread the other as "no pre-push
  hook" because install and state both looked only in `.git/hooks`. Now one
  function answers where the hooks live (`core.hooksPath`, relative or
  absolute, else the common dir) and both install and state use it; a hook
  that was there first is preserved byte for byte as `pre-push.before-mc`
  and runs after the check, fed the same stdin and arguments, its refusal
  kept — mc chains, it never overwrites and never loses. A
  version-controlled hook is the repository's and is never renamed (PM's
  ruling, 2026-08-24; K3): the install refuses with the way in — add
  `mc repo push-check` to it through a pull request — and a repository-owned
  hook that carries the check reads as in force, because the mechanism is
  what runs, not who wrote the file.

- **Mechanisms out of force are said by something that already runs
  (D-0180).** Five instances in one week of built-and-not-in-force — the
  guard on day-old code, `mc suite claim`'s exit one step from the action,
  `changelog.d` bypassed, #381 conflicted fourteen hours, the push-guard
  merged and uninstalled — each found by accident. `mc doctor` now carries
  `not_in_force`: the push-guard per repository, a watcher on old code /
  stale / stopped without telling anyone, and a missing red floor where the
  last gate round stood on red. Its own field and its own `NOT IN FORCE`
  section — never folded into the 28 issues nobody reads, and it moves no
  exit code. The PM round reads it every pass and knocks under the same
  wake-on-change rule as the inbox: newly broken knocks now, still broken
  earns one reminder on the third pass, repaired is forgotten — and the
  sentence is always given in full, never as a count.
