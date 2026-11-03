section: Added

- **`mc gate` times each test the change touches.** A test the diff against the
  base reaches (a test whose lines it changes, or every test of a new file) is
  printed with its time, `test <file> › <name> — 0.xyz s`, as node measured it,
  so the session that writes a test sees how long it takes before the merge
  round does. The time never changes GREEN or RED. `writing-tests` asks a session
  to rebuild a test over 1 s before it publishes, and `publish-and-merge` asks
  for each new or changed test's time in the pull request body.
- **A test cut at its time limit is kept in `~/mc/runner/too-slow/<repo>.tsv`.**
  Every run that measures times (`mc gate`, `mc test`, `mc publish`'s round,
  the merger's) writes the tests node cut, one row each: file, name, first and
  last seen, where, and the limit. A test that passes under the limit in a
  later run is removed.
