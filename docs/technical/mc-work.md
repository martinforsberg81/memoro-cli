# mc work — retired 2026-11-03

A historical note. `mc work <name>` and `mc worker <name>` opened a folder of
their own under `~/mc/work/<name>/` — a "workarea" — with a session in it that
belonged to nobody. Martin, 2026-11-03: *"Sedan ska vi helt ta bort konceptet
med work; sessioner hör alltid till ett program eller så är det t ex BRIEF."*
So every session belongs to a programme (plan, build, review) or a desk
(brief, helper), and there is no third kind (goal `mc/no-work`).

What took each part's place:

- **The verbs.** `mc work …` and `mc worker …` exit 2 with a line that says
  where each kind of session starts (`RETIRED_VERBS`, `src/mc-verbs.js`).
- **Opening a project from the page.** A project's number opens a session in
  its runner area, registered with its programme (`src/mc/project-open.js`);
  a project the runner has not started has no area and opens nothing.
- **The page's WORK section.** Gone, and from `mc --json`. Every session there
  has an `owner`; one with none, and an `mc-<name>` tmux session nobody
  started, is a stray under PROGRAMMES ([`mc-ui.md`](mc-ui.md)).
- **`~/mc/runner/unplanned-workareas.md`.** The runner no longer writes it; it
  counts such areas in one log line.
- **What is left under `~/mc/work/`.** `mc tidy` lists every one with why it
  stays or may go, and only a person's `mc tidy --apply` removes one
  ([`mc-tidy.md`](mc-tidy.md), rule W).
- **The dependency tree** every checkout resolves from:
  [`mc-shared-deps.md`](mc-shared-deps.md).
