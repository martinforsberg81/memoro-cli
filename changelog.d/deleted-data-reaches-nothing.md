section: Fixed

- **A deletion no longer runs the whole suite for want of a reader.** The
  selector's fallback asks *"does anything read this?"* and treats no answer as
  no knowledge, which is right for a file that is still there — the reader may
  be an edge the script cannot see. For a deletion the empty answer is the
  whole answer: nothing is left to read. `scripts/affected-tests.js` now says
  so, and the rule is about the file being gone rather than about where it
  lived, so a root document is covered without widening `DATA_DIRS`.
  The reach of a deleted path is measured against the names that *were* real:
  the pin index indexed only paths `git ls-files` still lists, so a deleted
  file had no readers by construction, and the rule above would have called
  every deletion inert — including the one that breaks its reader. Pins and
  directories now resolve against the tracked set plus what the change
  deleted, and the guard is a test: deleting a document a test does read still
  selects that test.
  Measured on the change that found it — removing two `.claude` documents
  selected all 249 test files, and the whole suite stands on 23 red, so the
  round could only refuse. It now selects what the change reaches.
