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

## 2026-10-27 · `blocked-plan-amendment`

**Question.** A reviewed project cannot carry its authorized correction:
ordinary verbs freeze both a sent contract and its blocked step. May mc add
a bounded, validated amendment while the project stays blocked, rather than
release old instructions or edit its JSON outside the verbs?

**Answer.** Martin: “Ja, go.” This answers the recommendation for that mc
change, followed by updating and releasing `docx-model`.

**Carried by.** The in-session `plan/text-safe-plan-amendment` change,
consuming proposal `2026-10-27-mc-amend-blocked-project-plan`, and then the
existing `docx-model` plan. The verb preserves completed steps and execution
history, refuses active sessions and open PRs, validates the whole result,
records authorization and does not release the step. Ordinary edit freezes
are unchanged. Its input and failure contract are in
[Amending a blocked project](../../technical/mc-project-amend.md).

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

## 8 · The inbox is drained one file at a time

`ruling · 2026-09-04` · raised in the `mc` planning session

`~/mc/intake/` had grown into a room nothing empties: thirteen daily digests
back to 2026-08-29, three tables `mc run` rewrites every round, and one turn a
day reading one of them. Asked what it is for, Martin said it holds unsorted raw
material — an error log, a screenshot — and that a session that has already
understood something writes a proposal directly instead.

> **Beslut:** "läsa in en fil i taget och bedöma med outcome proposal eller inte
> proposal. Filen arkiveras direkt efteråt. Ny session upprepas tills alla filer
> är hanterade." (Martin, 2026-09-04)

Two consequences the planning session read out of the code rather than asking
about. The turn must **read the file itself** instead of being handed its text:
`helperPrompt` inlines `digestText` today, and a screenshot has no text to
inline. And the runner's three tables must **leave the directory first** —
`mc run` rewrites `unplanned-workareas.md` and `unreadable-plans.md` whole every
round, so archiving one brings it back next round, forever.

Archiving unconditionally is Martin's word and also the only version that
terminates: a file kept because its turn failed is one the next round takes
again.

**Carried by [`intake-inbox/PLAN.json`](intake-inbox/PLAN.json)**, and it moved
[`role-instructions`](role-instructions/PLAN.json)'s contract, which had said
intake stays as it is.

## 9 · A test environment, in dev and in prod

`ruling · 2026-09-05` · answers `mc-dev-1`, raised by `mc-dev-protocol` step 1

