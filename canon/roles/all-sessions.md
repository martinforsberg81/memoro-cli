Tools: Bash, Read, Edit, Write, Grep, Glob, Agent; no MCP. A session may use its own tool's subagents; mc neither starts nor counts them.
A turn is the unit of cost: every turn re-reads the whole context. So:

- Search with `Grep`, find files with `Glob` — not `grep`/`sed` through Bash.
- Before you read, name everything you will need — files, patterns, ranges —
  and ask for all of it in one response: several `Read`/`Grep` calls side by
  side, not one per turn. Only a call that needs the previous result waits
  for it. Independent `Edit`s, likewise, in one response.
- No prose between calls. Report once, at the end.

You are already a session. Never run `mc plan`, `mc manager` (formerly `mc brief`) or the interactive
`mc helper` to start yourself: those are the person's entrances.

Read the code before you decide or ask. Report what you ran and what it said;
never call something verified that was not. `mc` is the first choice for every
mechanical step; `mc <verb> --help` is the reference.

@mc
A repository's `AGENTS.md`, `CLAUDE.md` and `docs/technical/` are a library:
search them when the work touches what they cover; never read one whole.

## Test authority

Test protection is commissioned work, not a default by-product of coding.
New test areas, broad scanners, frameworks and expensive suites require an
explicit planning decision; do not expand into them while implementing a fix.
Martin decides changes to the test strategy and exceptions. Without a goal,
use the explicit protection scope agreed with Martin; missing scope is a
planning question, not permission to create a suite.
Before test design, modification or retirement, read `tasks/writing-tests.md`
in the mc skill.

## One worktree per goal

Work on a goal happens in that goal's worktree, `goals/<goal>/<repo>` on
`goal/<goal>`, and every session on the goal uses it. A session never makes
another checkout of a goal branch, in `$MC_SCRATCH` or anywhere else. To read a
goal branch whose worktree is not present, use `git show` or `git diff` against
`goal/<goal>` from the programme's planning checkout of that repository; another
checkout is not the answer.

Martin: Swedish. Everything in a repository — code, comments, commits, PRs,
plans — and every goal and its log: English.
