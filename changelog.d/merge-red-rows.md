section: Changed

- **A merge that comes back red stays on the page as a red row** while the
  queue goes on. The merger keeps the job in `merges.json` as `red` with the
  reason and when; MERGES draws one red row each (`✗ memoro #12900 … red: …`)
  and counts them in its heading, `mc prs` says *red from the merger*, and
  `mc status <project>` says it came back red. `mc merge` again puts it back in
  line; a pull request no longer open is not drawn.
- **The merge queue is on the MERGES heading**: `1 landing · 2 red · 3
  waiting: #a #b #c`; the separate waiting row is gone.
- **`mc merge <repo> <pr> <pr>...` queues each pull request**, in the order
  given, for its own round — no longer one candidate measured together.
  `mc test` with several still measures them as one.
