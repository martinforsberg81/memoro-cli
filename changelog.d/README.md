# changelog.d

One file per change, so two pull requests never touch the same file. Each
pull request adds `changelog.d/<branch-or-topic>.md`:

    section: Added

    - **What changed, in one bold phrase.** Why, and what it was before —
      the same paragraph that used to go straight into CHANGELOG.md, with
      continuation lines indented two spaces.

`section` is one of Added, Changed, Deprecated, Removed, Fixed, Security.

`node scripts/changelog-fold.js` moves every fragment under its section of
`## [Unreleased]` in `CHANGELOG.md` (newest first) and deletes it — run at
release, or whenever the log should be read whole. `--check` lists what would
fold without writing. A malformed fragment stops the fold and is named;
nothing is dropped silently.

Do not edit `CHANGELOG.md`'s Unreleased section directly in a pull request:
that is the line every open pull request conflicts on.
