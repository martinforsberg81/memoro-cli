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

## 10 · A round reads the plan from `main` unless the plan itself is the conflict

`ruling · 2026-09-05` · answers `plan-read-from-main-1`, raised by
`plan-read-from-main` step 1 (#629)

**Decided at the brief, not by Martin.** He asked for the open decisions to be
taken one at a time and to be brought in where one carries weight; this one is a
single predicate in the runner's read path, measured, reversible, and costs
nothing outside mc's own scheduling. It is written here in his file because
`rulings.md` is the only place a decision about this programme survives, and it
is marked so nobody later reads it as his word.

`run.js:1265` calls `planOf(worktree, name, { fromHead: conflicts.length > 0 })`.
The docstring at `run.js:336` defends reading HEAD — *"HEAD is the branch's last
good copy... Main's own edits to the plan are what the session is merging in"* —
and it is right about exactly one case: a conflicted `PLAN.json`. The condition
it is attached to fires on **any** conflicting file. That mismatch is the whole
defect.

The three options step 1 put: **1** — always read `origin/main`, never the
worktree. **2** — refuse the step when the worktree could not be brought to base.
**3** — scope `fromHead` to a conflicted plan, with 2 beside it as a guard.

> **Beslut:** option 3. `conflicts.some(isPlanPath)` in place of
> `conflicts.length > 0`, and the guard is built as its own step.

The measurement decides it. Over the whole of `~/mc/runner/log/runner.log`
(24 755 lines), 207 rounds reached a conflict: **27 with a `PLAN.json` among the
conflicting files and 180 — 87% — with none.** Option 3 removes those 180 with
one predicate and leaves untouched the case the docstring was written for.
Option 1 would take that case too, and its cost is not theoretical: it drops the
branch's own plan edits on the clean path, of which the one that matters is a
step marked `done` with a `pr` that then did not land. Option 2 alone turns a
silent wrong answer into a loud one without fixing the answer.

Two findings from step 1 that make option 3 smaller than it looks. It needs no
`git show origin/main:` read at all — during a merge stopped on some other file,
git has **already** written main's plan into the worktree, demonstrated in a
scratch repository rather than assumed. And `isPlanPath`
(`src/mc/plan-merge.js:159`) is already imported into `run.js`.

**What this does not fix, said out loud:** the 13 of those 27 rounds where
`fromHead` fires legitimately and still gives a stale answer —
`sdk-artifact-storage`, whose branch had landed and whose plan main then
re-planned. That is a different mechanism (`branch-landed.js` answering
`'unknown'` and `freshBranch` reading it as "not landed"), and it has its own
proposal in `~/mc/proposals/2026-09-05-branch-landed-unknown-after-replan.md`.

**Carried by [`plan-read-from-main/PLAN.json`](plan-read-from-main/PLAN.json)**
step 2, whose instruction was already written assuming this answer, with step 3
building option 2's guard.

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
