section: Changed

- **The page has one grid.** Every row of PROGRAMMES, SESSIONS and MERGES is
  drawn in the same columns (`page-grid.js`) — number and mark, kind, name,
  repository, state, progress, pull request, then a grey tail — so the
  repository and the PR stand at the same x in every section. A goal reads
  like a project: `goal` in the kind column rather than a `g ·` before its
  name. MERGES is a row per pull request in a queue, and an idle queue a row
  of its own. A state word has one colour everywhere (`STATE_TONE`), a cell
  is never cut inside a number, and no row is wider than an 80-column
  terminal. `mc --json` carries `kind`, `name`, `repo`, `state`, `progress`
  and `prs` on projects, goals, sessions and merge items; a goal's session is
  named `<programme>/<goal>`.
