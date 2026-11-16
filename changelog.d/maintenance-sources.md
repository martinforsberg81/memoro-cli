section: Changed

- **MAINTENANCE has one row per source, and `m` opens its view.** The last frame of the
  overview lists user feedback, proposals, lessons, errors, tests, dependencies, intake,
  the area pages and strays, each with what waits, how long the oldest has waited and the
  verb that handles it. A source that cannot be read is red on its own row and does not
  disappear; user feedback says it has no source, as memoro's product feedback was
  retired. `m` (or `manager`) opens the maintenance view, with each source's detail below
  its row: proposals by programme and the new ones by name, lessons by state, errors,
  tests and dependencies by repository, and the area pages with their repository, the day
  they last changed on `main` and their aims. `m` and `manager` no longer open the manager.
  `mc --json` carries the rows under `maintenance`.
