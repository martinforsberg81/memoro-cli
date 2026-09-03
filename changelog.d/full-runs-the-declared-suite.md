section: Fixed

- **`mc test <repo> --full` ran 6 files of memoro's 2,021 and reported them as
  the whole suite.** `--full` turned the selector off and fell back to `npm
  test`, read off `package.json`, on the argument that mc must not keep a second
  definition of somebody else's suite. The argument holds; the assumption under
  it did not. memoro's `npm test` is `node scripts/testing/ci.mjs`, a
  diff-selector — and a `--full` round has no pull request, so it checked out
  `origin/main` detached and diffed it against itself: 0 changed paths, 6
  selected files, summarised as everything. Measured at `58db0f5`, the same tree
  the old path called the whole suite gives 6 files from `npm test` and 2,021
  from `npm run test:full`.

  So the whole suite is declared now, beside `select` and `prepare`, in the same
  three layers: `suite` and `suite_why`, read shipped < the repository's
  `.mc/test.json` < `~/mc/repo-gates.json`. And the narrow rule that makes the
  old guess impossible: **a declaration carrying `select` and no `suite` may not
  answer a `--full`** — it stops, naming both fields, because a repository that
  declared a selector has already said that its `npm test` narrows. A repository
  with no `select` keeps `npm test`, verbatim, and needs no declaration.

  `mc test memoro --full` is now 2,021 files and 17,982 tests in 288 s. A
  whole-suite round also records which command produced it (`full_suite` in
  `--json`, and on the verdict's own `--full` line), and the report names the
  npm script behind an npm command, so `npm run test:full` no longer reads
  exactly like `npm test`.
