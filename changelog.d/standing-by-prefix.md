section: Fixed

- **Who stands where is answered by prefix, not by exact path (KP-08 point
  7).** Occupation, addressing and the board all asked `lsof -d cwd` for
  exact directories, and lsof answers exactly: a tool started in
  `<area>/memoro-cli/src` was not standing in `<area>/memoro-cli`, and so
  vanished from all three mechanisms at once with nothing saying why
  (measured 2026-08-23; `mc work` starts at the root, so only hand-started
  sessions were hit — the ones nobody is watching). `standing.js` asks lsof
  once for every cwd this user's processes hold and matches here: a process
  stands in the longest known path that is its cwd or an ancestor. ~100 ms
  against 28 ms for the exact ask, scoped to the user.
