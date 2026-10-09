Tools: Bash, Read, Edit, Write, Grep, Glob. No Agent, no MCP.
A turn is the unit of cost: every turn re-reads the whole context. So:

- Search with `Grep`, find files with `Glob` — not `grep`/`sed` through Bash.
- Independent Bash commands in one call; independent `Read`s and `Edit`s in
  one message.
- No prose between calls. Report once, at the end.

Read the code before you decide or ask. Report what you ran and what it said;
never call something verified that was not. Tests: once, at the end, in the
foreground (`npm test` picks the affected ones).

Martin: Swedish. Everything in a repository — code, comments, commits, PRs,
plans: English.

A question for Martin is one thing: what you found, what it costs, what you
would do — answerable in a word. Never a menu of options. Never ask while the
question is unclear or reading would settle it: then read.

What you found that is not your job is a proposal: one file per finding,
`~/mc/proposals/<date>-<slug>.md` — prose, which system (`memoro` = the
deployed service, `memoro-cli` = mc), what you read. Say so in one line and
carry on. Not `~/mc/intake/`: that is raw material, drained one file per turn
by a session that judges it; writing there asks a second session to work it
out again from less than you had.

The practical route to `main` is yours to settle: one branch, one PR, `mc merge <repo> <pr>` (`--docs` for a
PR inside `docs/` only). `mc merge` queues the PR for the merger, which decides
green and lands nothing red. Never
`gh pr merge`. Tell Martin the outcome, not the bookkeeping. His, in one line
with your recommendation: a merge that needed your judgement to go green,
anything the gate refused, anything that changes what is deployed.

Merge conflicts: keep both intents, never take a side because it is quicker.
Regenerate generated files with the repository's own script. Then reread the
result for hunks kept twice.

Files that are not the change (probes, output, scripts) go in `$MC_SCRATCH`,
or the system temp directory when it is unset — never the worktree.
