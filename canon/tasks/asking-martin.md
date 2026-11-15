---
name: asking-martin
description: What reaches Martin and what a session decides itself, how a call is made through mc (`mc ask`, `mc goal martin`), and how to tell him outcomes. Use before deciding what no text answers, before bringing Martin anything, and before the end-of-session account.
---
# What reaches Martin, and how to tell him

## The rule

Three things reach Martin, at the desk (`mc martin`) and nowhere else, and none of them as a question to answer in a conversation. Everything else a session decides itself.

1. A horizon that is reached, with what is now true for the user.
2. A proposed change to a text he holds, in one form: what it says, what is proposed, what was found. He holds the page for memoro me (`docs/technical/memoro-me.md` in the repository memoro), an area's aim and design decisions, a horizon's wording, a programme page's Aim (`~/mc/programs/<programme>/README.md`, section Aim) until that aim has moved to an area, and any decision recorded with his name and a date until an area page holds it. A change to the test strategy, or an exception to it, is one. Of these only the page for memoro me, the Aim and his dated decisions exist today; give no path for a text not yet written and hold no decision back for it.
3. His acts: what cannot be undone or binds Memoro outward (money, legal commitments, what is said in his name, deletion of people's data). The section on his acts of the page for memoro me (`#martins-acts`) holds the list and is right where this page differs; the order of precedence on the same page settles which aim wins when two pull apart. An act that no session can perform (a console, a physical device, a secret only he holds, an observation only he can make) comes the same way, as an act with its exact steps and what it unblocks; the work that does not depend on it continues.

Decide the rest in this order: the standards (the goal, the programme page, `docs/technical/`), the app's pattern for the same problem, the provider's documented behaviour, established practice. Name the source, apply it, and record the decision where he can read it afterwards: `docs/technical/` when it reaches beyond the programme, otherwise the programme README or the goal, never only LOG.md. A question established practice answers is decided even about privacy, security or cost. A question that would have reached him and is none of the three means a line is missing in a text: write your reading as your own, narrowing and never widening, and go on. How a change users see looks is judged by plan review and goal review against the design instruction, not by Martin beforehand; an item that asks someone to look, listen or try is settled from what can be measured (`mc shot`, the checks), and what could not be established is recorded.

A reserved act is mc's name for an act mc refuses an unattended session (`--reserved deploy|production-data|credentials|admin`): it states what code refuses, not whose act it is. It reaches the desk as an act with its exact steps and what it changes; record what waits on it in the goal or proposal and continue with the rest. Deploy is not one of his acts (Martin, 2026-11-15); it stays refused unattended until a release is checked where users meet it and can be taken back.

## What mc does with it

A call through mc carries its options; what reaches the desk does not. When unclear, read standards and programme design first. Bring one proposal, not a menu, as the brief the desk shows Martin. A change to a text he holds is brought in one form, in Swedish, three parts and no more: `## Vad den säger` (what the text says now), `## Vad som föreslås` (the wording proposed) and `## Vad som hittades` (what was found that makes the change worth his reading); it has no options and no recommendation. An act is brought with what he would notice, what waits, whether it can be undone, and the exact act and what it changes. The form is judged by mc: a brief that is not in it is refused. See [mc-martin](../../docs/technical/mc-martin.md) and [mc-jev](../../docs/technical/mc-jev.md).

```
mc ask [<programme>/<goal>] --kind technical|product --reason "…" \
  --option "<key>: <text>" --option "<key>: <text>" --recommend <key> \
  [--evidence "…" | --evidence-file <path|->] [--document <path>]… [--reserved <act>]
```

- Every call with options goes to jev first (goal-bound `mc ask <programme>/<goal>`; `mc goal martin` remains compatible). Use 2–4 whole-way options, unique keys `^[a-z][a-z0-9_]{0,31}$`, and recommend one. Session callers must give `--kind`. Never ask jev twice for one question.
- `--kind product` means the work would change a text he holds: name the text and quote what it says in `--reason`, give what was found as evidence; the options are the proposed wording and the wording that stands, each with what the work then does. `--kind technical` is everything else.
- A settled call answers as before. An unsettled `technical` call records the recommendation and continues, whatever jev reads or if jev is unavailable; jev's `product` reading is reported, never acted on. An unsettled `product` call with a goal records the evidence and sets the goal `Martin`; the unattended decision pass reads it before he does.
- Without a goal, a `technical` call is decided and ledgered. A `product` call exits 1 and changes no goal; it names the verb that brings the change to the desk: `mc martin propose --text '<the text>' --file <path|->`, with the brief in the form above, in Swedish. Run it, continue inside the wording that stands, and name the proposal in your account. The same verb is how any session with no goal leaves a change to a text of his. Interactive sessions do the same and never put it to him as a question; what Martin himself says in a session is his instruction and is carried out. Malformed calls exit 2 without writing and show a correction example.
- `--reserved <act>` never goes to jev. Never send user data or passwords; key redaction is only the guard.
- The desk's sorts are `text` (a proposed change to a text he holds) and `reserved`. `product` and `judgement` are old names of `text`: they are still read, and no new brief is written with them. No clock changes anything on the desk: a brief waits for him without limit, and nothing carries out its recommendation, closes it or moves it after a time. `--reversible yes|no` states whether the change can be undone afterwards, and nothing acts on it.

Never permission to run a check, a time budget, a quiet machine or a lane count. A `SETTLED` red goes as a proposal to the programme that owns the failing file. Build and review repair their in-scope acceptance obstacles; plan commissions broader protection. A wrong goal is no question and has no options: report it with `mc goal defect --part "…" --found "…"`; the desk amends it (a `no progress:` stop likewise). Never decide which session owns a goal: the session whose LOG.md entry took it does, until it hands over.

## How to tell him

- Write to Martin in reasoned Swedish prose, in the brief's parts. Hashes, test counts and session bookkeeping stay in the goal's LOG.md.
- Headless, your role says where a call goes: technical calls are decided by the session's recommendation, and what is his is left for the desk with the affected goal or proposal. Acceptance obstacles are repaired in-role; only merge failures wake mend.
- Tell Martin outcomes, not bookkeeping: a merge requiring judgement, anything the gate refused, or anything changing what is deployed.
- Headless hooks refuse deploy, admin, production data and credentials; record what the work waits on. At a terminal, say before an act changes deployment or what users see.
