section: Fixed

- **A page printed again whole clears the screen and the scrollback first.**
  The live page reprints rather than diffs when it grows, after a resize,
  when a status changed in rows that have scrolled off the top, and on `a`,
  `f` and the redraw after a verb. Each of those erased what was on screen
  and printed a whole new copy under the old one, and since the page is
  taller than most terminals every reprint left another page in the
  scrollback: after a few hours the tab was an endless scroll of old pages.
  Every whole reprint now starts with cursor home, erase screen, erase
  scrollback, then prints the page as the first print does, so the tab holds
  the current page plus whatever scrolled off since. The first one also
  clears what was in the terminal before `mc` started. In-place frames write
  exactly what they wrote; the narrow-terminal reader clears only when
  stdout is a terminal, so a pipe gets the bytes it always got.