Two questions arrived on the same day from opposite directions. The runner's
step 1 (#628) asked whether `mc dev`'s cross-worktree inventory should come
back or its caller be removed, and recommended **remove** on a clean
measurement: 565 invocations in a month, ten of them by a person, and 33
registered manifests with not one live pid. Martin, in the planning session and
without having read that PR, asked for something the measurement had not
imagined.

> **Beslut:** "Utvecklar ett mc test dev / mc test prod. Det vill säga
> tillhandahåller en miljö för testning både i dev och prod. Enkel och smidig
> att hanteras. Lokalt kan alltså köras en dev-server som alla olika sessioner
> kan använda inkl. runner sessionerna." … "Inget av detta är tänkt att per
> automatik köras av varje runner session. Detta är tänkt att förenkla tester
> när det faktiskt behövs för planering, felanalys eller verifiering. För vissa
> tester ska stämma måste det göras mot prod miljö." (Martin, 2026-09-05)

So `mc-dev-1` is answered **restore**, and the measurement that said otherwise
is not overturned — it is answered by its own last sentence: *"if that need
comes back it comes back with a person behind it."* It did. An index with one
honest consumer is a different object from an index with none, however
identical the files look. Three verbs, `list`/`register`/`unregister`, and
`list` sweeps what it reads, which is the half the old one was missing.

Four things Martin settled when asked how the environment should work:

- **One shared dev server**, started from the installation on `main`, that any
  session can point at; `--here` gives the calling worktree its own for a
  change that is not on `main` yet. Ten lanes with ten wranglers is a machine
  nobody can work on.
- **The whole set of URL-driven suites**, not a hand-picked smoke — when you
  reach for this you want the coverage.
- **Production may be written to**, in the managed test account, which is
  built to be thrown away and rebuilt daily.
- **Nothing runs by itself.** Not the runner, not the gate, not the nightly, not
  session launch. It costs minutes and a browser and it is for planning,
  debugging and verifying, when somebody asks.

One thing he asked for that does not exist: reading the production test-account
token from Cloudflare when the verb runs. Workers secrets are write-only by
design — neither `wrangler secret list` nor the API returns a value — and
`mc vault get` refuses plaintext export on purpose. He then ruled that mc may
hold it itself, and it does, in the platform keychain, read at the moment the
verb runs and passed to nothing but the suite.

**Carried by [`mc-dev-protocol/PLAN.json`](mc-dev-protocol/PLAN.json)**, whose
scope this ruling widened from *decide whether `mc dev` exists* to the two
verbs above.

## 11 · The brief writes the plans it decides, and there is no general rulings file

`ruling · 2026-09-06` · raised at the brief, over the page remake below

The brief had written a proposal, taken Martin's GO, recorded the decision, and
then stopped — because `canon/roles/brief.md` said a proposal *"goes when the
project is created, deleted by the session that writes the `PLAN.json`"*, which
sent the work to an `mc plan` session that would have to read the same code
again. It had also carried the decision into `~/mc/rulings.md`, a general file
the same role text told it to keep.

> **Beslut:** "Brief får skriva projekt-planer precis som plan. Det finns ingen
> anledning att dra detta i en session till." … "Hela filen rulings.md som skulle
> vara generell ska raderas. Rulings ska finnas per program. Generella regler ska
> leda till uppdaterade promptar eller AGENTS.md eller nya tester/funktioner."
> (Martin, 2026-09-06)

Both halves are rules and not rulings, so neither is carried by a plan: they
land as changes to the thing that enforces them, in the same pull request as
this entry. `canon/roles/brief.md` now says the brief writes the `PLAN.json`
itself and deletes the proposal in the same commit, under the same rules as a
planning session, and `docs/project/README.md` § *Who writes what* says so from
the other side — what stays the planning session's is thinking a programme
through and reading a `plan-review`. The same role text now says a ruling
belongs to its programme's `rulings.md`, that there is no general one, and that
a decision belonging to no programme is a rule: it lands in `canon/roles/`,
`AGENTS.md`, a test or a feature, and if that is more than an edit it is a
project with a plan like any other.

`~/mc/rulings.md` was deleted with this. Its three entries each named the pull
request that had already carried them into a plan — memoro #11371, #11505 and
#11506 — and its fourth is ruling 12 below.

## 12 · The page is remade, and the live frame is fixed first

`ruling · 2026-09-06` · raised at the brief

Martin's screen showed `sql-w3-email-closure` running in RUNNER and only four of
`sql-readiness`' eleven projects under PROGRAMMES. The numbers proved the render
was whole — a number is a position in the numbered list, so dropped rows would
have renumbered without gaps — and the fault was in the live loop.
`page-live.js`'s `above = current.length + tailRows` counts rows that
`reprint()` never printed on a page taller than the screen, so after one growth
frame every write lands a row high, `CSI 2K` clears the neighbour, and the row
that changed keeps its old text. Driven against the real 97-line page at
45 × 120: three changed rows, three projects erased, two drawn twice.

Reading the rest of the page against that found more. QUEUE reads only
`~/mc/queue.md`, so it says *"empty"* while the runner walks 41 projects.
`dim grey` — the dim attribute over bright black — draws the repository column
of every row and `no plan session` on eleven headings, at or below the
background. Thirty-two projects are `blocked` and nothing says `plan-review`
holds twelve of them and `home-on-msr` seven, though every step carries
`blocked_by`. A step row's `pid` is the runner's own. `production.differs`
compares a 7-character sha with a 40-character one, so identical commits read as
a mismatch.

> **Beslut:** "Vi gör en rejäl remake av hela sidan som redan har stora
> brister." … "Ja, kör." (Martin, 2026-09-06)

Five steps in that order — the frame fix first, then the palette, NEXT in place
of QUEUE, PROGRAMMES with per-programme counts and the blocked collapsed, then
the lanes, production, WORK, INTAKE and the section order. Explicitly out: no
new colour space, the page stays offline and instant, the menu gains one key,
the helper's digest keeps its own sha fix with the
`deploy-mismatch-shows-identical-shas` proposal, and every project stays listed
— the page does not become one that fits a terminal.

**Carried by [`the-page-remade/PLAN.json`](the-page-remade/PLAN.json).**

## 13 · The plan role gets a body, and what a session was told becomes checkable

`ruling · 2026-09-06` · raised at the brief, out of rewriting `canon/roles/brief.md` for ruling 11

Two holes found while writing ruling 11's change. `canon/roles/plan.md` is six
lines and every one of them is frontmatter, so an `mc plan <programme>` session
is told its model and nothing else beyond `_common.md` — while brief is 111
lines, step 55, intake 42, repair 38. #580 was called *"Every role says a turn
is the cost; the plan role gets a body"* and only the first half landed. It
matters more after ruling 11, because two roles write plans now and only one of
them is told how.

And this brief's own running role text contains two sentences — *"A
recommendation you cannot…"* and *"mc counts them and does…"* — that
`canon/roles/brief.md` has not held since #614 landed on 2026-09-05T12:18+02:00,
a day before the session started; `git log -S` finds both removed by that commit
and by no other. `mc brief` reads `readCanonRole('brief')` and passes
`role.overlay` through `instructionsFor` to `--append-system-prompt`, and
nothing records what came out. So a session cannot answer *which revision of my
role am I running*, and neither can anyone looking at it. The proposal this came
from said something was rewriting the role text; that was a guess and it is
wrong — the text is a real earlier revision of the file, and what the estate
actually lacks is any record of which one a session was handed.

> **Beslut:** "Gör det." (Martin, 2026-09-06)

Two steps: `plan.md` gets a body written out of what is already settled, with
the passage it now shares with `brief.md` written once and a test refusing any
canon role that ships with no overlay; then every launched session records its
role name and a digest of the instructions `instructionsFor` returned, and one
verb prints what a launch would produce today and names any live session whose
text is not that. Explicitly out: the other six role files, `_common.md` itself,
and chasing the one stale launch — the launcher has exited and the answer is not
recoverable, which is precisely why the record is the fix.

**Carried by [`the-role-a-session-runs-on/PLAN.json`](the-role-a-session-runs-on/PLAN.json).**

## 14 · The lane pair is `per_repo 2, total 3`

`ruling · 2026-09-05` · answers `lanes-pair`, raised by `total-lane-cap`
step 4 (#639)

Step 4 reserved this for Martin — *"set the real pair with Martin — do not
simply raise `per_repo` back to 3 on your own judgement"* — and the brief put it
to him the same evening with one recommendation: `per_repo 2, total 3`, not the
`3/3` that criterion 1 names. The reason is the imbalance in the queue: memoro
had twelve projects with a `ready` first step to memoro-cli's two to four, and
under `3/3` memoro can hold all three lanes most rounds. A repository can never
hold more than `per_repo` slots, so under `2/3` memoro-cli always has at least
`3 − 2 = 1` it cannot be shut out of. The total still binds — `2 + 2 = 4` is
more than 3 — so criterion 1 is measurable at `2/3` and needs no separate
`3/3` round. The cost weighed: at most three sessions at once instead of two,
roughly half again the concurrent spend of a day that cost ≈$525 at two.

> **Beslut:** "Beslut #3: Enligt din rekommendation." (Martin, 2026-09-05,
> at the brief)

He ran it himself in the same message: `mc run lanes 2 --total 3` wrote
`~/.memoro/mc/lanes.json` at 2026-09-05T20:41:42Z and `mc run --update` asked
the running runner to take the pair after its round. The runner that started
2026-09-06T12:03Z runs on it, and `mc run lanes` reads *"lanes 2 per
repository, 3 in total"*.

The answer was given and applied but never written into the plan, so the
runner kept reporting step 4 as blocked on a decision that had been taken for a
day. This entry is that record, a day late.

**Carried by [`total-lane-cap/PLAN.json`](total-lane-cap/PLAN.json)** step 4,
which now only has to watch a busy hour against the RUNNER block, flip
criterion 1 from that measurement, and add the `project_log.md` row.

## 15 · A refused merge is queued, and a merge lane lands it

`ruling · 2026-09-06` · raised by Martin at the plan session, out of the day's merges

Three pull requests merged by hand on 2026-09-06 — memoro-cli #667 and #671,
memoro #11513 — needed six retry loops between two sessions. `mc merge` is
refused the moment the gate or the lease is busy, and the runner's own
landings kept both busy: `mc merge memoro-cli 671` was refused fourteen times
in twenty minutes. The runner's own landing already waits for a busy gate and
already gives a red pull request one repair; a hand merge gets neither, so
every session builds its own watch.

Martin asked for a merge agent — anybody runs `mc merge`, it is queued, a
runner-like merger takes it, repairs if it must, and closes. The plan session
proposed queueing always; he narrowed it:

> **Beslut:** "mc merge ska naturligtvis först och främst köra samma process
> som nu. Endast om den inte går igenom så köas den. Det måste finnas en
> särskilt runner lane för merge issues så att det inte behöver vänta på att en
> vanlig lane blir ledig." (Martin, 2026-09-06)

So: the ordinary round first and unchanged; only a refusal queues; the runner
is the merger, through a lane of its own that is not a step lane and is not
counted by `per_repo` or `total`; `held.json` and its one-repair rule stay the
record of what would not land. Explicitly out: `--wait`, a second process, the
batch and `--docs` forms, and any change to what the gate measures.

**Carried by [`merge-queue/PLAN.json`](merge-queue/PLAN.json).**

## 16 · `mc deploy` runs from `main`, wherever `main` is — and keeps a `main` of its own

`ruling · 2026-09-06` · raised by Martin at the plan session, from a failed deploy that evening

At 20:04Z `mc deploy` failed at *Deploy source preflight*: "Production deploys
must run from main; current branch is language-content-open-decisions". The
verb had read `origin/main`'s sha, printed it, asked, and then spawned
`npm run deploy` in `~/memoro` — whatever branch that checkout was on. `main`
was checked out in `~/mc/plan/msr-core/memoro`. The script's own preflight
stopped it and production was untouched; the 09:18Z row that morning ("Working
tree is dirty before deploy") was the same cause.

> "Det är en brist; det ska vara inbyggt i mc deploy att alltid köra från main,
> oavsett var main är utcheckad." … "Ja, den måste köra från main, ff om det
> behövs, den ska bygga om css OM det behövs, allt smart och smidigt." … "Jag
> checkar ut main enbart för att göra deploys." (Martin, 2026-09-06)

So: the script runs in a worktree that is `main` — the one where `main` is
checked out when there is one, otherwise a worktree mc makes and keeps under
`~/.memoro/mc/deploy/memoro`, so that nobody checks `main` out by hand to
deploy again. It is fast-forwarded to `origin/main` under the lease before the
script runs; a dirty or diverged `main` is a refused row. `deploy.mjs` is not
touched — it already builds the CSS bundle on every run, from the tree it runs
in, which is what running it in `main` makes right. Explicitly out: any
argument to the verb, any change to `defaultRepos` or the lease key, and a
worktree under `~/mc/`, which would be a workarea to the runner.

**Carried by [`deploy-from-main/PLAN.json`](deploy-from-main/PLAN.json).**

## 18 · A step runs on sonnet at medium effort with an opus advisor, and nothing is killed on elapsed time

`ruling · 2026-09-11` · raised by Martin at the plan session, from the runner's cost

Measured 2026-09-05..12 (`scripts/measure-steps.py`): 155 step sessions, all
on `claude-opus-5` at the machine's `effortLevel: high`, median 93 turns and
112k tokens of context per turn, median 7.7 USD at list price and p90 30.5;
258 sessions since 2026-09-04 at about 2 500 USD list, and three sessions that
week ended on the weekly limit. The plan session proposed three levers — the
step prompt carrying its own step rather than the whole `PLAN.json` plus an
auto-compact window, a model and effort per step in the plan, and replacing
the wall-clock budget kill with a message asking the running session to judge
whether it can finish. Martin corrected the cost premise and set the default:

> "Alla modeller är inkluderade i Max 20x." … "Vi vill inte döda ett step som
> faktiskt gör ett arbete bara för att datorn laggar, tester tar lång tid,
> etc. Det enda som önskas är att en session avslutar sig själv om den kört
> fast. Kanske med injektion av ett message efter x minuter, som berättar att
> det tar tagit x min i tid och ber om en bedömning av om arbetet kommer kunna
> avslutas eller inte, eller bör planeras om." … "Låt oss testa sonnet 5
> medium som default med opus advisor." (Martin, 2026-09-11)

So: the unit is quota, not dollars. A step session's default is `sonnet` at
`medium` effort with `opus` as advisor; a plan may say otherwise in `runner`,
and a step in its own `runner`; a repair stays on `opus`. `budget_minutes` is
gone: every `check_in_minutes` the runner writes a check-in message into the
running session's stdin, and only a session silent on stdout for
`stall_minutes` is killed, logged `stalled`. The prompt carries the session's
own step and the plan's frozen fields, and the session runs under an
auto-compact window. Explicitly out: memoro's own `AGENTS.md` and suites, any
new prompt rule about turns or test counts, and the plan-trespass rate.

**Carried by [`step-cost/PLAN.json`](step-cost/PLAN.json).**

Addendum 2026-09-12, at the plan session: an advisor that is the session's own
model is no advisor.

> "Om step har opus => advisor = null, inte opus+opus." (Martin, 2026-09-12)

`sessionSettings` in `run-plan.js` returns `advisor: null` when the resolved
advisor equals the resolved model; a plan or step on `opus` that wants one
names a different model. Carried by memoro-cli #702.

Second addendum 2026-09-25, at the plan session: a step runs on opus 5.5, with
no advisor.

> "Dags att ändra mc runner till opus 5.5. (utan advisor med andra ord)."
> (Martin, 2026-09-25)

`SESSION_DEFAULTS.step` is `opus` · `medium` · no advisor; the `opus` alias
resolves to `claude-opus-5-5` on claude 2.1.280. The sonnet era's number to
compare against, 2026-09-15..25: 233 sessions, 78 % landed, 5.7 USD list per
landed step, median 105 turns, 74.8k context per turn
(`scripts/measure-steps.py`). A plan that names `model: sonnet` gets no
advisor unless it names one too.

## 19 · A step is work the runner takes from start to finish; investigation is the planning session's

`ruling · 2026-09-12` · raised by Martin at the plan session, from the cost of stuck sessions

Step sessions were being handed testing, design exploration and analysis, and
plans were written with a later step depending on what an earlier one would
find — step-cost's own step 3 was gated on a grep its instruction told the
session to run, and went `blocked` on the result. Since 2026-08-25, 15 step
sessions were killed on the budget with nothing landed and 22 ended
`plan-trespass`, each costing a repair session; and every stuck session costs a
person reading its transcript.

> "Step används till fel saker, t ex testning, designutforskning, analys. Det
> hör inte hemma där. Det ska köras i mc plan-sessionen. Det som läggs i ett
> projekts STEP ska vara en färdig körbar plan som runner kan ta från a till ö.
> Om inte, så hör det inte hemma där. Nu byggs det ihop konstigt som att steg 3
> är blocked av steg 2:s utfall etc." … "Det försvinner massor med tokens på att
> utreda sessioner som fastnat." (Martin, 2026-09-12)

So: a step is executable end to end by a headless session from the plan alone.
Investigation, measurement, exploration and "find out whether" belong to the
planning session, with Martin at the terminal, and are finished before the
plan is written. A step whose content depends on an earlier step's finding is
not written; the plan ends where knowledge ends, and the planning session
writes the next steps when the code is there to read. Carried into
`docs/project/README.md` § *The steps* (both repositories),
`canon/roles/_plan-writing.md` and `canon/roles/plan.md` by memoro-cli #702;
no runner change — the runner cannot tell an investigation from a step, so the
rule is the plan author's.

## 20 · Plans are read from `main` after a fetch, and the page shows the merges

`ruling · 2026-09-12` · raised by Martin at the plan session, from a stale page

`mc status <name>` preferred the workarea's `PLAN.json` over `origin/main`
(`src/mc/status-project.js`), and the page read `origin/main` from
`plans.json` without fetching unless `--fresh` was typed
(`src/mc/page-collect.js`). A workarea's copy is whatever branch the folder
stands on, and an un-fetched `origin/main` is whatever the runner last fetched,
so both surfaces showed plans the runner would not read. The gate round in
flight was on no surface at all: `~/.memoro/mc/gate-running.json` was written
by the round and read by nothing but the next round.

> "Låt oss uppdatera lite hur mc fungerar. Den ska göra git-anrop och läsa
> från main istället för lokala plan filer. Just nu ses inaktuell info.
> Dessutom: Låt oss visa 'merger'. Current + kö." (Martin, 2026-09-12)

So: every reading surface fetches and reads `origin/main`, and none reads a
workarea's plan; `--offline` is the only way to skip the fetch. GitHub is not
asked on every refresh — open pull requests stay in `prs.json` behind
`--fresh`. And the page gets a MERGES section between NEXT and RUNNER: the
round landing now (the lock, which now carries its phase), the queue the merge
lane will take, and the held pull requests, which move there from NEXT.

**Carried by [`main-and-merges/PLAN.json`](main-and-merges/PLAN.json).**

## 21 · A step lands its own pull request, and there is no repair

`ruling · 2026-09-12` · raised by Martin at the plan session, from the failure
analysis of 2026-09-05..12

The runner landed a step's pull request after the session had gone: the gate
went red, `held.json` got an entry, and the next round started a fresh `repair`
session on `opus` to read a branch it had never seen (22 repair rows, 156
minutes, median 33 turns; 21 of 51 non-landed sessions were a gate stop). The
step role said "Do not merge: the runner lands it after you." The planning
session proposed keeping the mechanism and moving the fix session into the
landing.

> "Vi kan inte ha både en repair runda och en merge runda." … "Jag beskriver
> samma beteende såsom det är tänkt I SAMMA SESSION. DET SKA INTE FINNAS
> 'FIX'-SESSIONER. = DUBBEL KOSTNAD NÄR EN NY SESSION SKA LÄSA IN SIG PÅ ALLT
> IGEN I GANSKA MÅNGA TURNS." … "Kanske vi ska göra så här istället runner step
> kör direkt 'mc merge #'. Då körs direkt rätt tester. Om fel, fås svaret
> tillbaka och kan fixas. Om grönt, så sker merge direkt och inga tester behöver
> köras ytterligare en gång." … "Done ska naturligtvis vara en del av pr. Annars
> måste ju en ny PR köras igen. Dubbel arbete. Om merge failar så sätts ändå inte
> done i main." … "Ja, och med väntan i mc merge. Som tar nästa uppdrag så fort
> det pågående är klart." (Martin, 2026-09-12)

So: the step session sets `done` and `pr` in the plan, in the pull request with
the code, and runs `mc merge <repo> <pr>` itself; a red comes back to the same
session; green is the merge, measured once. `mc merge` waits for its turn in
order of arrival and checks the plan boundary at the door. There is no repair
session, no `held.json` and no merge lane: an open pull request a session could
not land is a person's through the brief.

**Carried by [`step-lands-itself/PLAN.json`](step-lands-itself/PLAN.json).**

## 22 · The brief gathers no document, a planning room gets no discard verb, and a settled proposal is archived

`ruling · 2026-09-19` · raised at the plan session that turned the proposals left
open by the triage of 2026-09-18 into one project

Three questions the open proposals could not settle from the code. Whether
`mc brief --collect` and the gathered `~/mc/brief/<date>.md` go
(`brief-and-helper-surfaces`, 2026-08-31) — the options were keep both, since
#719 had just made a resumed brief receive the new document; drop the flag and
keep the document; or drop both:

> "Ta bort båda" (Martin, 2026-09-19)

What `mc plan discard <programme>` should do (`mc-plan-lifecycle`, 2026-09-02) —
remove worktrees, branch, room and conversations and refuse on unlanded work;
the same with a list verb; or no verb:

> "Stryk punkten" (Martin, 2026-09-19)

And what becomes of a proposal once it is settled, which had no convention
beyond deletion when a project consumes it:

> "Proposals bör arkiveras. Flytta till archive mapp." (Martin, 2026-09-19)

So: `mc brief` opens its session with the role and nothing gathered, and the
session reads the page, `mc status` and `mc step` itself. A planning room is
still removed by hand. A settled proposal — built, dropped, or consumed by a
plan — is moved to `~/mc/proposals/archive/`, which `listProposals` does not
read. The two proposals no reading could decide (`gate-round-died-recurred`,
`dev-server-exits-under-browser-round`) were archived undecided the same day.

**Carried by [`mc-open-proposals/PLAN.json`](mc-open-proposals/PLAN.json).**

## 23 · The nightly is not a process — it is the runner's chore, and it skips a tree nothing changed

`ruling · 2026-09-19` · raised at the planning session for `test-architecture`,
after the nightly was found dead for twelve days

Martin asked why the big nightly run was not happening. It had measured
`72dd376` on 2026-09-07 and nothing since: the ticks of 09-08 and 09-09 stopped
at fetch with `Could not resolve host: github.com`, and then the machine
rebooted on 09-10 at 06:52 and killed the detached process, which left its pid
file behind and nobody to start another. 300 pull requests landed in the gap.
That gap is not only a missing meter — `deferredRules` in memoro's
`config/testing-registry.mjs` takes eleven slow-by-construction tests out of
every per-change selection and leaves them to `full`, and the `msr-contract`
blanket was retired on the same trade, so for twelve days nothing ran either.

Three answers, and they are one decision. First, whether the tick should skip a
repository whose branch has not moved:

> "Ja till 'bara om nya merges'" (Martin, 2026-09-19)

Second, whether the brief should report that the nightly is not running — the
gap that let twelve days pass, since `nightlyState` is read only by
`mc test nightly status` while the brief and `mc deploy` read the last
*measurement* and never the meter's own life:

> "nightlys död ska INTE synas i briefen" (Martin, 2026-09-19)

Third, what the thing should be at all:

> "nightly ska inte vara en separat process. Den ska heller inte starta om
> automatiskt. Den ska vara kopplad till mc; om jag startar mc run så ska mc
> test kunna köras. Inte annars. Gör jag mc run stop ska det inte kunna köras
> några bakgrundstest heller." (Martin, 2026-09-19)

So the detached scheduler goes: the spawn, the pid file, the log rotation,
`mc test nightly start` and `mc test nightly stop`. The tick becomes a chore of
the runner beside `runHelperDay` and `runIntakeDrain`, and it inherits the
runner's own life — `~/mc/runner/STOP`, written by `mc run stop` and removed by
`mc run start`, already ends `chores()` at its first line, so *no background
test can run while the runner is stopped* falls out of the mechanism rather
than being a second thing to remember. `mc test nightly status` stays, because
the reading is still the question the meter exists for.

That order also answers the second question rather than leaving it a gap. A
brief line saying *the nightly is not running* reports a state that, after this,
cannot arrive by surprise: either the runner is running and the chore is due, or
Martin stopped it. This extends ruling 9's *nothing runs by itself* rather than
overturning it — the nightly now has nothing of its own to start.

**Carried by [`nightly-cadence/PLAN.json`](nightly-cadence/PLAN.json)** (the
skip) **and [`nightly-is-a-chore/PLAN.json`](nightly-is-a-chore/PLAN.json)** (the
process), in that queue order.

## 24 · mc is the administration program for memoro me, and memoro knows nothing of it

`ruling · 2026-10-03` · raised at the plan session for the mc–memoro
integration, before any teardown was planned

memoro carries two generations of mc living inside it: steering mc and Claude
Code sessions from memoro (cloud sessions, the supervisor, broker and PTY
attach, the Coding app, the `mc.cloud*` and `mc.supervisor` token scopes), and
reporting them back to it (heartbeats, uploaded transcripts as `coding_session`
items, projections). memoro-cli still ships the `memoro` binary that feeds the
second. Nothing in mc reads any of it. The session asked what mc is to be
measured against before deciding what goes.

> "Vi byggde en hel del för att kunna köra och styra mc-/Claude Code-sessioner
> inifrån memoro … Det är inte längre aktuellt. Nuvarande mc, som kör lokalt
> med runner, brief, plan och helper, är en bättre modell. Den delen ska tas
> bort, inte underhållas." (Martin, brief of 2026-10-03)
>
> "Det ska inte finnas någon annan användare av mc." … "mc ska fullt ut vara
> ett administrationsprogram för memoro me. Det är åt det hållet vi bygger det.
> Det som syns just nu är en kombination av olika rester efter andra
> produktidéer där kodning skulle vara en specifik del." … "Det man på sikt
> istället hade kunnat tänka sig är att låta memoro me vara tillgänglig som en
> mcp server så att en användare kan hantera sina data och chattar direkt från
> cli eller AI coding session." … "Ja mc blir admin-delen. Den UI bör nog
> försvinna från appen." (Martin, 2026-10-03)

So memoro me has two doors, and each has one owner:

- **The product door** is every user's, with their own data and their own
  identity: the web app, the native app, iOS Shortcuts, and — later, as a
  product feature — memoro me as an MCP server. Someone in a coding session who
  wants their notes uses this door, as a user, not mc. API tokens, device flow
  and the scope mechanism belong to this door and stay.
- **The admin door** is the owner's, and mc is it: building memoro me
  (`brief`, `plan`, `run`, `merge`), shipping it (`deploy`, `test`, `shot`),
  watching it (the helper digest over `/admin/*`), and administering it.

Where the admin tools are seen was answered in two turns. First:

> "Ja mc blir admin-delen. Den UI bör nog försvinna från appen." (Martin,
> 2026-10-03)

and then, asked whether the GitHub App core should be kept:

> "Det som hade varit värdefullt för mig är att inifrån appen kunna ha
> admin-verkyg (som kan laddas och är synliga för admin). Jag kan med dem.
> Skriv proposals. Jag kan läsa data och statistik över trafik och volym på
> appen. Detta kräver dock inte github integration utan endast att jag har min
> lokala mc igång. Eventuellt kan man tänka sig att jag har en hostad mc som
> hela tiden kan anropas så att proposals kan skrivas utan att jag har min
> lokala dator igång." (Martin, 2026-10-03)

So the admin tools may live inside the app, loaded and shown only to the
admin, as one face of the admin door: reading memoro's own traffic and volume
through its admin API, and writing proposals into mc. A proposal lands where
mc keeps them, `~/mc/proposals/`, so the tool reaches mc — the local one, or
later a hosted one — and memoro's server does not hold proposals for mc to
collect. None of this needs GitHub, so the GitHub App code goes whole, core
included.

**Amended 2026-10-05.** This ruling first let the in-app admin that exists
today stay, as it is. That is not where it is going:

> "mc byggs till att helt vara admin-programmet (kan vara flera program) för
> memoro me. Jag skulle kunna tänka mig att ha ett admin-verktyg inne i den
> vanliga chatten som kan användas för att skriva proposal. I övrigt tänker jag
> inte att det behövs något annat." (Martin, 2026-10-05)

and then, on how far that reaches now:

> "Det kräver dock med eftertanke kring vissa delar. Det du skrivit ihop
> hittills tar inte hänsyn till delar som att hantera assets eller network
> eller assistent. Det det här projektet ska göra är att flytta
> statistik-delarna till mc." (Martin, 2026-10-05)

So the direction is that `/admin` moves into mc. There it becomes terminal
commands, not a web page, and mc may be more than one program. The proposal
tool in the ordinary chat is the in-app admin this direction foresees. It is
shown only to the admin and writes a proposal into mc, by the route above. The
move goes part by part, and only the statistics are decided: what `/admin`
shows about traffic, volume, usage, cost and operations becomes mc commands,
read through the admin API. The parts that act on memoro rather than read it
stay in the app until each has been thought through on its own. That covers
asset handling, the network, the assistant, the writing admin commands and
the debugging tools. The admin API stays in any case, because it is how mc
reaches memoro. This answers memoro's `msr-core-admin-moves-to-mc` (2026-10-04,
F22 on the msr-core map) for the statistics only, and F22 stays open for the
rest.

Three rules follow. **The dependency runs one way**: mc reads memoro, and memoro
holds nothing about mc — no sessions, no runner state, no record of how memoro
is built. **mc reaches memoro only through the admin surface**, as the owner;
it has no endpoints of its own there, so `/api/mc/` has no future. **mc's own
state is mc's**, in `~/mc/` and its repositories.

Measured against that, steering from memoro breaks the first rule and
reporting into memoro breaks the first and the third, so both go. The
`coding_session` items already stored were offered frozen, read-only in the
library, or deleted:

> "Vi kan ta bort coding-sessions från mitt konto. Saknar riktigt värde."
> (Martin, 2026-10-03)

So the content type goes with them, and the items are deleted without an
export. The `memoro` binary goes too: a user's CLI and agent access is the MCP
door, not a binary with hooks. And the package leaves the registry:

> "Vi måste också ta bort (tror jag) memoro-cli från npm." (Martin, 2026-10-03)

Nothing installs it from there — mc is linked from a checkout, and memoro's
sandbox image cloned the repository by ref — so the unpublish is Martin's act
whenever he chooses, and the package is marked private so it cannot return by
accident.

The Coding Profile — a letter of working rules mc fetched from
`/api/mc/coding-profile` and joined in front of every role's instructions,
about a thousand tokens a launch — was first proposed to move into mc, then:

> "coding profile ska bort ur memoro me. Kosinstruktioner och min profil får
> hamna i mc och agents.md." … "Kanske ska all text i coding profile bara tas
> bort men ev viss test kan sparas i en profile.md. Hela texten måste ses över.
> Vi ska inte öka token-kostnad utan tydligt värde." (Martin, 2026-10-03)

Read paragraph by paragraph against `canon/roles/_common.md`, memoro's
`AGENTS.md` and the tool's own system prompt, every part was said elsewhere or
contradicted ruling 21 — except that what is written into a repository is in
English. So there is no `profile.md`: that rule is one sentence in
`_common.md`, the fetch goes from mc, and the endpoint and its tables go from
memoro (*"Bra. Enligt din rekommendation."*, Martin, 2026-10-03).

The MCP server, the chat tool that writes proposals, a
hosted mc and any GitHub integration are not part of the teardown; it must
only leave standing what they would stand on — API tokens, device flow, the
admin gate and the admin API. Moving the statistics of `/admin` into mc is its
own project, not yet planned (brief of 2026-10-05).

**Carried by [`memoro-client-cut/PLAN.json`](memoro-client-cut/PLAN.json)** here,
**and by memoro's `docs/project/mc/mc-in-memoro-cut/PLAN.json` and
`docs/project/mc/mc-in-memoro-decommission/PLAN.json`**, in that order: the
client first, then the code in memoro, then — each step on Martin's word —
what cannot be undone.

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
and the row is in [`project_log.md`](../project_log.md). Rulings 10 (*a round
reads the plan from `main` unless the plan itself is the conflict*) and 17 (*the
runner takes the next step, and a step it cannot start is `blocked` on `main`*)
went the same way with `runner-next-step`: the predicate ruling 10 scoped is
gone — a conflicted `PLAN.json` now takes main's copy, so the runner reads no
branch copy of a plan at all — and ruling 17 is the picker, the claim and
`blockStep` in `src/mc/run.js`; `mc-run.md` carries both, with Martin's words
for 17 quoted under *Blocked by the runner* and the measurements behind 10 in
its history section, and the row is in `project_log.md`.

## 25 · The runner lands a pull request a step session published and could not finish

`ruling · 2026-10-07` · raised at the brief, from proposal
`step-session-ends-while-mc-merge-is-backgrounded` (2026-10-06)

A step session that has published its pull request and started `mc merge`
can end before the gate answers — the harness backgrounds a foreground call
at 600 s and the session ends its turn — and the runner then records the
step `failed` with an open PR, by ruling 21's rule that it lands nothing of
a session's. The work was done and unmeasured.

> "F. Ja." (Martin, 2026-10-07, at the brief, to: the runner measures and
> lands a PR the session published but did not land; and `gh auth login
> --insecure-storage` on his machine.)

So: when a session ends `success` with its pull request open on the step's
branch, the runner runs the merge measurement itself; green lands and the
step is done, red is `failed` with the gate's reason. The runner still
retries nothing. Carried by `merge-robustness/PLAN.json` step 5. The
`--insecure-storage` login is Martin's own command; mc checks it in step 3
of the same plan.

## 26 · A deploy and the merge rounds run beside each other

`ruling · 2026-10-07` · raised at the brief, the evening the merge queue sat
behind the runner's gate rounds for hours and a deploy was refused at 17:58
because a round held the lease

`mc deploy` claims the repository lease for the whole deploy (errand
`deploy <sha>`), so a merge round meeting it waits and a deploy meeting a
round is refused. The lease's purpose for a deploy is one read: that `main`
in `~/memoro` does not move between the question and the sha that ships. The
build and `npm run deploy` run on that sha in the worktree, which nothing but
the deploy itself fast-forwards; a merge landing on `origin/main` after the
read changes nothing the build sees.

> "Går det att göra så att mc deploy kan köra samtidigt som vi gör merges?"
> (Martin, 2026-10-07, at the brief.)

So: the deploy holds the lease from its claim to the read of the shipping
sha and the record's first row, and releases it before the spawn; a second
deploy is refused by the record (a `running` row with a live pid), not by
the lease; and a deploy that meets a held lease waits for the window the way
`mc merge` waits for the gate, rather than refusing. Carried by
`deploy-beside-merges/PLAN.json`.

## 27 · `mc run --update` says what it is doing, and never leaves a dead runner behind

`ruling · 2026-10-07` · raised at the brief, after the evening's update: UPDATE
written 18:41 with six lanes busy, four announced the drain as they landed,
the rest said nothing, and at 18:56 the runner was force-stopped and started
by hand — then `--update` was written again on a runner already current, and
every lane drained once more.

> "mc run --update är som att den inte riktigt tar; jag får emellanåt göra
> manuellt stop start av run ett par gånger innan det fungerar. Låt oss gör
> den mer robust." (Martin, 2026-10-07, at the brief.)

The drain itself is what Martin chose on 2026-09-04 and stays. What was
missing is the answer: `--update` on a runner already on origin/main says so
and writes nothing; on a draining runner it prints what the runner waits on
and for how long, and the page and `mc run start` say the same; the drain
logs what it waits on every ten minutes; a handover that cannot respawn keeps
the runner running instead of exiting behind a live `runner.json`; and the
quota pause ends the moment a draining runner is quiet. Carried by
`update-handover/PLAN.json` steps 1–2. Whether the successor may start at
once and overlap the old runner on the lanes it does not hold was the open
decision `update-handover-overlap` (step 3) — answered in ruling 28.

## 28 · The successor starts at once; the old runner only finishes what it holds

`ruling · 2026-10-07` · decision `update-handover-overlap`, raised by
`update-handover/PLAN.json` step 3

On 2026-09-04 Martin chose the drain (A) over an immediate handover with two
runners (B), when B meant two runners taking work side by side. The overlap
proposed here is narrower: the successor starts on the new code the moment
UPDATE is read and takes every lane the old runner is not in a step on; the
old runner takes nothing new, is only the parent of the sessions it already
holds, lands them and exits.

> "Ja på frågan!" (Martin, 2026-10-07, at the brief, to: får efterträdaren
> starta direkt och överlappa den gamla runnern på de lanes den inte håller?)

So: the handover is immediate; the old runner's in-flight steps stay its own
to land; the two never hold one project or one lane; the page shows both
while they overlap. Carried by `update-handover/PLAN.json` step 3.

## 29 · `mc deps`: one reading of what is behind, and bumps only through the gate

`ruling · 2026-10-09` · raised at the brief, after a deploy whose log said
wrangler was 33 minor versions behind with a security fix, and `npm audit` on
memoro's `origin/main` read 2 critical and 24 high

The sketch put to Martin: `mc deps [<repo>]`, npm's outdated and audit
readings merged into three groups — security fixable within the major,
patch/minor, major — each row marked runtime or tool, and the repository's
own wrangler tally as its own line; `mc deps bump <repo> <group|package>` in
its own workarea, landing through the ordinary merge gate; and one deps line
in `mc deploy`'s reading.

> "Ja, bra, lägg upp mc deps som ett eget projekt" (Martin, 2026-10-09, at
> the brief.)

So: the reading is of `origin/main`'s manifest and lockfile, never a
checkout; runtime or tool is the `package.json` section and nothing else; a
bump writes only with `--package-lock-only`, never crosses a major unless a
version is named, and lands only through `mc merge`; the deploy line reads the
saved reading and makes no call. Carried by `mc-deps/PLAN.json` steps 1–3.

## 30 · `mc merge` queues; one merger lands, one at a time; a red goes to the step's next session

`ruling · 2026-10-09` · raised by Martin at the plan session

Every `mc merge` waited for the gate in its own process — an entry in
`merges.json` with its pid, a poll every 15 s, exit 3 and "run this again"
after 8 minutes — and the runner's landing of a session's pull request
(ruling 25) waited the same way. Six lanes could be six processes standing in
line for one lock, and a step session spent turns re-running the call.

> "Jag tror vi ska göra om mc merge. Jag ser framför mig att merge är en
> separat pid. När man lägger något i kön, dvs. mc merge repo pr så bara
> hamnar det i en kö. Samma pid kör sedan en i taget av de pr som den fått
> till sig. Just nu blir flera processer hängande eller väntande på detta."
> … "Och likaså bör deploy också ha en egen pid som kan köras oberoende av
> merges." … "Vi skulle kunna låta deploy vara utan kö." … "B." (Martin,
> 2026-10-09, choosing B: the session queues and ends; a red is in the
> register and the step's next session takes it — over A, the session
> following its own job.)

So: `mc merge <repo> <pr>` checks the plan boundary, makes the step
`landing`, queues the job and returns. One process, the merger, lands the
queue oldest first, one at a time, and writes the register: green `done`;
red the step `ready` again with the gate's reason and its pull request kept,
so the next session goes on with the same branch and pull request, and
`failed` at the third attempt. A queue with no live merger gets one from the
next `mc merge` or the runner's next read. This amends ruling 21 in one
point: the red no longer comes back to the session that wrote the code, but
to the step's next session, told what the gate said. `mc deploy` gets its own
process too, beside the merger and with no queue: a deploy asked for while
one runs is refused, as now.

> "Fortsätta på en öppen pr som håller på att mergas? … Men det viktigaste är
> att vi sparar mycket tid om nästa step kan påbörjas direkt utan att vänta på
> merge." … "1. Vänta. 2. A." (Martin, 2026-10-09: hold the PR; A — the branch
> goes on, the next step starts on top of the queued one.)

