section: Fixed

- **The PM round stops feeding itself, and stops reminding (PM 2026-08-24).**
  The round writes its knock as a file in `pm/inbox/`, and the loop's inbox
  watch counted that as "a new file" — a pass every three seconds, each one
  announcing the one before (measured: six knocks in forty seconds, nine
  archived files that were the round talking to itself). The watch now
  ignores a watcher's own file by the sender line the channel writes
  (`watch-senders.js`), the same rule that already keeps it off the item
  count. And a reminder about an item PM was already knocked about is not
  information — every knock costs PM a whole turn, and Martin's standing
  order is that PM's cost drop to a fraction — so the round knocks once per
  item and is then silent for good; the lingering ones are still counted in
  the next knock something new earns, never named again. `reminders` stays
  in the shape, always empty, so every reader keeps its answer.
