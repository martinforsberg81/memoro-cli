section: Changed

- **Linux SSH Codex entrances run in their own `codex app-server`.** An
  interactive `mc plan`, `mc manager`, `mc martin` or `mc helper` that resolves
  to Codex now starts a detached per-session server and runs `codex --remote`
  in the terminal, as Claude entrances already keep a background session. A
  lost terminal leaves the server and its conversation; the same entrance
  offers join or new. A clean idle quit stops the server; a hangup, a signal,
  a nonzero exit, a running turn or another attached terminal leaves it. The
  tmux transport, with its worker and request directory, is removed.
