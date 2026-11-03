section: Changed

- **A memoro merge no longer rebuilds the TipTap bundle.** `build:tiptap`
  leaves memoro's `derived` commands: memoro's email-compose (#14707)
  deletes the bundle, its build and the `@tiptap/*` dependencies on
  purpose, and the merger stopped that pull request at `Missing script`.
  Until #14707 lands, a merge simply skips rebuilding a bundle that is
  going away.
