section: Changed

- **`mc deploy` runs in its own process, beside the merges** (ruling 30).
  After the yes the deploy is the deployer — detached, its output in
  `~/mc/runner/log/deploy.log` — and the terminal that asked follows it; ^C
  stops the watching, not the deploy, and `mc deploy --follow` watches again.
  No repository lease is taken, so a merge round's gate no longer holds a
  deploy back (and no more exit 3 after eight minutes of waiting). One deploy
  at a time, by the record, decided under the register's lock; no queue — a
  second `mc deploy` is refused with the first one's sha and pid.