And: **the next step does not wait for the merger.** A step `landing` is
behind the plan, not in front of it: the runner hands out the next step at
once, on a new branch on top of the landing one's, and the register says what
it is built on (`stacked_on`). The merger lands them in order — a job built on
another waits until that one is `done` — and moves the upper branch onto main
past the sha it started on before its round, since the one below was
squash-merged. When the one below comes back red, it is the next session's
first: the project's next session fixes it on its own branch, and the job on
top keeps its place and goes once that one has landed. A move onto main that
conflicts is a red like any other.

## 31 · `mc language`: language data reaches production through one door

`ruling · 2026-10-10` · raised by the brief, from the proposal of 2026-10-09

The Swedish SALDO cutover on 2026-10-09 took seven acts, three terminals, a
Cloudflare key pasted into a chat, and two failed deploys — the grammar
promotion in `scripts/deploy.mjs` writes to production for ten minutes after
the Worker is live, and failed there twice with "production is fine" and exit
1. The proposal: a verb `mc language` that reads a cutover manifest memoro
owns, runs every act's read, compares it with the manifest's numbers, asks
before each write, gives the key from the keychain to the child process alone,
records every act and resumes. Three questions were put with a
recommendation each — the name (`mc language`, not `mc content`); whether the
grammar step leaves the deploy entirely or only gets a clearer error (leaves
it; unresolved selectors still stop the deploy); and the cause of the 7403.

