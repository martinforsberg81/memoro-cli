section: Changed

- **`mc work stop` says so, and the guard stops calling it `dead` (KP-09).**
  The guard's `dead` — alive last round, gone this round, last turn never
  finished — is arithmetic and right, and it is also exactly what a session
  looks like after PM stopped it on purpose. Three knocks in one night
  (2026-08-24: `grindvarv-review`, `mc-repo`, `msr-track-2`) about sessions
  PM had just stopped; the flag was not wrong, it was indistinguishable,
  and a guard whose alarm one learns to ignore is a guard that is not there.
  Now a stop that stopped something leaves `.mc-stopped` in the area — who
  asked (`currentHolder()`), when — and the guard reads it: a mark at or
  after the conversation's last movement (less a minute for the tool's exit
  hooks) is the stop that ended it, said in the guard's log as `stopped by
  pm 03:16 — not dead` and written to no ledger; the board shows `■ stopped
  by pm 03:16 (2h) — mc work <name> picks it up` under the area while
  nothing runs there. Opening the area again — in the terminal, in the
  background, or by respawn — removes the mark, and a mark older than the
  conversation's last movement is a stop before a restart mc did not see:
  the next disappearance is judged on its own. Like `.mc-role`, the mark
  never keeps an otherwise-empty area alive on release.
