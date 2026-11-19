# Help — shared usage and routing

`mc --help` starts with a daily screen grouped by task, then IN FULL for the
less-used forms. Moving a form off the first screen does not remove it.
`src/mc/help-text.js` assembles that text; `src/mc/command-help.js` holds the
shared `COMMAND_USAGE` entries used by handlers and `commandReference`.

## One usage per verb

`commandUsage(verb)` returns the handler's usage, and `commandReference`
removes only its usage marker for the full reference. A routed form should
not have a separate synopsis maintained in two places. The handler's ROUTES
objects declare argument scans and validation for forms the route audit can
walk. `mc-verbs.js` dispatches the commands; help is handled before a verb
starts an operation or asks for authentication. A script's own flags after
`mc keys run <script>` belong to that script, including `--help`.

## Current work model

The page is `mc`: a number shows a goal. The overview draws programme work
trees inline under their horizons or in Other. `mc goal` writes the
brief, criteria, phase, stage and log; `mc plan` and `mc martin` are the person's interactive entrances
(`mc helper` is the eye and has none); `mc manager` is headless only
(`mc manager --headless --prompt`, [mc-manager.md](mc-manager.md)) and the runner starts it itself. A session already
running uses its own verbs, not an entrance that starts another session.
`mc learning` is a terminal command for factual area updates, starting the
same headless role as chores; its in-session routes and refusal rules are in
[mc-martin.md](mc-martin.md#lessons-and-the-learning-pass).
Projects went on 2026-11-03; migration is described in
[mc-goals.md § From a project](mc-goals.md#from-a-project).

A retired route answers with where the work went and exit 2, not an alias
that silently performs the old operation. `mc status` points to the page and
`mc goal show`; free-standing workarea entrances are retired too.

## Proposal counts

`mc proposals` reports waiting proposal counts per area and the total. It uses
the shared filesystem proposal reader (`listAllProposals`), so it includes every
area folder under `~/mc/areas/<repo>/<area>/proposals/` on disk, one whose page is
no longer declared too. Only direct Markdown files count; archives, directories
and other files do not. No proposal body, git or network is read.
`mc proposals --json` returns `areas` (`area`, `count`, `path`) and `total`. The
paths follow the configured mc work root.

## Checks

`tests/mc/help-routes.test.js` checks declared forms and flag routing against
the dispatch and handler usage. `tests/mc/help.test.js` covers the full text
and first screen.
These are parser and output checks, not proof that an external service or
coding tool accepted a live operation. Usage measurements from the invocation
log are evidence for where to put a command, not authority to delete it.