> "Håller med om svaren." … "3. Jag vet inte orsaken till nyckelfelet, har
> fungerat utmärkt när jag kört och den är roterad." (Martin, 2026-10-10)

> On whether the GitHub deploy workflow, which also runs the promotion, follows
> the same rule: "Samma regel" (Martin, 2026-10-10).

> "Du skriver två stycken projekt, båda under programmet "mc"." (Martin,
> 2026-10-10)

So: the name is `mc language`; grammar promotion leaves `scripts/deploy.mjs`
and `.github/workflows/deploy.yml` alike — both read, stop on unresolved
selectors before the Worker ships, and name `mc language promote` when rows
wait; the 7403 is not pursued, and the verb's key handling (keychain, shell
variables ignored, key only in the child) removes the suspected cause anyway.
Two projects under `mc`: memoro's `language-manifest` (the manifests, `--json`
and `--help` on the scripts, one credential helper, the generated runbook, the
deploy's check) and memoro-cli's `mc-language` (the verb), which waits for it.

Two points of the proposal changed against the code. The repository lease does
not keep a deploy and a language run apart, since a deploy holds none
(ruling 30); each refuses while the other has a live record instead. And the
Swedish cutover is finished: its manifest is the record of the 2026-10-09 run
and the template for the next language, and a run of it today stops at the
first exact check. The Swedish lemma bands are in production since 2026-10-09
(memoro `docs/project/language-content/language-content-state.md`).

## 32 · A deploy waits for the round in flight, then builds alone; the queue goes on after it

`ruling · 2026-10-10` · raised by Martin at the brief

Ruling 30 put `mc deploy` beside the merger with no coordination. On
2026-10-10 the deploy of 0de5a99 built its bundle beside a merge round's
`npm ci` and suite on an 8 GB machine: the bundle took 26 minutes instead of
under one, the round's prepare 332 s instead of 30–60, and the machine
swapped until the deploy was stopped.

> "Ja, låt deploy vänta på rätt tillfälle, den kilar in sig efter pågående
> merge-process, kör själv, därefter fortsätter merge-kön." (Martin,
> 2026-10-10)

So: the deployer waits for the gate round in flight (`waitForGate`,
memoro-cli `src/mc/commands/deploy.js`), and the merger starts no round while
a deploy's row says `running` (`landJob`, `src/mc/merger.js`). This amends
ruling 30 in that one point; a second deploy is still refused, and there is
still no deploy queue.

And: a session calls `mc merge` once and does not poll it
(`canon/roles/_session-work.md`) — a session started before ruling 30 called
it every 60 s until the pull request merged.

## 33 · An interrupted step is the runner's to recover, warm or cold

`ruling · 2026-10-10` · raised by Martin at the brief

The machine restarted on 2026-10-08 and twice on 2026-10-10. Each time every
step session died, `sweepRunning` wrote them `failed`, and a step whose
session had left uncommitted files was blocked as `dirty-worktree` once it was
set `ready` again. On 2026-10-10 that was six failed steps and five blocked
ones, set going again by hand. The runner had no session id to resume with,
because the stream was written to disk only when a session ended.

> "Nu har det hänt igen att datorn startat om. […] Jag ska inte manuellt
> behöva göra detta... låt oss fundera på olika robusthetslösningar (som
> också tar hänsyn till varm/kall cache)." (Martin, 2026-10-10)

The brief proposed six parts: interrupted is not failed; warm cache or a small
conversation resumes the same session, a cold large one gets a fresh session
with a handover; a step's own leftover files never block it; snapshots of
uncommitted work while a session runs; the runner starts itself at login when
it was running when the machine went down; and no step starts while memory is
short.

> "Bra förslag. Vi tar alla 1-6." (Martin, 2026-10-10)

The direction behind the first three was approved on 2026-10-08, with one
condition kept here: a resume goes through each tool's own resume, so claude
and codex stay interchangeable. Carried by `step-recovery`
(`docs/project/mc/step-recovery/PLAN.json`). An interrupted step is a `ready`
step with an `interrupted` record rather than a new state, so no reader of
`ready` has to change.

## 34 · The merger lands batches, and memoro-cli has a gate lane of its own

`ruling · 2026-10-10` · raised by Martin at the brief

The merge queue stood at ten or more all afternoon. Measured from
`merger.log` over 2026-10-09/10: 96 landed rounds, 178 s median and 281 s
mean, so about 13 pull requests an hour at most, and the merger was busy for
all of 12:00-15:00 UTC. The suite was 57 % of a round. Command gates added
65 s mean where they ran (`sql:pr-ci` 36 s median), and `npm ci` 26 s mean.
memoro-cli's rounds of about a minute each waited behind memoro's of three to
fifteen. `runMergeRound` could already measure a batch as one candidate (A3),
but the merger never handed it more than one pull request.

> "Fundera: just nu är merge-processen en rejäl flaskhals. Det är +10 i kö
> hela tiden. Kan vi minska tiden per merge?" … "Låt oss göra 1-4. GO."
> (Martin, 2026-10-10)

The four chosen: the merger lands up to four queued pull requests to one
repository in one round; memoro-cli gets a gate lane of its own beside
memoro's; command gates run beside the suite instead of after it; and `npm ci`
is replaced by a clone of a cached tree when the lockfile has not moved. The
fifth proposal, starting fewer steps while the queue is long, was not chosen.

This amends the ruling of 2026-08-30 (*"En instans kan köra åt gången"*,
`src/mc/gate-lock.js`) in one point: one round at a time **per lane**. memoro
and any repository that declares nothing share the heavy lane, and memoro-cli
is light. Two memoro rounds still never run at once, and a deploy still waits
for every round in flight (ruling 32). Carried by `merge-throughput`
(`docs/project/mc/merge-throughput/PLAN.json`).

## 35 · A blocked step that waits for a time, a deploy or another project is released by the runner

`ruling · 2026-10-10` · raised by Martin in the mc planning session

A blocked step went back to `ready` only when a person set it there (ruling
21). `blocked_by` could name a decision, a project or a workarea fault, but
not a time, and nothing read `deploys.tsv`. `staleBlockers` noticed a done
project blocker and, by design, wrote nothing.

> "Har vi följande funktionalitet för blockerade steps: (1) timer så att step
> ändras till ready vid viss tidpunkt eller delay, t ex 24h efter deploy av
> steget innan, och (2) relativt beroende, dvs när step x är klart blir step y
> ready, eller när projekt y är ready blir step 1 i project z ready."
> (Martin, 2026-10-10)

The proposal (`~/mc/proposals/archive/2026-10-10-step-blockers-that-clear-themselves.md`)
offered `time`, `deploy`, a releasing `project`, and a `step` kind for one step
of another project.

> "Vi tar bort detta: step … Det får räcka med att vänta på att hela det andra
> projektet ska bli klart." … "Bra. Skriv planer och landa." (Martin, 2026-10-10)

