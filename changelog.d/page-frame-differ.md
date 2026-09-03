section: Added

- **`page-frame.js` — the difference between two frames of the page, as
  terminal writes.** `renderPageLines` hands back an array of lines and knows
  nothing about a terminal; this is the other half, and it is a pure function
  so it can be asserted as bytes with no terminal involved. Unchanged frames
  write nothing at all, a changed row is one relative move, `CSI 2K` and that
  row, a frame that got shorter has its surplus rows cleared where they stand
  rather than pulled up over the prompt, and a frame that grew past its
  footprint is a reprint from its first reachable row after `CSI 0J` — the
  terminal scrolls at the bottom exactly as the first print of the page
  scrolled it. Rows that have scrolled off the top are not addressed, because
  a move up past the top of the screen would land the write on a visible row.
  Nothing calls it yet: the live page's loop is the next step.
