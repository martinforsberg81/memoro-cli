section: Changed

- **`mc worker` reads the role mc ships.** It took its definition from
  `~/.memoro/mc/roles/worker.md` — a catalogue mc does not install — so the
  one role mc still launches could not exist on a fresh machine. It now
  reads `canon/roles/worker.md` the way `mc plan` and `mc brief` read
  theirs, and a marked area falls back to the shipped definition when the
  catalogue has none. A catalogue that defines `worker` still wins. The
  role's escalation is a decision file (`../decisions/<project>-<date>.md`
  plus `status: waiting-decision`), not a message to a PM.