So there are two new kinds. `time` is due at an instant. `deploy` is due when
an earlier step of the same plan has landed and a deploy containing it ended a
given number of hours ago, and it exists for memoro only. `project` is now due
by itself when the named project's plan is `done`. "Not on main" stays a
person's call. A step waits on a whole project, never on one step of another.
Step y after step x in one plan needs nothing new, because steps are an order.
The release is the runner's register write with a comment, and never a plan
edit. `decision` and `workarea` stay a person's. This amends ruling 21 in that
one point. Carried by `step-release` (`docs/project/mc/step-release/PLAN.json`).

## 36 · `mc merge watch`: a session that wants to can follow its merge to the end

`ruling · 2026-10-10` · raised by Martin in the mc planning session

> "Skapa ytterligare en plan: mc merge watch pr. Det ska bli en bevakning som
> en session kan starta OM den vill bevaka mergen av en pr." … "Bra. Skriv
> planer och landa." (Martin, 2026-10-10)

`mc merge` keeps queueing and returning (ruling 30), and a step session does
not wait. `mc merge watch <repo> <pr>`, and `mc merge <repo> <pr> --watch`
for one command, follow the job through `merges.json` and exit with the
answer: 0 merged, 1 red, 2 not in the queue and not open, 3 timeout, 4 no
merger. The watch is read-only. It prints a line only when the state changes,
and it asks GitHub once, when the job has left the queue. Nothing starts it
except a session that chooses to. Carried by `merge-watch`
(`docs/project/mc/merge-watch/PLAN.json`).

## 37 · A dead Memoro token signs in again, and the vault key cache is encoded

`ruling · 2026-10-11` · raised by Martin at the brief

> "Ja, landa hos runner." (Martin, 2026-10-11, approving the brief's
> recommendations A1–A4)

The vault key cache stores its JSON value base64-encoded (`b64:` prefix) and
still reads plain-JSON entries; `macSet`'s refusal of `"`, `\` and line breaks
stays. A Memoro 401 that is the server's generic token rejection — not a vault
password 401 — clears the token and runs the device flow when `mc vault` runs
at a terminal, and fails loud naming `mc vault status` anywhere else; a
headless session never signs in by itself. No new verb. Carried by
`vault-repair` (`docs/project/mc/vault-repair/PLAN.json`).

## 38 · Runner step sessions can run on the Max plan's API credit

`ruling · 2026-10-11` · raised by Martin at the brief

> "Låt oss fokusera just nu på mc step. Jag tänker så här: vi skulle kunna ha
> en check där weekly budget <20% så aktiveras krediter eller med en manuell
> toggle." … "Ja, landa hos runner." … "Godtas." (Martin, 2026-10-11,
> approving the brief's recommendations B5–B14 and the two points the plan
> raised)

A runner-wide billing mode `plan | credits | auto` in `~/mc/runner/billing.json`,
set with `mc run --billing`, read at each new session; default `plan`. `auto`
moves new claude step sessions to the API credit at ≥ 80 % seven-day
utilization, and hands a step over on any plan refusal (5-hour or 7-day)
instead of sleeping. Same tool, model, effort and advisor on either billing;
billing changes only at a session boundary, and a resume across billings is
cold. An exhausted or rejected credit marks credits unusable for 24 h, not
until the next grant, which mc cannot see.

This overrides, for one label only, two stances: that mc never turns a vault
secret into an environment variable (`src/adapters/claude-code.js`), and that
the vault never hands a plaintext secret back to its caller (`mc vault get`
disabled; `c1-claude-lease`). The vault label `mc-api-key` is read by the
runner and given to the step session as `ANTHROPIC_API_KEY` when its billing is
credits, and to nothing else. The key is then visible to the commands that
session runs; Martin accepted that, with the spend cap Martin sets on the
Console workspace `mc` as the bound. Carried by `step-credits`
(`docs/project/mc/step-credits/PLAN.json`).

## 39 · What mc keeps: one root per kind of area, a closeout in git, retention per root

`ruling · 2026-10-11` · raised by Martin in the mc planning session

> "vi måste hitta ett system där mc på ett smartare sätt rensar ut data som
> inte längre behövs" … "Bokslutet i git." … "Programmens konversationer:
> alltid behålla den aktuella; gamla kan städas efter 72h." … "En plan kan
> gott behålla sina workarea; de ska egentligen bara ha max två: en memoro
> och en memoro-cli. En fast kostnad som inte växer." … "En plan-session kan
> använda sig av underagenter ibland som var och en arbetar i sin egen
> workarea. Vi kan inte ha så stränga regler." … "låt oss gruppera alla
> workareas på ett smart sätt: plan/ har sin egen, låt oss skapa en work/ och
> varför inte ett runner/ eller step/." … "jag godkänner detta. GO."
> (Martin, 2026-10-11)

A programme (staff, msr-core, mc …) is long-lived; a project is a plan run
through quickly, though a step may wait about a week on a timed blocker. The
two are kept differently.

Each kind of area has its own root, and the path says what it is:
`~/mc/plan/<programme>/`, `~/mc/step/<project>/` (the runner's),
`~/mc/work/<name>/` (`mc work`). Existing areas are not moved; those directly
under `~/mc/` drain in place.

A project's data lives until its closeout. The archive PR that removes the
plan also adds `docs/project/<programme>/closeout/<project>.json`: goal, steps
with PR, sha and date, and per-session time, tokens and cost. Once that is on
main and the area is closed, the register file, session logs, closed
leftovers, scratch and transcripts are removed.

A programme's planning area keeps its `memoro` and `memoro-cli` checkouts for
good. Extra worktrees there are allowed (a subagent's) and go once finished.
A programme keeps its current conversation, and the others go after 72 h. A
`mc work` area stays until it is released or discarded.

Every removal is list-first: the targets are written to a file, each is
re-checked when it is removed, and a check that errors means keep (the
2026-09-26 incident). `mc tidy` does it, and the runner runs it daily and when
lanes skip for disk. Carried by `retention`
(`docs/project/mc/retention/PLAN.json`).

## 40 · What a session is handed at launch: its role, and no instruction files

`ruling · 2026-10-12` · raised by Martin in the mc planning session

> "Jag tror att cache ttl kan vara 5 min i step-sessionerna … men plan- och
> work-sessioner får 1h. Det ska inte vara beroende av credit eller plan." …
> "MEMORY.md är en soptipp som förmodligen inte ska läsas in i en enda
> session. Kan eventuellt fungera som referens-bibliotek. Claude.md likaså:
> står hur mycket som helst där som är irrelevant för vissa sessioner." …
> "Ja. Ingen mätning - det blir ett senare bekymmer för mig." (Martin,
> 2026-10-12, on the recommendation that followed)

Every session mc launches, of either tool, new or resumed, is handed its role
text and nothing the tool would load on its own: no `CLAUDE.md`, no
`AGENTS.md`, no auto-memory index. Claude gets
`CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY` and its
cache TTL through `--settings`; codex gets `project_doc_max_bytes=0`. The
repositories' instruction files and the old memory notes stay on disk as a
library `_common.md` points at, searched when the work touches them.

Measured 2026-10-12 against the API on claude 2.1.296: a memoro step's fixed
context is 20.3k tokens per request with the files loaded and 9.5k without;
0 of 113 step transcripts wrote a memory and 7 read `AGENTS.md`. The role
text already rides in the system block claude caches with a breakpoint, so it
is shared by every session of one role.

The prompt-cache TTL is a property of the role, in its frontmatter
(`cache: 5m`), never of the billing: `step` and `mend` 5 minutes, every other
role one hour. Without it claude picks one hour on the plan and five minutes
on a key. Carried by `launch-context`
(`docs/project/mc/launch-context/PLAN.json`).

## 41 · Parallel calls are counted per response, and the role asks for them up front

`ruling · 2026-10-12` · raised by Martin in the mc planning session

> "1. Ja, lägg till måtten. 2. Skärp raden." (Martin, 2026-10-12, on the
> recommendation to measure parallel tool calls correctly and sharpen the
> role line before anything else)

A parallel call is several `tool_use` blocks in one model response; it saves
one request, i.e. one cache read of the whole context. Claude Code writes each
block of a response as its own transcript line, so a count per line always
gives 0 — which is what `measure-steps.py` did, and what the 2026-09-12
conclusion that sessions never batch rested on. Counted per `message.id` over
the opus-5.5 window (2026-09-26..10-12, 192 sessions, 11 177 requests,
≈906 USD list), 13.3 % of tool responses carry two or more calls. Single-call
reads that name nothing from the read before them: 2 328 requests, ≈85 USD,
9.4 % — the ceiling for this lever. No batch tool: the client already runs
parallel calls. Carried by `parallel-reads`
(`docs/project/mc/parallel-reads/PLAN.json`).

## 42 · A step names its model, and the plan prefers narrow Haiku steps

`ruling · 2026-10-13` · raised by Martin in the brief session, after the
week-focus-rows trial

> "Kostnadsbesparingen är så pass stor att vi behöver gå vidare med detta. […]
> Vi behöver uppdatera sessionResult och instruktionen till plan-sessionen. Vi
> bör också sluta nämna möjligheten att använda advisor och subagents. […]
> Haiku respektive Opus steg med att föredragande till tydliga avgränsade
> Haiku steg." (Martin, 2026-10-13) — and on the five recommendations below:
> "Ok. Kör enligt dina rekommendationer."

The trial: week-focus-rows steps 8–10 (`runner.model: haiku`, effort `high`,
no workers) cost 0.29, 0.33 and 0.26 USD and landed green — one merge conflict
in step 10, mended on Opus in 86 s. Opus steps 4–7 of the same project cost
5.1–7.1 USD each with Haiku workers.

1. `sessionResult` takes `total_cost_usd`, `duration_api_ms` and `modelUsage`
   from the last `result` line, which claude now prints as running totals
   (all 45 multi-result streams in `~/mc/runner/log/` on 2026-10-13); it still
   adds `num_turns`, `duration_ms` and `usage`, which are per turn group.
   Forward only: old logs are not rewritten.
2. The step default stays `opus`. Every step a plan writes names
   `runner.model`: `haiku` is the first choice; `opus` only for a step that
   needs design or judgement, after the plan writer has tried to split it.
3. A Haiku step runs at `effort: high`.
4. Plan instructions and `docs/project/README.md` stop mentioning `advisor`
   and `subagents`. The schema and the code keep accepting both, so the plans
   on `main` that use `subagents: on` still run; the code goes in a later
   clean-up once no plan uses them.
5. Steps already planned elsewhere are not re-planned.

Mend stays on Opus (Martin, 2026-10-13, at the trial). Carried by
`haiku-steps` (`docs/project/mc/haiku-steps/PLAN.json`).

## 43 · Every push of a step goes through `mc publish`, and the PR says what came after its description

`ruling · 2026-10-16` · raised by Martin in the brief session

> "Vi behöver utveckla mc publish. […] mc publish doesn't update the
> description of a PR that already exists. […] Tänk igenom ytterligare luckor
> i mc gate, publish, merge." (Martin, 2026-10-16) — and on the
> recommendations: "Ja bra, skriv ihop till en plan".

Measured over the 125 step transcripts since 2026-09-26: 21 sessions pushed
with a plain `git push` and 20 of them went straight to `mc merge`; 7 ran
`gh pr edit --body-file` by hand; 8 PRs landed with a description of their
first head only — which is what the merger books (`remainderOf`) and what
the squash carries. mc sends sessions past `mc publish` itself: the retry
preamble (`run-plan.js`) says "push to the same branch", the mend prompt
says `git push origin HEAD:<branch>` — which the pre-tool hook has refused
since #912 — and `--body-file` alone overwrites the title with the last
commit's subject (a fix's), `--title` alone the body.

1. `mc publish` edits only what it is given: `--title`, `--body`/`--body-file`
   and the new `--base` each on its own.
2. The description carries the head it describes, as a last line
   `<!-- mc:described <sha> -->`. `mc publish` without a body, on an open PR
   with commits after that head, writes them under a generated
   `## After the description` section (subject and body of each, oldest
   first, merges left out), regenerated on every publish. The text above it
   is never touched; `--body`/`--body-file` replaces the whole and moves the
   mark to the head being published. A description with no mark is taken to
   describe the branch's oldest commit.
3. `mc publish --branch <name>` publishes a detached HEAD to that branch with
   the same refusals (the mend's worktree is `origin/<branch>`, detached).
4. The retry preamble and the mend prompt say `mc publish`, never `git push`;
   the pre-tool hook sends `gh pr edit` to `mc publish` as it sends
   `gh pr create`.
5. `mc merge` refuses at the door, before queueing: a PR whose branch is
   checked out in the caller's worktree at a head origin does not hold
   ("`mc publish` first"), and a PR GitHub reports `CONFLICTING` (merge
   `origin/main` in the worktree, which still has the context).
6. The merger lands only the head it measured or freshened:
   `gh pr merge --squash --match-head-commit <sha>`, after GitHub reports
   that head.

`mc gate` and the test rounds are not in this ruling: Martin asked the same
day for a review of how much is tested and how often the same failure is
re-run, and the gate's own gaps (the 600 s tool limit, a RED headline reading
"0 failed") are planned with that. memoro's `AGENTS.md` *Deterministic
publication sequence* still describes raw `git push`/`gh pr create`/`gh pr
merge`; it is rewritten in memoro once this has landed. Carried by
`publish-handover` (`docs/project/mc/publish-handover/PLAN.json`).

## 44 · A red is kept and handed on, a green tree is not measured twice, and main's red is main's

`ruling · 2026-10-16` · raised by Martin in the brief session

> "Vi behöver också se över mc test igen. […] Jag upplever att vi kör för
> mycket test, och vi håller inte kvar i felet utan samma test måste göras om
> flera gånger." (Martin, 2026-10-16) — and on the recommendations below,
> each taken as recommended.

Measured 2026-09-26..10-16: 1,758 memoro merge rounds for 1,300 landed PRs,
108 h of round time (62 % suite); 24 % of it in rounds before a PR's last.
Step sessions, over the ten days their transcripts are kept: ~1,100 test
calls, ~21 h — 194 `mc gate` (43 cut off by the 600 s tool limit, then
polled), 851 `node --test` (831 piped through `tail`/`grep`, 178 pure
repeats), 39 `npm test`; 19 of 52 mends began with a whole `npm test`.
Nothing keeps a red: the merger's TAP output stays in memory, the retry
preamble carries one line (at most five names), and the mend prompt's
`red files:` line was empty in all 52 mends. Four SQL snapshot tests red on
main were measured red in 77 rounds of 43 PRs; the JSC start-up budget in 39
rounds, dead-CSS in 20. 59 of 66 session REDs read "N tests, 0 failed".

1. **A red is kept.** Every red round writes its failing tests — name,
   assertion, location, at most 200 lines — to
   `~/mc/runner/merge-red/<repo>-<pr>.txt`. The retry preamble and the mend
   prompt carry that path, the red files, and a ready re-run line; the mend
   runs `mc gate`, never a whole `npm test`.
2. **A red is measured first.** A round for a PR whose previous round was
   red runs that round's red files alone, before the selection; still red,
   the round stops red there.
3. **A green tree is not measured twice.** `mc gate`, on a clean tree in a
   repository whose declaration has `select`, records its green against
   (tree, selection, gate version). The merger skips the suite and the
   selected command gates when its candidate's tree, its own selection and
   the gate version match a recorded green exactly; the PR's own tests still
   run. Anything else is measured as today.
4. **Main's red is main's.** The strictness rule in `repo-gate.js` (a change
   whose reached tests include one red on main is red) is reversed for a
   change that does not touch the test: when every red file left is red on
   main by the main-red probe, and the PR changes none of those files, the
   round is not red on them — it goes on, names them once in its verdict,
   and leaves an intake note for the helper (one per file per week). A PR
   that changes a red file is red as before.
5. **A declared timing test gets one more run.** The shipped gate table
   names, per repository, the test files and command gates known to flip
   under load (`retry_once`). A red only in those is run once more alone;
   green then, the round goes on and the flip is recorded. No quarantine: a
   file that flips often is a proposal, not a skip.
6. **`mc gate` answers inside the tool limit.** The log is written as it
   runs; after a budget of 540 s the gate says it is still running, with the
   log and `mc gate --wait`. One gate per worktree. The RED line counts every
   reporter block and names the failed command gates and the `ci runner:`
   reason. `mc gate <files…>` runs named test files the same way.

Carried by `gate-memory` (`docs/project/mc/gate-memory/PLAN.json`).

## 45 · A technical cause never fails a step, and a failed step says why where it is shown

`ruling · 2026-10-17` · raised by Martin in the plan session

> "detta är en brist i mc som vi behöver laga; mc ska aldrig fastna på sådana
> här tekniska orsaker. Vi behöver ev förbättra loggningen vid failed så att
> det direkt går att se orsak till alla fails." (Martin, 2026-10-17)

What happened on 2026-10-16/17, measured in `runner.log` and the register:

- `gate-memory` step 4 and `publish-handover` step 2 were `failed` after
  "interrupted 3 times in a row". Every session had died within three seconds
  on `API Error: 400 You have reached your specified workspace API usage
  limits. You will regain access on 2026-11-01 at 00:00 UTC.` with billing
  `credits`. `apiInterruption` read it as `quota` (`usage limit` matches
  `quotaSeen`), so the credit was never marked unusable and no hand-over to
  the plan happened — the plan's windows were at 2 % / 3 %. While the lane
  slept the quota pause, the step stayed `running` with the dead claude
  child's pid; the next round's `sweepRunning` found the pid gone and counted
  an interruption, three times, and the third failed the step.
- `publish-handover` step 6 ran on `publish-handover-7`, the branch #929 had
  landed from. The merger had restacked that branch onto main (`restack`,
  merger.js) and pushed a new head (97addbd7); the workarea's local branch kept
  the old tip (aec79c2a). `freshBranch` got `unknown` from `branchLanded`
  (main had since changed `src/mc/mend.js`), and `mergedPullAtTip` compared the
  PR's head with the *local* tip — different, so the branch was kept. The step
  was built, and its push was refused at the end.
- The page and `mc status` said only "step N failed; mc step ready starts it
  again". The cause was in `runner.log` or the register's `reason`, and for an
  interruption count it was not anywhere: the reason named no refusal.

Ruled, as recommended:

1. **A spent workspace limit is a credit refusal.** `workspace API usage
   limits` is `credits`, not `quota`; the credit is unusable until the time the
   refusal names (`regain access on <date> at <hh:mm> UTC`), else
   `CREDITS_RETRY_MS`, and the step is handed to the plan, not slept on.
2. **A lane waiting out a refusal holds its step.** While a lane waits (quota
   pause, server retry, login), the step's register session names the runner's
   own pid, so `sweepRunning` does not count the wait as a death.
3. **A branch the merger restacked and landed is landed.** `freshBranch` also
   accepts a branch whose newest merged pull request's head is
   `origin/<branch>` and whose local commits carry nothing that pull request
   did not; the workarea moves to a new branch from origin/main.
4. **A failed step says why where it is shown.** The register's `reason` is
   laid over the plan with the status; the NEXT line of the page and of
   `mc status` reads `step N failed: <reason>`; a failure by interruption count
   names the last refusal the API gave and the billing it came on.

Carried by `technical-fails` (`docs/project/mc/technical-fails/PLAN.json`).

## 46 · The archive keeps a project's README, and the links to it follow

`ruling · 2026-10-17` · raised in memoro's `msr-core` programme (ruling
`msr-core-doc-links`, F41, review I-2), carried here by the proposal
`2026-10-17-archive-keeps-readme`

