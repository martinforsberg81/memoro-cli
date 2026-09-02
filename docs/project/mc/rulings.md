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

## 5 · An open pull request stops its project

`ruling · 2026-09-02`

The runner reads `origin/main` and the worktree and asks GitHub only after the
session, so a step whose work is in an open pull request is still `ready`
everywhere it looks. Proposed: a short session that repairs such a pull request.

> **Beslut:** "Vi ska absolut inte ha en separat session; då kan vi lika gärna
> utöka behörigheter för runner." — and for the one case that is not
> deterministic, a session that changed a field it may not touch: "Projektet
> stannar tills du tittat." (Martin, 2026-09-02)

Also ruled: only `mc merge` may be used.

## 6 · A step's comments live on the step

`ruling · 2026-09-02`

Three of five `plan-trespass` runs on 2026-09-02 were malformed
`what_the_code_taught_us` entries, not trespasses; `new-user`'s plan is
unreadable on main for the same reason.

> **Beslut:** "Flytta in i steget: `steps[i].learned`" (Martin, 2026-09-02)

**Amended the same evening, after the move was built.** The move stands; the
name does not.

> **Beslut:** "Angående what the code så tror jag flytten som är gjord är rätt
> men att den ska bli bara en 'comments' men att det behövs någonstans att
> skriva kommentarer." (Martin, 2026-09-02)

So the field is **`comments`**, not `learned`, and its purpose loosens with the
name: somewhere a session writes what it needs the next reader to know, rather
than a field whose name prescribes one kind of entry. Keep one sentence of
guidance in `docs/project/README.md` — what the next session cannot see from the
code in front of it — and let the name stay plain. A name that is a doctrine
either goes unused or gets filled with things that are not it, and the shared
field it replaces was 259 entries across 38 plans, most of them empty.

Nothing plan-level comes back. The shared field was the fault: one bad
paragraph from one session made the whole plan unreadable for every other. A
comment about something outside the writer's own step goes in that step's
`comments`, where it also says who wrote it.

**Carry it inside the pull requests that are already open**, not after them.
`learned` appears in 17 files of memoro-cli #528 (the schema, the migration
script, the role file, the documents, the tests, and two filenames —
`scripts/migrate-plan-learned.js` and `changelog.d/learned-on-the-step.md`) and
in 34 `PLAN.json` plus `AGENTS.md` and `docs/project/README.md` of memoro
#11256, every one of which those two pull requests already rewrite. Done there
it is a rename in files that change anyway. Done afterwards it is a second
schema version, a second migration across both repositories, and every plan
file rewritten twice for one word. memoro #11256 has to be rebased regardless —
it is `CONFLICTING` since 2026-09-02, because memoro #11253 and #11255 removed
two of the plans it edits.

Both built by [`runner-open-prs`](runner-open-prs/PLAN.json), and both leave this
file when it lands.

## What is still open

Nothing. The gate question — whether the runner's own merge runs one — was
answered by ruling 5: only `mc merge`.
