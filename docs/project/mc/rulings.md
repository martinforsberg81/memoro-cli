# mc: the rulings

Martin's answers to the questions the `mc` programme raised, recorded in the
repository because they outlive the workarea that asked them.

Each was raised as a decision file under a `decisions/` directory at the `mc`
workarea root. That directory is not part of this repository, is not in git, and
does not survive the workarea being closed — so the answer is quoted here and
the file is cited by name, never by path. See
[`docs/project/README.md`](../README.md) § *Citing a decision*.

Where a plan already builds on a ruling, that plan is named, so a reader can
check the ruling against the thing rather than against a memory of it.

---

## 1 · `pm` and `pm-helper` go dormant; `worker` stays

`ruling · 2026-08-26` · raised as `mc-1`, owner `mc-brief`

The runner and `mc brief` replaced the resident PM and pm-helper — the
investigation §9–13 says so, and the runner had run two nights without them —
but the code, the role files and the reserved names were all still there, and
the help text still advertised them. `mc worker <name>` is different: it is a
surface that carries a role, not a daemon, and it is what Martin would use to
drive a project himself.

Options: **A** dormant now, deleted when #410 lands · **B** delete now in its own
PR · **C** leave it advertised.

> **Beslut:** A — vilande (Martin, 2026-08-26). `pm` and `pm-helper` leave the
> help text and `mc status` and answer "dormant" if typed, `worker` is kept as
> the surface Martin uses to drive a project himself and gets its role from
> `canon/roles/`; separately, the whole `mc watch` programme plus all of its
> sessions is to be removed — `~/.memoro/mc/watch/sessions-seen.json` holds 1197
> session records untouched since 2026-08-24T19:26Z, alongside `notices.jsonl`
> and `pm.log`, all debris from the world this ruling makes dormant; #410
> (`cut-old-surface`) was never coupled to this anyway, since it deletes 17 test
> files and edits four sources but does not touch `pm.js` or `pm-helper.js`, so
> its test deletions belong in the test-architecture discussion, where the aim is
> to clear out old tests that do not concern the new `mc`; if pm/pm-helper ever
> return it will be in modified form, not as they were.

Three things this settles beyond the question asked: `mc watch` and its 1197
stored session records go; #410 is **not** a prerequisite, because it never
touched `pm.js` or `pm-helper.js`; and its test deletions belong to the
test-architecture discussion rather than to this one.

Built by [`mc-dormant`](mc-dormant/PLAN.md).

## 2 · `mc helper`, and what to take from `/improve`

`ruling · 2026-08-29` · raised as `mc-2`, owner `mc-helper`

memoro already records what is needed — grouped errors in D1 `worker_errors`,
AI provider failures, nightly outcomes in `operational_events`, deploy age, D1/R2/KV
health behind the admin routes, and `scripts/admin/survey-errors.mjs`. **Nothing
read any of it without a human, and nothing alerted.**

Options: **A** `mc helper` per investigation §12.3 — a script writes a daily
digest, one Sonnet turn writes *proposals*, the runner runs it once a day, no
resident · **B** the admin UI alone · **C** an external alerting service first.