> Should the archive keep the README, or should documents cite only
> `project_log.md` and pull requests? — Martin, 2026-10-17: **the archive
> keeps the README**, at `docs/project/<programme>/closeout/<name>.md` beside
> the closeout record, and rewrites the links to it in the same commit.

Measured on memoro `origin/main` 08d6e256ba: 221 relative links in 53 files
under `docs/project/` and `docs/technical/` resolve to nothing; 215 of them
point into an archived project's directory — 185 at its `PLAN.json`, 15 at
its `README.md`, 15 at another file or the directory. The count grows with
every archive.

1. `archiveIn` copies `docs/project/<programme>/<name>/README.md` to
   `docs/project/<programme>/closeout/<name>.md` in the commit that removes
   the directory and adds the closeout record. A README that code names
   (`keptFiles`) stays where it is and is not copied.
2. In the same commit, every relative Markdown link in a `.md` file under
   `docs/project/` and `docs/technical/` that resolves into an archived
   directory is rewritten: the README or the directory → `closeout/<name>.md`
   (anchor kept); `PLAN.json` → `closeout/<name>.json`; any other removed
   file → `closeout/<name>.md`. With no README, every one of those goes to
   `closeout/<name>.json`. A link to a kept file is left alone.
3. The closeout backfill does not restore old READMEs; memoro does that once,
   in `msr-core-residue` step 6. `mc plan <programme> --archive` is
   unchanged: it removes the programme's `closeout/` with the rest.

Carried by `archive-keeps-readme` (`docs/project/mc/archive-keeps-readme/PLAN.json`).

## 47 · A green `mc gate` on the pull request's head is reused after main moved: only the delta runs

`ruling · 2026-10-18` · raised by Martin

> "mc gate tar alldeles för lång tid och är alldeles för bred … gates måste
> vara sjukt smart" and "Allting måste gå mycket fortare; dvs det måste körs
> väsentligt många färre test och de som körs måste bli klara mycket
> snabbare." (Martin, 2026-10-18)

Measured since 2026-10-10: the merger spent 43.7 h on 513 memoro gate rounds.
Ruling 44 § 3 skips the suite only when a session's green `mc gate` matches
the candidate tree exactly — but the candidate is the PR head with the current
`origin/main` merged in (plus, sometimes, a derived-artifacts commit), and main
moves between the session's gate and the round. About 11 of the 513 rounds
matched.

1. **`mc gate` records what a delta needs.** Beside `tree`, `selection` and
   the version, a green records `head_tree` (the same tree), `base` (`git
   merge-base HEAD origin/main` at measurement), `files` (the selection's
   sorted test files) and `commands` (its sorted `packageScript` names).
2. **The round reuses the head's green and runs only the delta.** When the
   exact match misses, in a single pull request's round (never a batch,
   never `--full`) of a repository whose declaration says
   `select_changed_path: true`, the round looks up the green for the PR
   head's own tree. When there is one and its `base` is an ancestor of the
   commit the round merged, the delta paths are `git diff --name-only
   <green.base> <merged base>` and the files the derived commit regenerated.
   No delta paths: nothing of the selection runs again. Otherwise the
   declared `select` is asked again with ` --changed-path <p>` per path, and
   the round runs only the candidate's selected files (and command gates)
   that the delta also reaches, plus any the green never measured. Red
   handling is unchanged; the PR's own tests and the declared extra gates
   run as always.
3. **Why it is sound.** A test reached only by the PR's diff was measured
   green on the PR's tree, and main's movement touches nothing the selector
   says reaches it. A test reached only by main's movement was measured green
   when those PRs landed. Only a test reached by both — or newly selected —
   can change verdict. This is exactly as sound as the selector, which every
   round already trusts for every test it does not select.
4. **A failure is a full measurement, never a green.** A git error, a
   selector that fails or prints no `files`, or a green whose base main does
   not descend from: the round measures the whole selection as today and
   says why. A record written before these fields existed is matched only
   exactly.
5. **The hit rate is measured.** `reused` — `{ mode: 'exact' | 'delta', … }`
   — is in the round's report and in its line in `gate-rounds.jsonl`.

## 48 · mc owns programmes, projects and plans; the repositories get only results

`ruling · 2026-10-19` · raised by Martin in the `mc` programme session,
carried by the proposal `2026-10-19-mc-project`

> "Det måste bli mycket enklare att skriva en projekt-plan och att då den
> iväg … mc är så pass utbyggd nu att nu är det dags att vi syr ihop detta
> till en helhet." (Martin, 2026-10-19)

1. **No session writes a plan file; mc does, through `mc project` verbs.**
   "Vi har bytt från md till json en gång redan. Jag tror lösningen är någon
   helt annan än att byta tillbaka. Jag tror lösningen kan ligga i mc." The
   file format becomes mc's own.
2. **Plans leave the product repositories.** "Med ett smart 'mc project'
   system så kommer det synas även om det ligger lokalt i mc. Frågan är alltså
   vad som faktiskt ska ligga i repot." The repositories keep code,
   `docs/technical/`, product rulings and one `project_log.md` row per
   delivered project.
3. **The structure:** "mc/program x/projekt y/ repo x, repo y, + planfil och
   stegfiler", under `~/mc/programs/` ("Den senare").
4. **The programme session is the foundation; there are no project
   sessions.** "mc plan <program> sessionen såsom det är nu är fundamentet.
   Det är projekt-sessioner vi inte ska ha."
5. **Every step names `haiku` or `opus`, no default; no `why_opus`**
   ("Stryk why opus").
6. **`discard` removes the whole project directory; `archive` is the way out
   for a project that is done.** "Om man tar bort ett projekt så är väl hela
   tanken att hela projektet ska bort … För plan har vi archive istället."
   "Vi har redan ett verb discard, skapa inte drop."
