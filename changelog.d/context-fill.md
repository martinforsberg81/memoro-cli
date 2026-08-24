section: Added

- **Context fill is seen by something other than the session itself.**
  Martin's rule: sessions are not to be driven that far — clear and
  compact regularly. Nobody but the session could see its fill; PM found
  msr-track-1 at 99 % by looking into its pane mid-repair, which is luck,
  not a mechanism (D-0180's form, 2026-08-24). The pane prints
  "NN% context used", but a session run outside tmux has no pane at all —
  and the transcript carries the same number for every Claude session:
  each assistant message records `usage`, and the context in play is the
  whole input side of the latest one. Read there, it needs no pane and no
  scraping. The window is not in the transcript and is assumed from the
  model — calibrated once, measured: 977 k tokens read as 100 % on
  claude-opus-5, so the 5-family is 1M; haiku and unknown are 200k — and
  the answer says `window_assumed`. Two levels: from 70 % the board shows
  `NN% context` beside the conversation (yellow, red from 90); from 90 %
  the guard flags `context` — the twelfth pattern, urgent — with the
  numbers and the way out (/compact or /clear), so PM is knocked before
  the next turns stall, for panes and for the pane-less alike.
