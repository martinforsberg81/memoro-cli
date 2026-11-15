section: Added

- **The page has a DESK section: what waits for you, without opening the desk.**
  Directly under the header, up to five waiting rows (proposed text changes,
  then reserved acts, each with its brief line, how long it has waited and what
  it blocks), then what was decided without you, what is not ready and what the
  desk costs today. `d` or `desk` at the page prompt opens `mc martin`. The
  read takes no lock and writes nothing, so a runner holding the lock never
  slows the page, and `mc --json` gains a `desk` key.
