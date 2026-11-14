---
name: asking-martin
description: Asking Martin a question or reporting to him in mc — a decision only he can make, a blocked step or goal, the end-of-session account. Use before asking a question, blocking on an answer, or writing what you tell him.
---
# Asking Martin, and telling him

Never a question without its options. When unclear, read standards and programme
design first. Bring one proposal, not a menu, at design level: evidence,
alternatives/tradeoffs, recommendation and proposed wording/file/section in
`docs/technical/`; see [mc-jev](../../docs/technical/mc-jev.md).

Every question with options goes to jev first. `product` is a choice of direction
the goal, programme page and standards do not answer, changing user promises,
product cost, personal-data handling or test strategy. `technical` is everything
else: implementation, architecture, tooling, environment, order of work, whether
a goal adopts or changes what its own criteria need, and carrying out an already
decided design, even when users see it.

Use goal-bound `mc ask <programme>/<goal>` (`mc goal martin` remains compatible); without a goal, use `mc ask` before asking Martin in chat:

```
mc ask [<programme>/<goal>] --kind technical|product --reason "…" \
  --option "<key>: <text>" --option "<key>: <text>" --recommend <key> \
  [--evidence "…" | --evidence-file <path|->] [--document <path>]… [--reserved <act>]
```

- Use 2–4 whole-way options, unique keys `^[a-z][a-z0-9_]{0,31}$`, and
  recommend one. Session callers must give `--kind`; a person may omit it.
- One consultation answers as before when jev settles. An unsettled technical
  call records the recommendation and continues, whatever jev reads or if jev is
  unavailable. The product reading is reported, never acted on.
- Unresolved product choices and reserved acts reach Martin; a goal-bound result records
  the evidence and sets the goal Martin. Technical decisions are logged in the
  goal and jev ledger. Never ask jev twice for one question.
- A no-goal technical call is decided and ledgered without changing a goal. A no-goal product call exits 1 and changes no goal. Malformed calls exit 2 without writing and show a complete correction example.
- Reserved acts use `--reserved <act>` and never go to jev. Never send user data
  or passwords; key redaction is only the guard.

## What reaches Martin

Only three kinds reach Martin: a product choice the goal, programme page and standards do not answer; a judgement (look, listen, try), with material ready; or a reserved act (`mc deploy`, money, production data, credentials, `--admin`). A question established practice answers is technical even about privacy, security or cost, and even when labelled policy. The unattended decision pass settles it before Martin sees the item; a reversible product choice or judgement may default after its brief has waited two days, never an irreversible choice or reserved act. An exception to a standard follows the same kind-based route: technical exceptions are decided by the session; product choices and reserved acts reach Martin. Write the decision where the standard belongs.

Never permission to run a check, a time budget, a quiet machine or a lane count.
A `SETTLED` red goes as a proposal to the programme that owns the failing file.
Build, review and finish repair their in-scope acceptance obstacles; plan
commissions broader protection. Never decide which session owns a goal: the
session whose LOG.md entry took it does, until it hands over.

## How to ask and tell

- Write to Martin in reasoned Swedish prose: system/programme impact, the rule, evidence, uncertainty, alternatives, recommendation and proposed wording. Hashes, test counts and session bookkeeping stay in the goal's LOG.md.
- Headless, your role says where a question goes. Technical questions are decided
  by the session's recommendation; product choices and reserved acts reach
  Martin. Acceptance obstacles are repaired in-role; only merge failures wake mend.
- Tell Martin outcomes, not bookkeeping: a merge requiring judgement, anything
  the gate refused, or anything changing what is deployed.
- Headless hooks refuse deploy, admin, production data and credentials; record
  what the work waits on. At a terminal, say before an act changes deployment or
  what users see.
