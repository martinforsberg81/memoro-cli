section: Fixed

- **A draft over a stopped session queues nothing (D-0186).** The wake queue
  exists for one case: a live conversation whose prompt holds a draft — the
  knock is owed and lands when the prompt clears. A *stopped* session has no
  turn coming, so "knocked when the prompt clears" means never; measured
  2026-08-24, PM's two orders (04:36Z and 04:46Z) queued for hours behind a
  ghost draft in a pane whose tool had been stopped, and a person with tmux
  was what finally delivered them. Now the queue takes only what it can
  repay: a `--wake` that finds a draft asks the same question
  `not-addressable` already asks — does a tool actually stand in the area —
  and with nobody behind the pane it delivers the file, says "nothing is
  running … nothing will clear it, so no knock was queued; it reads its
  inbox when it starts", and owes nothing. The guard-round flush drops an
  entry the same way when the pane outlives its tool, saying why, and the
  file stays in the inbox for the session's next boot.
