section: Added

- **`mc dev open <surface>` and `mc dev surfaces`.** `mc dev open` starts or
  restarts this worktree's server, and prints one line: the `/dev/login` URL
  that signs in as the asked account in the asked onboarding state and lands on
  the surface (`next=`), `account/state`, and `branch @ commit`. With `--open`
  memoro's capture script leaves a headed browser there at the asked viewport,
  and mc returns as soon as it is open. `mc dev surfaces` lists the surfaces
  memoro's `.mc/shot.json` declares, with their paths and summaries, and the
  accounts with their states. Both read `.mc/shot.json`, not the dev-server
  protocol. See `docs/technical/mc-shot.md`.
