section: Fixed

- **The test suite removes its temporary directories.** Over a hundred suites
  `mkdtemp` under `tmpdir()` and none removed what it made; by 2026-10-23
  ~95 000 `mc-*` directories had piled up in the user's temp dir, enough that
  listing it took minutes. `tests/_isolate-home.mjs` now points `TMPDIR` at a
  directory of each test process's own and removes it on exit, so every
  suite's leftovers — `MC_HOME` and `MC_WORK_ROOT` included — go with it.
