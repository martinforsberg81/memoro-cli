section: Changed

- **A step session's learning lives on its own step.** `steps[i].comments` is an
  array of paragraphs, the shape `goal`, `contract` and `instruction` already
  use, and the top-level `what_the_code_taught_us` — a shared list of
  `{ title, body }` objects — is gone from the schema and from all 38 plans on
  the two `origin/main`s (259 entries moved by `scripts/migrate-plan-comments.js`).
  It was prose in a schema-validated shared field: on 2026-09-02 three of five
  `plan-trespass` runs were malformed entries in it rather than trespasses, and
  `new-user`'s plan was unreadable on `origin/main` for a day because five
  bodies were strings instead of arrays. Everything a session may now write is
  inside `steps[index]` plus `met`, so the boundary check is one skipped index
  and no shared field. `stepPrompt` and `canon/roles/step.md` also state the two
  shapes they never stated: `blocked_by` is `{ kind, name }` and required, and a
  criterion's own text is Martin's while only `met` is the session's.
- **A plan on `origin/main` that does not parse is raised where somebody
  looks.** `mc run` writes `~/mc/intake/unreadable-plans.md` every round —
  project, repository, first problem, path — beside the workareas with no
  project, and `mc brief` gains a *Plans that do not parse* section.
  `chooseKind` has answered `unparseable` all along and `runStep` logged it to
  `runner.log`, where `new-user`'s line went every round for a day while the
  project quietly stopped existing on every board. Nothing here is repaired by
  a machine: the fault is in what a session wrote, and what it meant to say is
  not mc's to guess.
