# mc dormant — one world on the surface

`mc --help` describes one system now. Work is a `PLAN.json` under
`docs/project/`; `mc run` takes its steps; `mc brief` is the hour the
questions get answered; `mc plan` and `mc worker` are the two sessions
Martin drives himself; `mc` is the page that says what is running. There is
nothing resident behind any of it — no daemon, no watcher, no inbox anyone
has to drain.

It read differently until 2026-08-29. Alongside those verbs the help offered
a resident PM (`mc pm`), its research assistant (`mc pm-helper`), and a
`mc watch` programme with two legs — a PM round every 30 minutes and a
watchman over every running conversation, feeding a notices ledger and a
wake queue. Ruling `mc-1` (2026-08-26, option A) had already given that work
away. This note is what executing it cost. Cited by name and not by path: it
was written in a workarea, which no checkout contains and nothing keeps.

## Where each job went

| the PM did | now |
|---|---|
| triage: what to work on next | `mc run` — the queue is `~/mc/queue.md` and every `ready` plan on `origin/main` |
| holding the queue | the same; `queue.md` is a strict list of names that empties itself |
| taking questions to Martin | `mc brief` — the proposals waiting in `~/mc/proposals/` are the agenda |
| waking the sessions that stalled | nobody; a step session is one fresh headless conversation that ends |
| the boards | `mc` — the one page (decision mc-3) |

The PM was the middle of a world where sessions were long-lived and had to
be kept moving. The runner replaced that world rather than that session: a
step is a fresh session with one job, and it stops when the PR exists.
Nothing is left to nudge.

## `mc pm` and `mc pm-helper` are dormant, not deleted

Both answer one line and exit 2:

```
$ mc pm
mc pm is dormant — the runner and mc brief replaced it (decision mc-1)
```

They are gone from `mc --help` entirely — a verb that answers "dormant"
while the help still advertises it is the same confusion with extra steps.

What stays is the machinery underneath: `src/mc/commands/role-singleton.js`
(317 lines — one workspace for a role, ever), `src/mc/pm-helper-intake.js`
(the intake file forms), and the reserved names in
[`roles.js`](../../src/mc/roles.js) — `pm`, `pm-helper`, `helper` — which
still refuse `mc worker pm`. The impostor guard is right whether or not a PM
runs, and if a PM returns it returns in modified form. Deleting the code
belongs with the wider surface cut (PR #410) and the test-architecture
question under it, not with the ruling.

The one place dormancy shows through is that guard's wording: `mc worker pm`
is refused with "that workspace is created by its own command (`mc pm`)",
and `mc pm` then says it is dormant. Two hops, each honest, and the name
stays protected either way. `helper` is reserved on the same list and points
at `mc pm-helper` — while the live `mc helper` is a different thing that
creates no workarea at all. Both readings are for the cut to settle, not the
ruling: the refusal is still the right refusal.

Code that is kept is code that is tested. The singleton's semantics were
exercised through the CLI, which no longer routes there, so they now run
through [`tests/mc/_helpers/role-singleton-entry.js`](../../tests/mc/_helpers/role-singleton-entry.js)
— the same subprocess shape, one hop closer to the module.

## The `mc watch` programme is deleted

Not dormant: its two legs watched a world that no longer exists. **29 files
and 5 864 lines** went — 20 modules (`commands/watch.js`, every `watch-*.js`,
`watchers-state.js`, `wake-queue.js`, `wakeup.js`) and their 9 test files —
with every importer rewritten rather than kept alive for the import.

`~/.memoro/mc/watch/` went with them, once, by hand: seven files, 712 K,
untouched since 2026-08-24 — 1 197 session records, `notices.jsonl` and
`pm.log`.

Three things changed on the outside, and only three.

**A wake refused on a draft is reported, not queued.** `mc work send --wake`
never types over a draft in somebody's prompt; it used to queue the knock and
tell the sender it would land when the prompt cleared. The only thing that
ever retried a queued wake was the watchman's round. With the watchman gone
the queue had nobody to keep its promise, so the queue went and the sender is
told what actually happened:

```
mc: a draft is in <name>'s prompt, so nothing was typed — it reads its inbox
    at its next turn, or knock again once the prompt is clear
```

The delivery is untouched — the file is in the inbox either way — and so is
the guarantee that nothing types over a draft. D-0186's stopped-tool special
case went too: it existed to decide *who would retry*, and now nobody does,
so both cases say the same thing.

**The watchers row is gone from the boards.** `watchers-state.js` named three
watchers, two of which this removed; deleting it took the third — the
repository watcher — off the old `--sessions` board and out of `mc doctor`'s
not-in-force list, which now checks the push guard and the red ratchet.
`mc repo watch status` is unchanged and is the only place that answers for
it.

**`mc repo watch` is a different mechanism and is untouched.** It refreshes
`mc repo status`'s snapshot and has nothing to do with sessions or with the
PM. It is the one watcher `mc --help` still names, and
`tests/mc/commands/dormant.test.js` asserts exactly that: every line of the
help containing `watch` must be a `mc repo watch` line.

## The worker role now ships with mc

`mc worker <name>` marks a workarea with a role, and every conversation
started in it — lead or agent, now or later — inherits that role's overlay
and model default. The definition used to be read from
`~/.memoro/mc/roles/worker.md`, a catalogue mc does not install, so the one
role mc still launches depended on the user having written it: a fresh
machine got the area and none of the role.

It is [`canon/roles/worker.md`](../../canon/roles/worker.md) now, read
through `readCanonRole` the way `mc plan` and `mc brief` read theirs, and
`areaRole` falls back to canon so conversations opened in the area later get
the overlay too. A catalogue that defines `worker` still wins — it is the
user's rulebook — but it is no longer required for a worker to exist. The
lookup and the assembly around it are [`mc-roles.md`](mc-roles.md).

The overlay is what the removal is really about. A worker has no PM to
escalate to, no inbox to write into and nothing watching its pane, so a
question only Martin can answer stops the step: `status: blocked` with
`blocked_by` saying what the answer has to be about, and the question itself in
the pull request, written as a proposal he says GO to. That is the same channel
`mc plan` and the runner's step sessions use.

## How it is tested

[`tests/mc/commands/dormant.test.js`](../../tests/mc/commands/dormant.test.js)
is the surface, in four parts: each dormant verb says its line and exits 2;
`mc watch pm status` is refused as an unknown command; `mc repo watch status`
still answers; and `mc --help` shows one world — no `mc pm`, no watcher but
the repository one, and still `mc brief`, `mc plan <name>` and
`mc worker <name>`. Asserting the help alongside the dispatch is deliberate:
the two drifting apart is the failure this project exists to end.
