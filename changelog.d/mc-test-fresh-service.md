section: Fixed

- **`mc test dev` starts a fresh service when the checkout has moved on.** A
  manifest may say what tree its service was built from
  (`built_from.commit`); a live service whose tree is not the worktree's HEAD
  any more is stopped through its own stop command and started again, and the
  round says so. The measurement fixture reads `public/` once at start, and on
  2026-09-06 a shared checkout fast-forwarded under one — two modules that
  landed with it answered 404 for an hour, and a proof reported the app's
  module graph as broken. A manifest without the field is reused as before.
