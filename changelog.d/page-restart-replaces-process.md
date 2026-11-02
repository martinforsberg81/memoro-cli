section: Fixed

- **A page that starts again on new code replaces itself and starts on an
  empty screen.** `restartPage` started `mc` again with `spawnSync` and
  waited for it, so every restart left the old process parked under the new
  one: after a day of fast-forwards in `~/mc/self` a terminal tab held a chain
  of `mc` processes, each waiting on the next, and each new page was printed
  under the last, so the scrollback grew by a whole page per restart. The
  process is now replaced with `process.execve`, so only the newest page's
  `mc` is left. Node does not carry the shell wrapper's fd 3 across the exec;
  nothing has written it since `emitCd` was removed, so the new process is
  started without the wrapper flag rather than claiming it. At a
  terminal the screen and the scrollback are cleared before the `mc moved`
  line, so the tab holds one page. A stdout that is not a terminal gets the
  bytes it always got, and where `process.execve` is missing (Node 22 before
  22.15) or throws, mc waits on a child as before.
