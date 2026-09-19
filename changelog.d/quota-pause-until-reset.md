section: Changed

- **The quota pause lasts until the reset the refusal names.** A refusal like
  `You've hit your weekly limit · resets Sep 11 at 3pm (Europe/Stockholm)`
  held every lane for thirty minutes and then launched the next session into
  the same refusal — eight times, three days, on 2026-09-08.
  `quotaResetAt` reads the time (the zone named, else the machine's) and
  `quotaPause` sleeps until one minute after it, in slices of at most thirty
  minutes that end on STOP or UPDATE. A refusal with no readable time, or one
  more than eight days out, keeps the thirty minutes.
