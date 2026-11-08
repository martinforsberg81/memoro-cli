---
name: asking-martin
description: Asking Martin a question or reporting to him in mc — a decision only he can make, a blocked step or goal, the end-of-session account. Use before asking a question, blocking on an answer, or writing what you tell him.
---
# Asking Martin, and telling him

Never a question without its options. When unclear or settled, read first; apply technical standards and programme design.
Investigate details as general rules. Bring one proposal, not a menu: a design decision with evidence, costs/tradeoffs, alternatives, recommendation
and proposed rule text/file/section in docs/technical/; see mc-jev.md.

Every question with options goes to jev first (docs/technical/mc-jev.md).
For goal questions, use `mc ask <programme>/<goal>` as the single goal-bound path;
`mc goal martin` remains compatible. Without a goal, call `mc ask` before asking Martin in chat:

```
mc ask [<programme>/<goal>] --reason "…" --option "<key>: <text>" --option "<key>: <text>" \
  --recommend <key> [--evidence "…" | --evidence-file <path|->] [--document <path>]… [--reserved <act>]
```

- 2–4 whole-way options, unique keys `^[a-z][a-z0-9_]{0,31}$`; recommend your
  proposal and include evidence. A malformed call gives an example to fix.
- Goal-bound `mc ask` is one complete escalation: one jev consultation; an
  answer leaves stage/status unchanged, appends its trace and continues. A valid
  unresolved, unavailable or reserved result logs safe question/options/recommendation/
  evidence/reading and sets that goal directly to Martin. Do not call `mc goal martin`
  again or route through mend. Invalid calls exit 2 with no mutation; a no-goal ask changes no goal.
- Reserved acts use `--reserved <act>`, never jev. Never send user data or passwords: key redaction is only the guard.

## What reaches Martin

Three things, and nothing else:

- A reserved act: `mc deploy`, production data, credentials, `--admin`.
- A product or policy choice that no decided standard answers (all-sessions,
  Decided standards). His answer is written where the standard belongs, so the
  same question is never asked twice.
- An exception to a decided standard, named and bounded.

Never permission to run or rerun a check, a run or time budget, a quiet machine
or a lane count. Never a red that is `SETTLED` (red alike at the base): it is
not the goal's, and goes as a proposal to the programme that owns the failing
file. The owning build, review or finish role resolves in-scope acceptance repairs;
plan commissions broader protection scope. Never which session owns a goal: the one whose LOG.md entry took it, until it hands
over.

## How to ask and tell

- Headless, there is nobody to ask: your role says where the question goes.
  Build, review and finish repair their own in-scope acceptance obstacles. An
  actual design choice or reserved act goes directly to Martin; continue on a jev
  answer. Only merge failures wake mend.
- Tell Martin the outcome, not the bookkeeping. His, in one line with your
  recommendation: a merge that needed your judgement to go green, anything the
  gate refused, anything that changes what is deployed.
- A headless session cannot do `mc deploy`, `--admin`, production data or
  credentials: the hook refuses them (`MC_HEADLESS=1`). Work that needs one
  waits, and your entry says what it waits on. With Martin at the terminal,
  an act that changes what is deployed or what users see is said in one line
  before it runs.
