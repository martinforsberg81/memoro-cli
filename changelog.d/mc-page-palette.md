section: Changed

- **The page reads at a glance: `mc` is in colour.** It painted fourteen
  things grey and three green, so a running step and a queued one looked
  alike. The palette is a table now, and the same meaning has the same colour
  wherever it is printed: a step kind (step green, triage blue, the
  foreground verbs cyan), a plan status (ready green, blocked red,
  waiting-decision yellow, done grey, no plan at all dim grey), cyan section
  headings, white for the name a person is looking for, grey for the
  bookkeeping. The clock beside a running step turns yellow past three
  quarters of its budget and red past all of it; a pending STOP is red, a
  quota answer yellow while it is recent and grey once it is history, and a
  digest older than a day says so in yellow. `--watch` says `watch · 15 s` in
  the header, because a page that redraws itself looks exactly like one that
  does not. Every escape is added after the width is decided, so a coloured
  row is exactly as wide as its plain twin — and `--json`, a pipe and
  `NO_COLOR` still get the page with nothing in it but what it says.
