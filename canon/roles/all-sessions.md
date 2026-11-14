Tools: Bash, Read, Edit, Write, Grep, Glob, Agent, WebSearch, WebFetch; no MCP. A session may use its own tool's subagents; mc neither starts nor counts them.
A turn is the unit of cost: every turn re-reads the whole context. So:

- Search with `Grep`, find files with `Glob` — not `grep`/`sed` through Bash.
- Before you read, name everything you will need — files, patterns, ranges —
  and ask for all of it in one response: several `Read`/`Grep` calls side by
  side, not one per turn. Only a call that needs the previous result waits
  for it. Independent `Edit`s, likewise, in one response.
- No prose between calls. Report once, at the end.

You are already a session. Never run `mc plan`, `mc manager` (formerly `mc brief`),
`mc martin` or the interactive `mc helper` to start yourself: those are the person's entrances.

Read the code before you decide or ask. Report what you ran and what it said;
never call something verified that was not. `mc` is the first choice for every
mechanical step; `mc <verb> --help` is the reference.

@mc
A repository's `AGENTS.md`, `CLAUDE.md` and `docs/technical/` are a library:
search them when the work touches what they cover; never read one whole.

## Decided standards

When a question has options, ask jev first as [asking-martin](../tasks/asking-martin.md) says.

Design has two places, and no third. What runs — landed functionality — is
described once, in memoro's (or memoro-cli's) `docs/technical/`: the only
description of what the app does, with contracts, rules and budgets that hold
for every programme. What is being built — decisions, findings and design while
the work is under way — is in `~/mc/programs/<programme>/`: its README and
goals. When a goal lands, its work writes the functionality into
`docs/technical/`, and the programme README drops what `docs/technical/` now
describes. No session writes `docs/project/`; it is history. A goal's contract
narrows these for its own work and never contradicts them. Where one of them
answers a question, apply it without asking.

Where no standard answers, established practice does, before Martin does:
first a pattern the app already uses for the same problem, then the documented
behaviour of the provider or platform involved, then the widely adopted
engineering pattern that mature integrations use (idempotency keys with a
bounded lifetime, an outbox emptied after delivery, cursor-based sync). Name
the source, apply it and write it into the standard. Martin is asked only to
deviate from established practice, or where practice leaves a real product,
cost or privacy line open; that question names the practice and why it does
not suffice.

Build for the intended scope from the start. When the right design for the
intended rollout is known, do not choose a narrower interim design that has
to be rebuilt before a wider launch, and do not defer a known requirement to
"before broad rollout".

Before asking, read the relevant technical contracts and the programme README and design. State which rule answers the question and apply it, or identify the precise missing/conflicting design rule. Investigate implementation details locally. Every decision for Martin is a design-level amendment ready for `docs/technical/`: evidence, remaining uncertainty, alternatives/tradeoffs, recommendation, proposed normative wording and exact destination/section. A technical gap within existing direction is resolved in planning and recorded; only an unapproved product/privacy choice or reserved act is Martin's. After a decision, update the canonical standard and affected programme/goal contracts, not only LOG.md. A decision that reaches beyond the programme goes in `docs/technical/`; one that is the programme's alone goes in its README or the goal it governs.
>Plan writes a technical standard into `docs/technical/` within the app's
existing direction. A product or policy choice — what users see or are
promised, a cost or privacy line, the test strategy — is Martin's, and his
answer is written into `docs/technical/` when it reaches beyond the programme,
or into the programme README and the goal it governs when it is that programme's
alone, not only into a goal's log. A shared component
that falls short of a standard is changed by the work that owns it, not in
passing: a goal that finds it writes a proposal to that programme.

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
