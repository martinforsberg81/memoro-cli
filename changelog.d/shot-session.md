section: Added

- **`mc shot … --keep`, `mc shot next`, `mc shot close` and `mc shot sessions`:
  a browser kept between calls.** A shot opened and closed its browser per
  call, so a session that could not foresee every step signed in again,
  navigated again and repeated every earlier action each time, and lost what
  the page held in memory. Now `--keep` answers as a shot does and keeps the
  page; `mc shot next [<id>]` takes one more step on it — act, evaluate, wait,
  measure, picture, `--goto`, `--reload`, `--no-shot` — and answers in the
  lines and exit codes a shot answers in, every error since the previous step
  with it. A failed step leaves the page where it stood. A dev session whose
  tree was edited gets its server restarted and the page opened again on it. A
  dead session is one line. At most four are kept. The session file and the
  socket carry no secret and are the user's alone. memoro's capture script
  keeps the browser in project shot-session-capture.
- `--fill` and `--upload` split `<css>=<value>` at the first `=` outside an
  attribute selector's brackets, so `input[name=title]=Bank` fills that input
  with `Bank`; it was split inside the brackets.
