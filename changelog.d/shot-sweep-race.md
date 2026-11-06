section: Fixed

- **The dead-session sweep no longer deletes a kept-shot id another process just reclaimed.**
  `liveSessions()` read every record and then removed each dead one's file, socket
  and log by path, without `<id>.lock` and without re-reading. If another process
  reclaimed that id in between, the sweep deleted its placeholder and possibly its
  socket, and a third keep could then take the same id again. A dead record is now
  removed only under `<id>.lock`, and only while its file still carries the nonce
  that was read as dead; a held lock or a different nonce leaves the files alone.
  The same removal is used wherever a read record is removed (`next`, `close`,
  and the end of a close).
- **An unwritten `<id>.lock` no longer blocks its id for good.** A lock that does
  not parse and is older than a minute (its creator died between create and write)
  is cleared, as an unparseable session file already was.
- **`mc shot sessions` names an orphaned browser.** A kept browser's pid is written
  into its placeholder as soon as it starts. If the mc that kept it is gone while
  the browser lives, the id stays taken and `sessions` lists it as an orphaned
  browser with its pid, instead of reclaiming the id silently. mc does not close it.
