section: Fixed

- **Closed pull requests reach a person, and merged ones are not queued again.**
  The runner sets an all-closed goal in `merge · ready` to `merge · Martin`
  once, naming the pull requests instead of repeating a queue warning every
  five minutes. The runner and `mc goal stage merge` share one GitHub state
  reader and skip already merged pull requests. `mc publish` records the
  session's writer role in its goal entry, like other session entries.
