---
name: asking-martin
description: Asking Martin a question or reporting to him in mc — a decision only he can make, a blocked step or goal, the end-of-session account. Use before asking a question, blocking on an answer, or writing what you tell him.
---
# Asking Martin, and telling him

A question for Martin is one thing: what you found, what it costs, what you
would do. Never a question without its options. Never ask while the question
is unclear or reading would settle it: then read.

Every question with options goes to jev first (docs/technical/mc-jev.md).
For a goal's question, use `mc goal martin`; it asks jev itself, so do not also
call `mc ask`. From any other session, call `mc ask` before asking Martin in
chat:

```
mc ask [<programme>/<goal>] --reason "<the question>" \
  --option "<key>: <text>" --option "<key>: <text>" --recommend <key> \
  [--evidence "…" | --evidence-file <path|->] [--document <repo>/<path>]… \
  [--reserved deploy|production-data|credentials|admin]
```

- 2 to 4 options, each a whole way to proceed, keys `^[a-z][a-z0-9_]{0,31}$`
  each once. They are not a menu: `--recommend` is your proposal among them;
  evidence is what you found and tried. A malformed call is refused with an
  example: fix it, call again.
- For a goal question, when `mc goal martin` prints `mc: jev answered <key>
  (…) — continue with: <text>`, continue with that answer as if Martin had given
  it. Otherwise the goal is `Martin` with jev's reading; end as your role says.
- In an interactive session, when `mc ask` answers, continue and name its answer
  in your end-of-session account. Otherwise ask Martin in chat with the options,
  your recommendation and jev's reading line. A build or review session may use
  `mc ask` when the goal may settle its question; continue on an answer,
  otherwise block as its role says.
- A reserved act goes with `--reserved <act>`, never to jev. No user data or
  passwords in a question: key redaction is only the guard.

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
file. Never a repair the goal's own acceptance needs: plan commissions it. Never
which session owns a goal: the one whose LOG.md entry took it, until it hands
over.

## How to ask and tell

- Headless, there is nobody to ask: your role says where the question goes.
  Build and review report an obstacle as `blocked`, which a mend session takes.
- Tell Martin the outcome, not the bookkeeping. His, in one line with your
  recommendation: a merge that needed your judgement to go green, anything the
  gate refused, anything that changes what is deployed.
- A headless session cannot do `mc deploy`, `--admin`, production data or
  credentials: the hook refuses them (`MC_HEADLESS=1`). Work that needs one
  waits, and your entry says what it waits on. With Martin at the terminal,
  an act that changes what is deployed or what users see is said in one line
  before it runs.
