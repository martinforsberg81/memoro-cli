---
name: writing-tests
description: Writing or changing a test or gate in an mc repository — what a count pins, what a repository scan reads. Use before adding an assertion on a number or a test that walks the repository's files.
---
# Writing tests

- **A pinned number is a summary of a list, and the list is what to pin.**
  Where a test asserts a count, assert the members beside it. A sum can be
  right for the wrong reason, and every check that reads only the sum passes
  it.
- **A repository scan reads what git tracks** (`git ls-files` in a work tree),
  never a disk walk: a walk once picked up ignored probe scripts and made
  tests green locally and red on the merge candidate. Use the repository's
  helper where it has one (memoro: `scripts/lib/tracked-source-files.mjs`).
- Add a regression test for a fix; keep validation proportional to risk.
