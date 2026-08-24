section: Fixed

- **A living holder is never told to release the suite right (KP).** The
  guard's `holding` flag and the board's suite row both asked a
  command-name list — "is a suite running?" — and the list went wrong the
  day the extra gate was added: 20 minutes into PM's own round's extra gate
  (~88 % of a round's time, run in the gate's own worktrees that no path
  list watched), the guard said "holds the suite right … with no suite
  running — mc suite release if the run is over", asking for exactly the
  mid-round release the lease exists to prevent (measured 2026-08-24; PM
  checked instead of obeying). The holder's living process is its own "I am
  alive" — a gate round is one process from claim to release, `mc suite
  run` holds through its command the same way — so the guard now keeps
  quiet while `owner_alive` is true, no list to age out of, and the flag
  keeps to the holds nobody is behind: an orphaned pid, a claim by hand.
  The board says it too: "no suite visible, but the holder's process
  (pid N) is alive — likely an extra gate or preparation" instead of
  "nothing running".