7. **Out of scope for now:** follow-ups ("Uppföljningar är ett senare
   bekymmer"), backup of `~/mc` ("låt oss vänta med backup-arbetet och landa
   detta först"), sessions outside this machine.

The concept in full: [`mc-project.md`](mc-project.md). Carried by
`archived-releases` (a blocker fix needed under the current layout) and the
`mc project` projects that follow it.

## 49 · A done project is archived after 24 hours, never a programme; the docs route stays

`ruling · 2026-10-20` · raised in the `mc` programme session while planning
project 3 of ruling 48

1. **The runner archives a done project under `~/mc/programs/` by itself,
   24 hours after it is done; `mc project archive` does it at once.**
   "Ja, ett färdigt projekt kan arkiveras automatiskt (vi kan låta det stå
   done i 24h dock i mc listan."
2. **A programme is never archived automatically.** "MEN observera att vi
   inte har någon automatisk arkivering av PROGRAM (mc plan) och det vill jag
   inte heller ha." `mc plan <programme> --archive` stays the only way.
3. **The docs route stays whole** — `runDocsMerge`, `mc merge --docs`, the
   docs-only routing and the gate's docs fast path. "Docs path ska inte gå.
   Den är utmärkt att ha kvar." Only the machinery that exists for plans in
   git goes. (`mc-project.md` § Order, project 3, said "docs path removed";
   that is withdrawn.)
4. **Archive writes only the `project_log.md` row**; the paragraph on goal and
   decisions in a technical document is written by the steps' own pull
   requests, as today.
5. **Project 3 is two projects**: `project-archive` (archive, discard, the
   24-hour hold), then `plans-out-of-repos` (the repository copies and the
   plans-in-git machinery removed).

Carried by `project-archive` and `plans-out-of-repos`.

## 50 · A repository holds only descriptions of what exists; everything under `docs/project/` moves to mc

`ruling · 2026-10-20` · raised in the `mc` programme session while planning
what is left of ruling 48

1. **Everything under `docs/project/` in memoro and memoro-cli moves to
   `~/mc/programs/<programme>/`** — programme documents, `rulings.md`,
   `closeout/`, READMEs, reviews and handoffs, and `project_log.md`. "Allt som
   nu ligger under progammes/ ska in i dess motsvarande mc-mapp. På repot har
   beskrivning av befintlig funktionalitet." (Martin, 2026-10-20)
2. **A repository keeps descriptions of existing functionality**:
   `docs/technical/` and the like. This replaces ruling 48's table, which kept
   product rulings and one `project_log` line per project in the repository,
   and `mc-project.md`'s out-of-scope line that left `closeout/` files there
   as history.
3. **`archive` writes nothing in a repository** once the move has landed: the
   `project_log` row is written under `~/mc/programs/`.
4. **A runner step area is never blocked on its own sessions' files** —
   Martin, on `home-route-cue` blocked on `dirty-worktree` the same day:
   "detta ska inte ens vara möjligt".

Carried by `step-area-never-dirty` (4) and the docs project of ruling 48 (1–3).

## 51 · Three kinds, linked by name: what a project knows beside its plan, what the runner runs under runner/

`ruling · 2026-10-20` · raised in the `mc` programme session while planning
project B of ruling 48

Ruling 48's structure put a project's step worktrees inside its directory.
Read against the code, that cannot hold: mc removes an area by removing its
directory, and counts every process, conversation, dev server and lease under
it as the area's — closing a step area would have moved the plan away, and
archiving a programme would have removed every project in it.

1. **A programme is one directory with everything of it**: its session's
   worktrees, its documents and its projects. "plan = på programnivå." "mc/
   programs/<p>/ med allting PLAN.json, worktree memoro/ och memoro-cli,
   plan-sessioner, övriga docs. Det som då inte är där är worktree som
   tillhör step." `~/mc/plan/` goes.
2. **Everything the runner runs is under `~/mc/runner/`**: `step/`, `mend/`,
   and any later kind of run beside them. "allt som har med runner borde
   ligga i samma mapp, t ex mc/runner/step/ och mc/runner/mend/; det blir
   också naturligt att samla andra typer av körningar." `~/mc/step/` goes.
3. **A project's knowledge is in its directory, the running of it in
   `runner/`**: `PLAN.json`, `STATE.json` (the register, moved from
   `runner/projects/`) and `CLOSEOUT.json` beside each other; worktrees, raw
   logs, the queue and caches under `runner/`. The test: wiping `runner/`
   loses only work in flight and raw logs.
4. **Worktrees are made where they are used**: `mc project new` writes only
   the draft; the runner makes a step's worktree when a step in that
   repository runs. "mc project new ska aldrig skapa repon! repot skapas av
   runner när ett visst step körs."
5. **In a programme's directory mc removes only git worktrees**, never the
   directory, a project or a document.
6. **No `steps/` files**: a step's prose stays in `PLAN.json`.

Replaces § Structure of `mc-project.md`. Carried by project B.

## 52 · A session runs the tests its change reaches, in the lane; the whole measurement is the merger's, queued by `mc publish`

`ruling · 2026-10-24` · raised by Martin

> "Sessionerna tar extremt mycket tid och resurser när de är klara med sitt
> arbete, de kör `mc gate --wait` sedan `mc publish` och `mc merge`. Allting
> tar evigheter och deras anrop går vid sidan av konstruktionen av heavy lane /
> light lane vilket ska förhindra att flera parallella processer tar datorns
> kapacitet. Dessutom så kostar detta massor med modell-turer. Fullständigt
> bortkastat. mc gate OM den överhuvudtaget ska köras och det ska i princip
> inte gå att köra full gate." (Martin, 2026-10-24)

Measured over the 65 step sessions of 2026-10-20..24: 209 bare `mc gate`
(32 of them `--full`), 116 `mc gate --wait`, 76 `mc gate <files>`, 51
`mc publish`, 53 `mc merge` — a median of 12 Bash calls from the first gate
or publish to the session's end. A whole memoro gate is 10–11k tests and
several minutes; many hit the 600 s tool limit and were polled. None of
them took the gate lane: a session's gate looked once, at its start, for a
deploy, an iOS build or a merge round (`await-deploy.js`), and then ran beside
every other session's gate and the next merge round. And it bought little:
the merger reused a session's green in 36 of the last 300 memoro rounds
(20 exact, 16 delta, rulings 44 and 47) and measured the rest again.

1. **`mc gate` runs test files, never the suite.** Named, at most 30, each a
   test file and not a directory; bare, the test files the branch adds or
   changes against `origin/main`. `--full` is refused, and so is the whole
   gate: the fast paths, `mc-gate-last.json`, the incremental run after a
   red and the recorded greens go with it. The merge round measures the
   selection once, in its lane — the reuse code of rulings 44 § 3 and 47
   stays, and finds nothing to reuse.
2. **Every `mc gate` runs in its repository's gate lane.** The detached
   shell takes the lane's lock for its own pid (`gate-lane-wait.js`, `mode:
   'session-gate'`) before the tests and gives it back after them, waiting
   while anything holds it. The merger, a deploy, an iOS build and `mc test`
   already wait for that lock, so a session's run is one more round in the
   lane's queue, never one beside it. This replaces `await-deploy.js`'s
   look-once for a session's gate.
3. **`mc publish` queues.** After the push and the PR it runs `mc merge
   <repo> <pr>` in the same call, and prints its lines; a queued step is told
   to end the session in that turn. Not with `--no-merge`, `--json`, a
   detached `--branch` (a mend's: the merger that started it measures the
   moved branch), or a head GitHub does not hold yet.
4. **The raw suite goes to `mc gate`.** The pre-tool hook turns `npm test`,
   `npm run test` and `node --test` to `mc gate <files…>`, as it turns
   `npm run ci`; `npm run test:<x>` passes. `MC_HOOK_ALLOW=1` is the escape.
5. **The sessions are told so.** `step.md`, `_common.md`, `_session-work.md`,
   `mend.md` and the prompts in `run-plan.js` and `mend.js`: test the files
   the change reaches with `mc gate <files…>`, one call with a 600 s tool
   timeout; commit; `mc publish`; `queued for the merger` ends the session.

This amends ruling 44 § 6 and the session half of rulings 44 § 3 and 47.


## 53 · A project row carries one state word with one colour: green moves by itself, yellow waits on time, red waits on a person

`ruling · 2026-10-24` · raised by Martin

> "Vi behöver polera lite på hur mc visar status mm. Varje projekt-rad ska
> vara mer lika och ha fler statusar: grön: ready, running, landing; gul:
> waiting (typ för visst steg vid viss tid); röd: blocked, failed." (Martin,
> 2026-10-24)

Until now a project row said the plan's word — `ready`, `running`, `landing`,
`done`, `failed`, `blocked`, `unmet` — with `running` in yellow, `landing` in
no colour at all, and a step parked on a time or a deploy (ruling 35, released
by the runner itself) in the same red as a step waiting on Martin.

1. **One word per state, one colour each**, wherever a project's state is
   printed: `ready`, `running`, `landing` green; `waiting` yellow; `unmet`
   yellow bold; `blocked`, `failed` red; `done` grey. `waiting` is a blocked
   step whose blocker releases by itself — `time`, `deploy`, `project`;
   `blocked` waits on a `decision` or a `workarea`, which is a person.
2. **The rows read alike.** The `next` cell is the step's title, then the
   state's detail: the pull request a landing step is in, what a waiting step
   waits for and how long is left, the decision or workarea a blocked one
   waits on, a failed step's reason.
3. **The counts follow the word.** A programme heading says `N ready · N
   waiting · N blocked`; so does the brand row. A waiting project keeps its
   row; a blocked one still collapses under its heading (Martin, 2026-09-19).
4. `mc --json` keeps `status` as the plan's word and adds `state`.

Carried by project `page-states` (programme `mc`).

## 54 · The primary checkouts go: bare repositories under `~/mc/repos/`, mc's own checkout under `~/mc/self/`

`ruling · 2026-10-24` · raised by the brief session, decided by Martin

The proposal `2026-10-24-mc-environment-model` measured what `~/memoro` and
`~/memoro-cli` do: every worktree hangs off their `.git`, and `~/memoro-cli` is
what `/opt/homebrew/bin/mc` runs from — a branch checked out there swaps the
tool under every session. `~/memoro` stood on `camera-test`, 351 commits behind
`origin/main`, with 19 stashes. Martin decided (2026-10-24): no primary
checkouts.

1. **The git store is a bare repository**, `~/mc/repos/<name>.git`, that every
   worktree hangs off. Nothing can be checked out there by accident.
2. **mc runs from its own checkout**, `~/mc/self/memoro-cli`, a worktree on
   `main` fast-forwarded by the merger's deploy pull. `~/mc/self/memoro` is the
   checkout `mc shot` and `mc test dev` serve outside a worktree.
3. **mc knows both layouts** through one module, so the same code runs before
   and after the move; the move itself is `mc repos migrate --apply`, run once
   by a person with the runner, the merger and the dev servers stopped.
4. Stashes and local branches move with the git directory and are kept.

Carried by project `repos-layout` (programme `mc`); the dependency store,
`prepare()`, the hook and the test pipeline of the same proposal are planned
after it lands.

## 55 · The merger lands one pull request per round, and a round's suite keeps at least four lanes

`ruling · 2026-10-24` · raised by Martin

> "Ja, stäng av batchningen. Tiden för merge per runda måste ner dramatiskt!
> Vi behöver ytterligare åtgärder." (Martin, 2026-10-24)

Measured over `~/.memoro/mc/gate-rounds.jsonl` and `~/mc/runner/log/merger.log`,
memoro, 2026-10-17 → 2026-10-24:

- **Batches cost more than they save.** 305 single rounds: 349 files selected
  at the median, suite 154 s, wall 210 s, 80 % green. 37 batch rounds: 874
  files, suite 406 s, wall 822 s, 54 % green, and a red batch falls back to
  one round per member. About 430 s per landed pull request against 210 s.
- **The suite runs at two lanes all day.** Since #1020 (2026-10-19) a round's
  lanes are the free cores, `cores − 1 − load`, never below 2; with four step
  sessions the load stands at 10–16 on 8 cores, so every round has run at 2.
  A 1 206-test selection takes 145–169 s by day; the nightly full suite
  (25 600 tests, seven lanes) takes 11–14 minutes — five to eight times more
  tests per second. Of a round's suite, the standard batch is 178 s at the
  median, the serial `sqlite` batch 99 s, `heavy` 9 s; the rest of the round
  (fetch, prepare, derived, selection) is about 35 s.
- **Lane waits behind deploys**: 16 rounds waited more than a minute, 5 h in
  all over 4.5 days; the longest, 90 min, behind a deploy whose `wrangler
  deploy` retried for 1 h 45 and failed.

1. **One job per round.** `MERGE_BATCH_MAX` is 1; the batch code stays for a
   merger resuming a batch it died under. This amends ruling 34.
2. **A merge, check or full round runs at least four lanes**, never above
   `cores − 1`; a session's gate keeps the free-cores formula; `MC_TEST_LANES`
   still wins. The reds-under-load requeue (2026-10-19) stays as the net.
3. **Every round record names `lanes` and `load`**, so the next measurement
   can say what a round ran at.

Carried by project `merge-round-time` (programme `mc`). memoro's share —
the `sqlite` class run one file at a time, and selections of 300 files or
more in half the rounds — is two proposals
(`2026-10-24-memoro-sqlite-test-class-parallel`,
`2026-10-24-memoro-selection-reach`). The deploy's hold of the lane is open.

## 56 · The merger hands over at once, a round stops when its pull request is gone, documents are tested, and `--admin` is Martin's

`ruling · 2026-10-24` · raised by Martin

> "jag blir tokig på vår mc merge … Låt oss gå igenom hela processen. Robust,
> resurssnål, effektiv är ledorden." — "Ja." (to the five projects below, with
> `--admin` as his verb) — "Just nu är det också bara en merge lane som kör.
> Det ska vara två heavy + light." (Martin, 2026-10-24)

Measured over `~/.memoro/mc/gate-rounds.jsonl`, `~/mc/runner/log/merger.log`
and GitHub, memoro, 2026-10-17 → 2026-10-24:

- 220 of 319 landed pull requests landed in one round; no step went `failed`
  through the merger. Open → merged is 11 min at the median, 41 at p75, 2 h at
  p90 — and 22 000 of the tail's 27 000 minutes passed before the merger saw
  the pull request (stacked steps waiting on their parent, sessions still
  working).
- The suite is 28 of 42 heavy-lane hours. Selection narrowing was measured
  in the selection-reach proposal (best edge cut 5 %, area rules 19 %) and is
  left until the lanes and sqlite projects have landed.
- **76 handovers stalled the queue 643 minutes**: on new code the merger took
  no new job in either lane until its round and mends in flight ended (p90
  24 min, max 72 min). That is the single lane Martin saw.
- A round ran 13 minutes for memoro #14169 after it had been merged with
  `--admin`; six admin merges in the week were raw `gh pr merge` calls.
- Four documents-only landings turned main red (#13980, #13995, #14138,
  #14188); memoro's selector draws eight files for #14188's paths and
  `doc-links.test.js` is red on its commit.
- One hung test held the heavy lane 95 minutes (#14067) and named nothing.

1. **The merger hands over at once** — releases `merger.json`, starts its
   successor, finishes only the jobs it holds (project `merger-handover`).
2. **A round stops within a minute when its pull request is merged, closed or
   pushed** (project `round-abort`).
3. **`mc merge <repo> <pr> --admin` is Martin's verb**: squash with the admin
   override pinned to the head, booked as landed; a session runs it only on
   his word (project `merge-admin`).
4. **The docs form runs the tests the selector draws for the documents**
   before it squashes, still in the call (project `docs-reads`).
5. **A test that never ends is a red by name** after ten minutes (project
   `hung-test`).

## 57 · An archived programme's directory leaves `programs/` for `archive/programs/`

`ruling · 2026-10-25` · raised by Martin

> "Meningen är ju att jag ska köra plan --archive när ett program är avklarat
> och inte behövs mer." (Martin, 2026-10-25)

`mc plan staff --archive` released the planning session's worktrees and said
"the programme's directory stays": ruling 51 § 5 kept every programme's
directory, and #1051 let the archive inherit that. § 5 was written for a
programme that is still going; for one that is over it left an empty shell
under `~/mc/programs/` for every programme ever closed.

1. **Archiving a programme moves its directory whole** to
   `~/mc/archive/programs/<programme>/`, once main is archived and the
   planning session's worktrees are released: its projects (`PLAN.json`,
   `STATE.json`, `CLOSEOUT.json`) and documents go with it. A name archived
   before gets `-2`, `-3`, …; nothing is moved over.
2. **Nothing under `archive/` is live**: no plan, register entry, area or
   stray is read from it.
3. Ruling 51 § 5 holds for every other verb: in a programme's directory mc
   removes only git worktrees.

## 58 · A project builds on one branch and lands once, after a review step mc adds

`ruling · 2026-10-25` · raised by Martin

> "Jag tror vi ska göra om hur mc genomför projekt. Det blir onödigt många
> merges-rundor. Jag tänker att vi istället ska låta ett projekt gå färdigt
> innan vi gör merge. Ett steg gör sin kod, nästa steg plockar upp och fortsätter,
> fixar ev test-fel som kommer efter föregående session. När projektet är klart
> inför vi ett review-steg. Projektmål mot ufall genomförs. Eventuella brister
> fixas till. Därefter skicka till merge." (Martin, 2026-10-25)

One pull request per step made a project as many merger rounds as it had steps:
each step stacked on the one before, was measured alone, and landed alone, and
the criteria were measured only at the last of them. Martin asks for the
project to be finished first, and for one step of its own to measure every
criterion against the goal, close what falls short, and then land the project.

1. **A plan sent from now on builds on its project's one branch.** Its steps
   build on that branch one after the other, and a step whose work is done and
   published is `built`, not landed: it is behind the plan, and nothing of it is
   queued.
2. **`mc project send` appends a review step, always, one-step plans included.**
   It is the plan's last step, `kind: review`, mc's and not the plan's. It
   measures every success criterion, holds the diff to the goal, the contract and
   the out of scope, closes the gaps, and lands the one pull request. Its landing
   makes every built step `done`, with the same landed sha.
3. **Plans sent before this ruling keep one pull request per step**, as they
   ran (Martin chose the old flow for them). Converting them is not done here.
4. **Nothing in a plan with a review step waits for its own deploy.**
   `--after-deploy` is refused there, and a check that needs production is left
   out of such a plan (Martin: that is outside the project).

The project that carries this is `project-branch`.

## 59 · A step names a work class; mc routes subscriptions, not credits

`ruling · 2026-10-27` · raised by Martin

> "Arbetsklasser absolut. Men fördelen är att vi kan ändra efter behov; lägga
> till och byta efter att priser mm ändras." … "Ja, set review add/remove
> fast/large. Detta låter bra." … "jag tänker att detta inte är något som ska
> kollas vid varje step körning utan det är någon som mc håller och kan kolla
> t ex en gång per timme eller så." (Martin, 2026-10-26)

> "Ja!" (Martin, on preferring an available subscription to credits even when
> that changes provider) … "Nej. Användning av krediter behöver kopplas in
> medvetet med gränser isf. just nu har jag enbart anthropic krediter som kan
> användas." … "Ja, kör på abonnemang först." (Martin, 2026-10-26–27)

1. New implementation steps name `fast` or `large`, not a provider's model.
   These are work classes, not claims that two models have equal quality. The
   initial candidates are Claude Haiku and Codex Luna for `fast`, Claude Opus
   and Codex Sol for `large`; `mc model add/remove fast|large` changes each
   class's candidates and their effort without rewriting plans. Existing plans
   with concrete models keep their meaning.
2. Review is one separately configured model, changed by `mc model set review`:
   Claude Opus at high effort now. It does not inherit the implementation
   step's provider. `mc plan` remains the tool Martin chooses when starting it.
3. mc observes subscription capacity centrally, on roughly an hourly cadence
   and when sessions report usage or a refusal. Starting a step reads that
   observation locally and chooses a candidate in its class; it does not
   query each account then. The actual tool, model, effort and billing are
   recorded for the session. A running session is never switched between
   providers; a refusal can affect the next launch.
4. Automatic routing uses available **included subscriptions first**, even
   across providers. It does not automatically spend credits. `mc run
   --billing plan` was set on 2026-10-27 so new Claude sessions use the plan
   while this changes. Codex paid credits are out of scope. Anthropic API
   credits are a separate, later decision requiring a deliberate enablement
   and limits; the present project's `auto` must not silently turn them on.

The project that carries the subscription part is `subscription-model-routing`.

## Explicit interactive Codex full-access selection

`ruling · 2026-10-27` · `mc-codex-explicit-full-access`

**Question.** Should mc honor explicitly selected full execution access for
interactive Codex sessions, without changing defaults or automatically escalating
a failed browser launch?

**Answer.** Martin: "Ja, MEN du kan inte göra riktig haptik-kontroll i en browser på en Mac."
Implementation authorized: "Go!"

**Carried by.** The in-session explicit-workspace change. Read-only and worktree
profiles remain restricted, approval policy is separate, and a running session
cannot widen its own permissions. Browser evidence is limited to requests and
timing; physical haptics require a physical device.

## One execution boundary regardless of coding tool

`ruling · 2026-10-27` · `mc-tool-neutral-execution-access`

**Question.** Should normal mc commands provide the same host execution access
regardless of the selected coding tool, instead of requiring a Codex-specific
environment variable at each launch?

**Answer.** Martin: "Gör detta lika oavsett Claude/Codex eller annat verktyg."

**Carried by.** The in-session unified access change. This supersedes the
per-tool opt-in workflow in `mc-codex-explicit-full-access`. Every interactive
launch uses one host-execution contract; adapters translate it or refuse
unsupported access. Approval policy stays separate and external restrictions
remain authoritative. A running session does not grant itself new access.
Browser haptic evidence remains requests and timing, not physical sensation.

## Manual Anthropic API credits for work classes

`ruling · 2026-10-27` · raised by Martin after `subscription-model-routing`

Martin: "mc behöver inte sätta tak, jag sätter tak i antropic platform per
leverantör" and "jag vill själv kunna ändra till credits manuellt. Vi tar
alltså bort auto-läget". When credits are selected, "varje steg [väljer] just
en antropic modell fast/large".

`mc run --billing` accepts only `plan` and `credits`. `plan` keeps the
subscription router from ruling 59. `credits` selects the first Anthropic
candidate of each work class, irrespective of subscription capacity, and uses
the Anthropic API key. Review uses its configured Anthropic model. If a class
has no Anthropic candidate or the key or workspace credit is unusable, it
starts no session. The next launch may retry when the cause is fixed; it never
silently spends the Anthropic subscription or selects Codex in credit mode.
The Anthropic Platform workspace limit is the spending bound; mc does not
maintain a second dollar cap. This supersedes ruling 59's temporary exclusion
of credits from class routing and retires the `auto` billing mode.

## 60 · A goal is the unit of autonomous work, beside unchanged projects; headless plan is goal-driven, not a decision catalogue

`ruling · 2026-10-29` · raised in the `mc` planning session after the seven
`autonomy-*` projects landed (#1157–#1162, #1170) with every control
capability built but none wired into the installed runner

**Question.** The implementation plan of 2026-10-28 made the autonomous mode
a second system: an approved programme contract as a precondition, `start`
taking build class, control profile and reviewer, goals created only by the
headless plan through a `decide` envelope under a lease, and `landed` kept
apart from `confirmed`. Before activating it: is that the model, and how does
it sit beside projects with fixed steps?

**Answer.** Martin, 2026-10-29:

- On keeping both ways of working, against a split by domain: "Uppdelningen i
  sig är meningslös. Att spara båda sätten har förstås värde."
- On the control profile: "Profil är inget som planeras per projekt. Det vi
  tar fram är hur det ska fungera."
- On class and authority: "Klass sätts av någon (interaktiv plan eller
  headless) som är den som skapar mål; det får inte finnas någonting som
  hindrar en interaktiv plan från att göra allt. Fördelen med headless plan är
  att den ska kunna vakna till och fixa till saker som fastnar på ett
  strukturerat sätt."
- On the planner's envelope verb: "Verbet decide saknar värde. Ta bort."
- On the unit: "Ett färdigt goal (ie project) - jag föreslår det som koncept
  för att skilja det från projekt så vi inte påverkar det som redan fungerar.
  Är också en trigger för headless session: den ser 'ah goal är klart', då
  kan den kolla på program-mål och ta fram/starta nästa del-mål."
- On concurrency and shape: "Vi kan köra parallella goals om vi vill att det
  ska gå fortare för då är det en session per goal eller så samlar man många
  punkter under en. Vi kan ju också tänka oss att ett program omfattar faser:
  1 grunden: goal x, goal y, goal z."
- On the headless plan: "headless session ska inte hårdkodas som du tänkt dig
  med exakt beskrivna steg. den ska vara målstyrd utifrån programmets
  beskrivning."

**Carried by.** The brief [`autonomy-goals.md`](autonomy-goals.md): a
programme holds ordered phases of goals beside its projects; a goal has
criteria, a class and no steps and is created, sent, revised and closed with
`mc goal` verbs by whichever plan session is at hand; the control profile and
the review model are system configuration; `mc programme autonomy on|off`
lets a headless plan session consume the programme's event queue, guided by
the programme's brief and phases; `decide` and the programme contract
ceremony go. Plans to follow from that brief.


### Clarification to ruling 60 · autonomy off and explicit phase completion

Accepted by Martin with "Go." on 2026-10-29, to the two proposals below. This
clarifies the original ruling; it does not replace the answer recorded above.

- **Autonomy off disables only new headless planner claims.** Already sent
  goals continue to build, review and merge. Their events remain available
  for foreground planning or a later headless claim.
- **Phase completion is an explicit shared planning operation.** Either
  foreground or leased headless planning may complete a phase only after all
  its goals have landed and all follow-ups have measured evidence. An empty
  phase never advances automatically.

These settled semantics govern `goals-foundation` and `goals-programme-plan`;
neither project activates the live autonomous runner.
