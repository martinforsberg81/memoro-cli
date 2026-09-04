# mc: the rulings

Martin's answers to the questions the `mc` programme raised, held here only until
the code carries them — a ruling whose plan has been built is deleted at that
plan's close-out, and what it settled then lives in `docs/technical/` and in the
`project_log.md` row. Keep each entry short: the question in a sentence or two,
the answer quoted, and the plan that builds it.

Each was raised in an `mc plan` session or as a decision file under a
`decisions/` directory at the `mc` workarea root. That directory is not part of
this repository and does not survive the workarea, so an answer is quoted here
and a file cited by name, never by path. See
[`docs/project/README.md`](../README.md) § *Citing a decision*.

---

## 4 · `mc test` is one measurement with two runs

`ruling · 2026-08-29` · raised as `mc-test-1`, owner `mc-test`

**Carried by `docs/project/mc/mc-test-round/PLAN.json`** since 2026-08-31, which
is where the work happens; it is written out here in more detail than the three
above because it was unowned for two days and this document was the whole record
of it. The plan is named `mc-test-round` rather than `mc-test` for a mechanical
reason: `repoOf` in `src/mc/run.js` is a literal `[memoro, memoro-cli]` and
returns the first repository with a worktree in the workarea, so a plan named
after a workarea that holds both checkouts is looked for in memoro, not found,
and skipped.

**Its differential half was overruled on 2026-08-31**, and the paragraphs below
are kept readable rather than rewritten. Martin ruled that a round evaluates the
diff: it does not run or consult a baseline, and whether main was already red is
not the round's question. Measurement A stands, without the comparison — one
tree, and a test the change reaches is either green or the round is red.
Measurement B is not scheduled; it is `mc test <repo> --full`, asked for.

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

Read against the overrule above: **1** still holds and matters more, because a
truncated single side under-reports red with nothing to catch it. **2** holds,
and the reach is now a count in the verdict rather than a sentence — the
blindness half of it was dropped on 2026-08-31, being a fact about the selector
that a reader can do nothing with. **3** is void: there is no B for the report
to carry the age of.

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

## 5 · A loose thread is a proposal, and every role may write one

`ruling · 2026-09-04` · raised in the `mc` planning session

Sessions were handing Martin what they had found but were not going to do —
loose threads, and the practical bookkeeping of getting work to `main` — inside
their answer to him, where it is his to file.

> **Beslut:** "Jag vill inte att du diskuterar praktikaliteter med mig. För
> dialog med mig om design-, arkitektur eller viktiga UI-frågor. Om det gäller
> eventuella förbättringar skriver du en proposal. Allt annat förväntar jag mig
> att du löser." … "Lösa trådar hör hemma i antingen mc/intake/ eller
> mc/proposals/. Inte direkt i ett svar till mig." (Martin, 2026-09-04)

Asked which sessions may write one, he ruled **all of them** — brief, helper,
intake, plan, step, worker, reconcile and repair alike. `~/mc/proposals/` is the
channel: it is read at the brief. `~/mc/intake/` is not, and the planning
session confirmed why — `helperPrompt` (`helper-turn.js:63`) hands the intake
turn its material explicitly rather than sending it to read the directory, and
`brief-collect.js:533` reads three filenames. A file put there by hand reaches
no reader, so nothing here tells a session to leave one.

Asked how a rule that applies to every role should be written, he ruled **one
shared entry every role inherits, and the catalogue cut in the same project** —
the turn-cost paragraph is byte-identical in four role files today with variants
in two more.

**Carried by [`role-instructions/PLAN.json`](role-instructions/PLAN.json).**

## 6 · A planning session runs on fable

`ruling · 2026-09-04` · raised in the `mc` planning session

The role concept had `plan` on `fable` from the start; `canon/roles/plan.md`
shipped on `opus` and nobody had placed it deliberately since.

> **Beslut:** "Plan ska i utgångspunkt köra fable." (Martin, 2026-09-04)

One word of frontmatter, but not one that can be asserted from the file:
`prices.js:21` maps the alias for costing, while `modelArgs`
(`src/adapters/claude-code.js`) passes the string to the tool unvalidated on
purpose. A name the tool refuses fails at launch and nowhere earlier, so the
step opens a planning session on it once.

**Carried by [`role-instructions/PLAN.json`](role-instructions/PLAN.json).**
Where `repair` and `reconcile` sit in the same concept is not settled; neither
existed when it was written.

## 7 · `reconcile` is not a session kind

`ruling · 2026-09-04` · raised in the `mc` planning session

Asked to look the concept over: *"Jag tror inte att det är korrekt utformat, ska
det ens finnas?"* The planning session measured `~/mc/runner/log/runner.log` and
`runs.tsv` rather than arguing it: **67 conflict events, 166 conflicting files,
64 reconcile sessions, 519 minutes of model time.** Of the 67 events, **37 had
nothing in them but an append-only log, a generated artifact or a plan file**;
13 were mixed; 17 were real code. The genuine tail is 75 distinct files over 88
occurrences — almost no repetition.

> **Beslut:** alla tre lagren, `reconcile` försvinner (Martin, 2026-09-04).

The three: `.gitattributes` in both repositories, so git resolves the
append-only log and the generated artifacts with no session at all; the runner
resolving a `PLAN.json` conflict with `unauthorisedChanges`, the rule that
already says who may write what; and the residue handed to the **step** session,
which has to read the code anyway, instead of to a cold session that merges and
stops.

One correction to the record: the `fold-reconcile-into-step` proposal
(2026-09-02, consumed and deleted by this plan) said a conflicted step round
aborts and defers to the next round. That has not been true since; the round
launches the reconcile immediately. The cost is a wasted session, not a wasted
round.

Conditional, and not negotiable: `merge=generated` means *keep ours*, and
memoro's own `.gitattributes` says correctness then rests on a mandatory drift
gate. `npm run sdk:check` exists (`package.json:143`) and is not in the gate
memoro declares as `affected`. The SDK artifacts get the driver only after it
is.

**Carried by [`no-reconcile/PLAN.json`](no-reconcile/PLAN.json)** and, in memoro,
by `docs/project/test-architecture/generated-artifact-merge/PLAN.json`.

## What is still open

**`mc repo` is legacy** (Martin, 2026-09-04: *"`mc repo` ska inte finnas som
kommando. Det är legacy."*). The verb list `mc-cut` fixed (#543) never named
it, and it still carries eight sub-verbs in `src/mc/commands/repo.js`: `status`,
`watch`, `nightly`, `claim`, `release`, `who`, `rounds`, `guard`, `push-check`.
[`test-nightly/`](test-nightly/PLAN.json) moves `nightly` under `mc test`,
because `test-architecture` in memoro waits on it. Where the other seven go —
the page, `mc merge`, or nowhere — is this programme's next planning question,
and `mc repo merge`'s exit-2 pointer is the form a retired sub-verb takes.

Rulings 5 (*an open pull request stops its project*, and with it "only `mc
merge` may be used") and 6 (*a step's learning lives on the step*) were here
until the `runner-open-prs` project landed them. A ruling lives only until the
code carries it: the first is `inFlight` and the gated round in
`src/mc/run.js`, the second is `steps[i].comments` in `src/mc/plan-schema.js`,
both are described in [`docs/technical/mc-run.md`](../../technical/mc-run.md),
and the row is in [`project_log.md`](../project_log.md).
