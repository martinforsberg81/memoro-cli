section: Removed

- **`mc pm`, `mc pm-helper`, and the 594 lines under them.** Both verbs had
  been two-line stubs printing "dormant" since decision `mc-1` (2026-08-26),
  and the machinery they stood on — `role-singleton.js` (317 lines),
  `role-home.js` (140), `pm-helper-intake.js` (102) — was imported by nothing
  but itself and its own tests. Not "looks unused": the import graph has one
  edge into it, from `role-singleton.js`, which nothing reaches.
  `mc helper` is untouched and was never coupled to any of it. Its import
  closure is `helper-collect.js`, `helper-turn.js`, `roles.js`, `work-open.js`
  and `flags.js`; it makes `~/mc/helper/` itself with `mkdirSync`, never
  through `role-home.js`.
- **`pm` and `pm-helper` are ordinary names again.** `RESERVED_ROLE_NAMES` is
  `['helper']`. The reservation existed so that `mc work pm` could not create
  an impostor of a role's workspace; with the roles gone there is nothing to
  impersonate.
- **The merge logs moved to `~/mc/runner/log/merge-<repo>.md`.** memoro's was
  written to `pm/decisions/merge-log.md`, from when a resident PM kept the
  record; memoro-cli's to `large-scale-llm-project/merge-log.md` — a
  *workarea*, which `mc run` is free to close. mc writing its own records into
  a role home and into a folder it can remove is the same mistake twice. A
  merge log is a record of rounds, and rounds are logged under `runner/log/`,
  beside `runs.tsv`. Both files were copied to their new home before the
  change; nothing in either is lost.
