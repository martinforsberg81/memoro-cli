section: Removed

- **memoro-cli's round budget and its session gate's 180 seconds.** The merge
  round left files out to fit `round_seconds: 120`, and an unnamed `mc gate`
  left them to the round; the suite now takes 128 s whole, so a budget only
  hid tests. A repository declares `session_whole` to defer nothing; memoro
  keeps its deferral.
