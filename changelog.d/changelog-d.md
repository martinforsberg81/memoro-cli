section: Added

- **`changelog.d/` — one changelog fragment per change, folded at release.**
  Every pull request wrote its own line at the top of `## [Unreleased]`, so
  two open pull requests always conflicted there whatever their code did —
  six rebases and two red gate rounds in one evening (2026-08-22). Moving the
  entries apart was measured to work (`git merge-tree`, three pairs, zero
  conflicts) but only for that set; it made the conflict class manageable,
  not gone. Now a pull request adds `changelog.d/<topic>.md` — a `section:`
  line and the entry — and `node scripts/changelog-fold.js` moves every
  fragment under its section of Unreleased, newest first, in one commit
  (`--check` lists without writing; a malformed fragment stops the fold by
  name, never dropped). Two pull requests never touch the same file; the
  entries meet only in the fold. The coding-agent protocol's series rule now
  says so, and this entry is the first fragment.
