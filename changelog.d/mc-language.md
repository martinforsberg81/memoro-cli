section: Added

- **`mc language` — one door for language data in production (ruling 31).**
  It reads where a language stands (`status <lang>`, cached for the page). It
  runs memoro's cutover manifests act by act, with one question before every
  write (`run`, `resume`), and promotes the curated grammar (`promote`). The
  key is kept in the keychain, is never an argument, and is given only to the
  child that needs it. Every run is recorded, and a run and a deploy never
  write at the same time. The `mc` page has a LANGUAGE section, plus a red
  line while a run has stopped inside an open gap. `mc deploy --dry-run`
  prints the language line, and the deploy no longer promotes grammar.
  Before this, language data reached production by hand-run scripts, and
  grammar was promoted inside `mc deploy`.
