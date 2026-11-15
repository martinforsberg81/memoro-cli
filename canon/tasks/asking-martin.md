---
name: asking-martin
description: What reaches Martin and what a session decides itself, how a call is made through mc (`mc ask`, the one way to ask), and how to tell him outcomes. Use before deciding what no text answers, before bringing Martin anything, and before the end-of-session account.
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

Never a question without its options. What reaches the desk is not a question but a brief, and for a text change it carries no options. When unclear, read standards and programme design first. Bring one proposal, not a menu, as the brief the desk shows Martin. A change to a text he holds is brought in one form, in Swedish, three parts and no more: `## Vad den säger` (what the text says now), `## Vad som föreslås` (the wording proposed) and `## Vad som hittades` (what was found that makes the change worth his reading); it has no options and no recommendation. Options and a recommendation stay for a reserved act alone: it is brought with what he would notice, the options as their consequences, one recommendation with its reason, what waits, whether it can be undone, and the exact act and what it changes. The form is judged by mc: a brief that is not in it is refused. See [mc-martin](../../docs/technical/mc-martin.md) and [mc-jev](../../docs/technical/mc-jev.md).

```
mc ask [<programme>/<goal>] --reason "…" \
  --option "<key>: <text>" --option "<key>: <text>" --recommend <key> \
  [--evidence "…" | --evidence-file <path|->] [--document <path>]… [--reserved <act>]
```

- There is one way to ask: `mc ask`, with a goal (`mc ask <programme>/<goal>`) or without. Use 2–4 whole-way options, unique keys `^[a-z][a-z0-9_]{0,31}$`, and recommend one. Never ask twice for one question. `mc goal martin` is gone: it exits 2 and prints the `mc ask` call to make.
- The call answers inside itself, in order. jev reads it first. When jev does not settle it, a fresh read-only reader (the `ask-reader` role, on the `decision` model list, at most ten minutes, in a read-only copy of your worktree) answers it before the call returns. Run `mc ask` in the background when your tool call cannot wait fifteen minutes. The answer is one of four, and the call prints which: continue with an option (the standards, the app's pattern, the provider or established practice settle it); the goal itself is wrong (recorded exactly as `mc goal defect`, the goal waits for the desk); a text of his would change (a desk item, `mc martin propose`, in the form above; you continue inside the wording that stands); or unread (nothing could read it: continue with your recommendation, and the desk sees it as unread).
- You never say what kind of question it is. `--kind` is accepted and ignored, with one line on stderr; whether a text of his would change is the reader's finding, not the asker's.
- Nothing makes a goal wait on Martin except a reserved act and a reader's finding that the goal is wrong. A change to a text of his never does: the call says to continue inside the wording that stands, and names the proposal in your account. A malformed call exits 2 without writing and shows a correction example.
- Every answer is a ledger row that says who answered (jev, the reader, the session by its recommendation, or Martin) and that Martin reads and overturns at the desk (`mc decisions`, `mc martin`). A row the reader answered with another option than your recommendation, and every unread row, reaches the desk.
- `--reserved <act>` never goes to jev or the reader. Never send user data or passwords; key redaction is only the guard.
- The desk's sorts are `text` (a proposed change to a text he holds) and `reserved`. `product` and `judgement` are old names of `text`: they are still read, and no new brief is written with them. No clock changes anything on the desk: a brief waits for him without limit, and nothing carries out its recommendation, closes it or moves it after a time. `--reversible yes|no` states whether the change can be undone afterwards, and nothing acts on it.
- Without a goal, the same call is made and ledgered; a reader's finding that a text of his would change is brought to the desk with `mc martin propose --text '<the text>' --file <path|->` (the brief in the form above, in Swedish). The same verb is how any session with no goal leaves a change to a text of his. Interactive sessions never put a question to him; what Martin himself says in a session is his instruction and is carried out.

Never permission to run a check, a time budget, a quiet machine or a lane count. A `SETTLED` red goes as a proposal to the programme that owns the failing file. Build and review repair their in-scope acceptance obstacles; plan commissions broader protection. A wrong goal is no question and has no options: report it with `mc goal defect --part "…" --found "…"`; the desk amends it (a `no progress:` stop likewise). Never decide which session owns a goal: the session whose LOG.md entry took it does, until it hands over.

## How to tell him

- Write to Martin in reasoned Swedish prose, in the brief's parts. Hashes, test counts and session bookkeeping stay in the goal's LOG.md.
- Headless, a call goes to `mc ask` and is answered inside it; what is his is left for the desk with the affected goal or proposal. Acceptance obstacles are repaired in-role; only merge failures wake mend.
- Tell Martin outcomes, not bookkeeping: a merge requiring judgement, anything the gate refused, or anything changing what is deployed.
- Headless hooks refuse deploy, admin, production data and credentials; record what the work waits on. At a terminal, say before an act changes deployment or what users see.
