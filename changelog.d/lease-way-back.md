section: Added

- **A lease has a way back, a refused claim reaches its holder, and an idle
  suite right is flagged at the one who holds it.** PM held the suite right
  for 2h 25m on 2026-08-23 after its own gate round was killed by a shell
  timeout: the round's `finally` never ran, nobody was left to release, and
  a track waited twenty minutes, asked twice, and wrote a letter while the
  board said "held 2h 25m · nothing running" to nobody. The root cause is
  interruption, not forgetting — a lease is taken by a command and released
  by that command's end. Three mechanisms: (1) a lease taken for the length
  of a process records its pid (`lease-owner.js`); a lease whose process is
  gone is *orphaned* — `mc suite who`, `mc repo who` and the board say so,
  the next claim takes it and logs a `reap` (not a force), and anyone may
  release it; a gate or merge round also releases both leases on
  SIGINT/SIGTERM, and a hold by hand keeps the old rule — no expiry,
  `--force` decides. (2) A refused claim — `mc suite claim`, `mc repo
  claim`, or a gate round stopped on either lease — is told to the holder's
  inbox with a wake (`lease-refusal.js`): who asked, for what, how long it
  has been held, what runs under it, and the one command that ends the
  wait. (3) The guard's ninth pattern, `holding`: the suite right held over
  fifteen minutes with no suite running is flagged on the holder's session,
  carried to PM by the round, and told to the holder directly, once. Tests
  now isolate `MC_WORK_ROOT` as well as `MC_HOME`, after a gate test told a
  real PM about a temp repository.
