section: Fixed

- **A watcher's knock is never an item, whichever watcher wrote it (KP-10).**
  B3 (#389) taught the PM round to ignore its own knocks; it still counted
  the session guard's, and the guard counted the round's as mail that had
  arrived since PM last moved — `unattended`, urgent, knock — which the
  round then counted as the next item. Measured 2026-08-24 in PM's archive
  since 22:00Z: 163 files, 104 of them from the two watchers (64 %), and six
  wakes in a row after the fleet went quiet with no report in any of them.
  At that rate a new inbox file stops meaning anything, which is how a
  ruling lay unread for sixteen minutes while a track stood blocked (D-0170).
  Now both watchers sign from one registry (`watch-senders.js`) and both
  readers — the round's inbox count and the guard's `unreachable` and
  `unattended` counts — excuse every name in it, recognised by the sender
  line the channel writes, never by the filename. A third watcher is added
  there once.
