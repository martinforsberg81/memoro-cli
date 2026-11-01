section: Changed

- **Tests start no git, and one that does is red.** `tests/_isolate-home.mjs`
  answers every git a test file spawns from the repository model, in the file
  and in the `mc` and scripts it starts, with no change to the tests. Files that
  need git's own behaviour are named in `tests/_real-git-files.mjs`, a list that
  only shrinks. The per-test ceiling comes down to 30 s. The fixture
  `tests/fixtures/many-lines-verb.js`, removed by mistake in #1203, is back.
