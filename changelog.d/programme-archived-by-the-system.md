section: Added

- **A finished programme with a record is archived by `mc run`.** When every
  goal is done or dropped (and at least one is done), a read-only
  `archive-reader` session checks that what the goals made true is written into
  `docs/technical/` and the area pages; on an OK reading the runner moves the
  programme's proposals out, archives it and sets its record to `done`, and the
  manager's horizon turn follows. A gap opens a prepared `archive` desk item for
  the decision lane, restricted data a reserved one for Martin. Each goal's
  review of such a programme also writes a `write-back` line. A programme without
  a record is still archived only by `mc plan <programme> --archive`.
