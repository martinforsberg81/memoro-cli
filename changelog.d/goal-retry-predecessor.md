section: Fixed

- **A retried goal can finish publishing.** An incomplete attempt writes no
  handoff, but publication named the last step run as its predecessor and
  refused its own handoff as stale, right after opening the PR. Seen on
  `script-keys` #1212.