> **Beslut:** A (Martin, 2026-08-29) — sätt upp `mc helper` med intake enligt
> planen. Om `/improve`, utvärderat 2026-08-29: `/improve`
> (`~/memoro/.claude/commands/improve.md`) är en interaktiv TODO-genomgång —
> `npm run improve:sync` (`scripts/sync-todo.mjs`) hämtar `GET
> /admin/analysis` (JSON: fel + användarfeedback, prioriterade
> critical/high/medium/low, med fingerprint-referenser och berörda filer;
> `--run` kör serverns LLM-analys först) och skriver in dem i
> sentinel-regioner i `docs/TODO.md` (1511 rader, senast synkad 2026-08-26).
> Utvärdering: **maskinen bakom är bra och ska återanvändas, ytan ska inte.**
> Helperns `--collect` läser `GET /admin/analysis` direkt (samma token-läsning
> som `sync-todo.mjs`: `--token`, `ADMIN_TOKEN`, `.dev.vars`) och lägger
> analysposterna i digesten bredvid råfelen från `survey-errors.mjs`, hälsan
> och operations-status; `--run`-analysen körs på serverns egen cadence, inte
> av helpern varje dygn (den är en LLM-körning). `/improve`-kommandot och
> TODO.md-sentinelerna används inte: de gör en människa i en terminal till
> kön, kräver ett repo-commit per synk, och förslag hör hemma i
> `~/mc/intake/proposals/` där `mc brief` ser dem. Steg 1 i planen uppdateras
> med källan `/admin/analysis`; `sync-todo.mjs` avvecklas i ett senare steg
> när helpern har gått en vecka (utredningen §9: "två system som gör samma sak
> — den ena bör avvecklas").

The `/improve` half in English, since it is the part a future session acts on —
**the machinery behind it is good and should be reused; the surface should not.**

- `mc helper --collect` reads `GET /admin/analysis` directly, with the same token
  resolution `sync-todo.mjs` uses (`--token`, `ADMIN_TOKEN`, `.dev.vars`), and
  puts the analysis entries in the digest beside the raw errors from
  `survey-errors.mjs`, the health and the operations status.
- The `--run` analysis stays on the server's own cadence — it is an LLM run, and
  the helper does not pay for it daily.
- The `/improve` command and the `docs/TODO.md` sentinel regions are **not**
  used: they make a human in a terminal into the queue, cost a repository commit
  per sync, and proposals belong in `~/mc/intake/proposals/` where `mc brief`
  sees them.
- `sync-todo.mjs` is retired in a later step, once the helper has run a week —
  investigation §9, *"two systems doing the same thing; one should go."*

Built by [`mc-helper`](mc-helper/PLAN.md).

## 3 · Bare `mc` is the page, and the surfaces are two

`ruling · 2026-08-29` · raised as `mc-3`, owner `mc-ui`

Measured 2026-08-29: bare `mc` routed to the V1 sessions table and printed one
row — a session nobody had opened since June — in 0.10 s, saying nothing about
the runner, the queue or the work.

> **Beslut:** A, sharpened (Martin, 2026-08-29, decided in session — not sent
> on). Two surfaces and no more: **`mc`** is the page followed, at a TTY, by the
> menu `mc work` has today (a number or a name opens the workarea, `n` starts
> one, `b` = `mc brief`, `p <name>` = `mc plan`, `s <name>` = `mc status <name>`,
> `w` = watch, `q`); without a TTY, or with `--json`, it prints and exits.
> **`mc --watch [seconds]`** is the same page redrawn until ctrl-c, no prompt.
> Everything else that lists goes in the same project, not deferred to #410: bare
> `mc work` becomes `mc`; `mc list`, bare `mc status`, `mc status
> --sessions|--watch|--wait` and the old board (`status-board.js`,
> `status-render.js`'s board, `work-status.js`) are removed; `mc status <name>`
> stays as the one-project detail (a detail, not a list); `mc work <name> …` and
> its verbs stay. The PROJECTS section becomes WORK: one numbered row per
> workarea with the plan's status and `next`, and one count line for projects on
> main without a workarea. The plan `docs/project/mc/mc-ui/PLAN.md` is `ready`
> with this design written in; the runner executes it.

Built by [`mc-ui`](mc-ui/PLAN.md).

## 4 · `mc test` is one measurement with two runs

`ruling · 2026-08-29` · raised as `mc-test-1`, owner `mc-test`

**No `mc-test` plan exists.** This ruling is not carried by any plan, which is
why it is written out here in more detail than the three above — until a plan
picks it up, this document and
[`mc-test/ground-2026-08-29.md`](mc-test/ground-2026-08-29.md) are the whole
record of it. That file is the workarea's handoff — the file:line map, what to
reuse, the memoro-side step that comes first — carried in before the workarea
was removed, with every reference re-checked against main.

The sequence was already half split out. `repo-merge.js:66 runMergeRound` is the
landing round; `repo-gate.js:87 runGate` is the measurement and **cannot** merge,
with a test asserting against the file's own source that it stays that way
(*"There is no way to merge a red gate. Not a flag, not an option, not an
environment variable."*). `mc merge <repo> <pr> --check` was already `mc test`
under a name nobody looks for.

Two measurements were asked for:

- **A — "this went red because of your work."** Differential and fast. The
  candidate side runs the repository's declared `affected` command; the baseline
  side is **not run at all** — it is compared against main's already-known red
  set.
- **B — "this is red for the whole repository."** Full, slow, rare. Runs the
  whole suite on one tree and writes the red set as the repository's known state.

The coupling is the point: **B produces exactly what A compares against.**

> **Beslut:** Uppdelningen genomförs enligt rekommendationen (Martin,
> 2026-08-29).
>
> `mc test` bryts ut som ett namngivet steg i `mc merge`s sekvens, med **en**
> mätimplementation som båda vägarna delar — `mc merge <repo> <pr> --check` är
> dagens dörr till samma runda och ersätts av det nya verbet. Två mätningar: **A**
> kör repots deklarerade `affected` på kandidaten och jämför mot main:s kända röda
> mängd utan att köra baselinesidan; **B** kör hela sviten och skriver den kända
> mängden. B produceras när runnern är idle (`run.js:279`, 600 s-sömnen), och en
> merge betalar bara A. `mergePr` (`run.js:148`) ersätts så att runnern går samma
> väg som `mc merge` och inte kan landa ogated — rad 224 är den enda dörren.
>
> De tre villkoren gäller och är inte förhandlingsbara: trunkeringshålet i
> `memoro/scripts/testing/runner.mjs:108` stängs **innan** A tas i bruk, annars
> mäter både A och B halva sviten och två trunkerade mängder läses som "no new
> red"; A:s verdict bär sin egen räckvidd (hur många filer selektionen valde, och
> att den är blind för 2 114 pin-par); och rapporten bär B:s ålder — vid vilken
> commit main mättes och hur många commits sedan.
>
> Fråga 1 — måltyper: PR-formen först, eftersom den ger uppsnabbningen och ersätter
> `mergePr`. Arbetsträdsformen (utan PR, för sessioner som analyserar och förbättrar
> repot) blir ett eget steg efter att PR-formen sitter, inte ett villkor för den.
>
> Fråga 2 — memoro-cli:s `affected` deklareras som `ownTests`: det är byggt
> (`repo-gate.js:852`), ärligt om sin smalhet, och gör ingenting sämre än idag. En
> bredare selektion byggs inte på spekulation.
>
> Fråga 3 — `mc merge` **varnar högt** när B är stale, den vägrar inte. En grind som
> vägrar på en tidsstämpel blir en grind folk går runt.
>
> Utanför detta projekt, men beslutat i samma andetag: memoro-cli:s `npm test` får
> en `--test-concurrency`-cap och load-flakinessen mäts om **innan #410 avgörs** —
> orsaken är den okapade parallelliteten, inte testerna som raderas.

### The three non-negotiable conditions, in one place

1. **Close the truncation hole first.** `memoro/scripts/testing/runner.mjs:108`
   is `if (result.code !== 0 || result.signal) break;`. The batches are separate
   `node --test` processes, so a red standard batch means sqlite and heavy
   **never run**; `tapTotals` (`tap-red.js:93`) takes the last `# tests` line, so
   a truncated run reports `finished: true` with the first batch's summary. Both
   A and B would then measure half the suite, and two truncated sets match each
   other and read as "no new red". With standing red names on main, one of them
   in the standard class is enough to make this live.
2. **A's verdict carries its own reach** — how many files the selection chose,
   and that it is blind to 2 114 pin pairs. Never "everything is green".
3. **The report carries B's age** — at which commit main was measured, and how
   many commits ago.

### Two things this ruling also settled

- **memoro-cli's `affected` is `ownTests`** (`repo-gate.js:852`) — the tests a PR
  itself adds or changes. Narrow, honest, already built, and no worse than today.
  memoro's is declared: `npm run ci -- --base-ref origin/main`.
- **memoro-cli's `npm test` gets a `--test-concurrency` cap, and the
  load-flakiness is re-measured before #410 is decided.** The cause is uncapped
  parallelism — 8 workers on 8 GiB, with mc's own heavy-job guard off because
  `~/.memoro/config.json` has no `resources` key — not the tests #410 deletes. A
  cap is one line and addresses the cause; deleting 22 test files addresses the
  symptom.

## What is still open

Nothing here. The eight open questions across `~/mc` on 2026-08-29 all belong to
memoro's programmes, not to `mc`.
