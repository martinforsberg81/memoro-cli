section: Changed

- **A goal's pull request reaches the merger only in stage `merge`.** A plain
  `mc publish` for a publication that carries a goal in draft, build, review or
  finish (or a goal whose stage cannot be read) now queues nothing, with or
  without `--no-merge`, and says that `mc goal stage merge` hands it over;
  `mc merge` refuses such a pull request, found by the goal's `prs` or its
  `goal/<g>` branch, before any round, landing or queue write, for several
  pull requests and `--docs` too. `--admin`, `--check` and the stage verb's
  own hand-off are unchanged. Before, a build session's `mc publish` without
  `--no-merge` landed a goal unreviewed and marked it done.
