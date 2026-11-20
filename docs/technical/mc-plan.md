# mc plan — a programme's interactive session

Linux SSH interactive launches keep their provider alive past the terminal ([Claude background session or Codex app-server](mc-interactive-sessions.md)); macOS retains the existing foreground terminal.

```
mc plan [<programme>] [--new|--resume [<id>]] [--codex|--claude] [--model <model>]
mc plan <programme> --archive
```

This is the person's entrance, not a command for a session already planning.
`src/mc/commands/plan.js` refuses recognised session identity or coding-agent
markers before choosing a programme or creating anything. Inside a session,
goals change through `mc goal new`, `mc goal set`, `mc goal item`, `mc goal obligation` and `mc goal criterion add`.
Help remains available.

## A programme, and why it is not a workarea

A programme is a bounded implementation plan, archived when its work is finished. Its plan is in
`~/mc/programs/<programme>/README.md`. Its interactive session starts in that
directory, with a worktree of each known repository beside it on
`plan/<programme>`. The directory also holds `goals/<goal>/`, each goal with
its own GOAL.json, LOG.md and repository worktrees on `goal/<goal>`.
The runner never builds in the programme session's checkouts.

`ensurePlanArea` fetches before creating missing worktrees from `origin/main`.
Existing checkouts are reused and dependencies reattached. Missing repositories
are said and skipped; no checkout at all is a failure. Layout 1's planning
root remains supported ([mc-layout.md](mc-layout.md)).

When `mc plan` opens a programme whose planning directory has no `README.md`,
it writes the fenced page from `canon/tasks/references/programme-readme.md`
before the session starts, and the opening prompt says it is a template to
fill in. An existing README is never touched by the command; its next plan
session reconciles it with the bounded template. The page has What it is for,
End, Decisions, Phases and Where things are. Enduring direction belongs to area
pages. For a legacy programme, preserve its held Aim in the appropriate area
without silently changing its meaning, finish active work in place, write back
and archive. Its enduring direction need not be declared over. Without a valid
record use the supported manual archive route; an established valid record can
use the runner route subject to its checks.

With no programme named, `chooseProgramme` offers a numbered list, a new name,
or an empty answer to leave. A pipe gets usage instead of a question. The
list combines programmes read from the repositories (`listProgrammes`) and
open planning areas on disk (`openPlanAreas`). A programme can be reopened
before it has documents on main, or after all its goals have been archived.

## A programme with a record

Area learning is not a planning entrance. It does not create or alter
programme orders; a functionality defect it finds stays linked to an area
proposal. The programme's ordinary desk path is unchanged.

A programme may have a record, `PROGRAMME.json` directly in its directory
(`src/mc/programme-record.js`): a bounded piece of work serving a horizon, or storage for small area work
without one. A programme without the file is also bounded. Version 2 has the
following keys; `area`, `phases` and `repair` are optional. Removed signing fields
and `legacy` remain readable on old records but are not written:

| key | value |
|---|---|
| `schema` | `"mc-programme"` |
| `version` | `2` (version 1 remains readable) |
| `horizon` | the slug of the horizon served, or `null` |
| `area` | optional: `<repo>/<id>`, an area a repository declares; allowed only with `horizon` `null` |
| `end` | one non-empty sentence saying when the programme is done |
| `state` | `draft`, `ready`, `done` or `Martin` with a repair scope stop |
| `created` | an ISO instant in UTC to the second |
| `created_by` | `person`, `martin`, `repair` or the historical `manager` |
| `phases` | optional: `{"order": "stated"}` with, when a phase waits, `"after": {"3": [1, 2]}` |
| `repair` | required for `created_by: "repair"`; absent for ordinary orders. Provenance for a functionality repair, with null horizon and no area-text order |

`draft` means not finished; planning and build take nothing from it (`mc goal new`
is refused, the planning turn does not run, no session starts on its goals).
`ready` means goals may be cut and built subject to their admission rules;
`done` means finished. Every new record is draft. For a taken-over repair,
only interactive Martin can prepare its goals while it is draft; a declined
repair with landed work reads ready for write-back only.

Both the overview and `mc programs list` include current local programme
directories, including recordless directories. They share the same rules
for omitting finished entries: a done record leaves both views when no live
goal remains, and a retained repository tree alone stops counting as
membership only with a validated receipt on the shelf. A current local
directory or live goal takes precedence over an earlier receipt. See
[the overview](mc-ui.md#the-overview) for what the receipt proves.

Reading an older record normalizes it in memory: `open` reads as `ready`, `dropped`
as `done`, and removed fields are ignored. It does not change disk bytes or state.
Only an actual write upgrades a record to version 2.
Older mc rejects new repair metadata as an invalid record rather than
treating a stopped or disposed order as an ordinary ready record.

The ordinary desk writer creates a programme only for a person or Martin's
interactive session (`mc martin`); every headless role is refused (exit 2).
Martin sets an ordinary order's state with `mc programs state <programme>
draft|ready`. The [repair command](#repair-drafts) uses the same validated writer and its own
reviewed release rule.

A record cannot name both a horizon and an area. A repair programme (`--area`)
orders a set of small adjustments to one area as one document, and the planner
cuts its goals; an area may have several repair programmes open, and one may
hold several live goals. No programme needs a horizon: Martin decides what is
taken up and in which form, and only a change small enough to run through
directly skips the document (Martin, 2026-11-16).

`phases` says how the programme's phases run. A record without it is a
sequential programme: a phase starts when every lower phase is finished. With
`"order": "stated"` a phase starts when the phases the record says it waits for
are finished, and one that waits for none starts at once. `create` writes
`{"order": "stated"}`; `record` writes no `phases`, so a programme under way that
is given a record stays sequential, and nothing opts one in later. The key's
form (the phase numbers of `after` are whole numbers from 1, ascending, none
twice, never the phase itself, no cycle), the rule, what renumbering does to
it and what is shown are in [mc-goals.md](mc-goals.md#phases). A `phases` of
another form is a problem, so the record is invalid.

The record is also what lets the runner plan the programme with nobody present:
a programme with a valid `ready` record and a `README.md`
gets one headless planning turn that cuts its phases and
goals from README.md
([mc-run.md](mc-run.md#programme-planning-turn)). A programme with no record, or
with an invalid one, is never started that way; `mc plan` stays the person's
entrance.

The slug is not checked against the desk's horizons: mc stores what it is
given. Its reader says `none`, `valid` or `invalid` with the problems; a
record is validated before every write. Creation never replaces a file that
is there (a temporary file linked into place). All existing-record writers (phase, state)
take the shared runner lock with `strict: true` around a fresh read, validation
and atomic replacement, retaining the other fields. They refuse rather than
write without that lock; archive destination bookkeeping takes its own lock
separately, never wrapping the record writer in a nested acquisition.
`state` is read by the programme
planning turn (a turn starts only for `ready`),
and by the archive turn, and the list and the page show it. Only the runner
sets it to `done` (`setRecordState`), once it has archived the programme
([mc-run.md](mc-run.md#programme-archive-turn)); `mc plan <programme> --archive`
archives a programme of either kind, as in
[Archiving a programme](#archiving-a-programme), and leaves `state` as it finds it.

```
mc programs create <programme> --end "…" [--horizon <slug> | --area <repo>/<id>] [--purpose "…"] [--from-proposal <path>]
mc programs record <programme> --end "…" [--horizon <slug>]
mc programs show <programme> [--json]
mc programs state <programme> draft|ready
mc programs review <programme>
mc programs after <programme> <phase> <phase>… | --none
```

`after` states what a phase of a stated programme waits for (the first number
is the phase that waits) and replaces what it waited for; `--none` removes it.
It writes only `phases`, through the record's module, refuses a cycle and a
programme that is not stated or whose record is invalid (exit 1), and a
malformed call or a caller not allowed (exit 2); the person, the interactive
Martin role, the manager and the plan role may call it, the last two also
unattended. Its form and refusals are in [mc-goals.md](mc-goals.md#stated-order).

`create` makes `~/mc/programs/<programme>/` with `PROGRAMME.json` (state
`draft`, an area repair included, created now), `README.md` from its template, and empty `goals/`
and `evidence/` — no `proposals/`: a programme is an order, and proposals wait in the areas
([mc-layout.md](mc-layout.md)) — so `mc goal new <programme>/<goal>`
is available once Martin sets the programme `ready`. It refuses a name that exists (exit 1) and, when the page
template cannot be read, makes nothing. `record` gives an existing directory
without a record its record and touches nothing else; it refuses a directory
that is missing or already has a record (exit 1). Both refuse a bad name, a
blank `--end`, a blank `--purpose`, a horizon that is not a slug, an `--area` that is
not `<repo>/<id>`, `--horizon` together with `--area`, and `--from-proposal`
without `--area` with exit 2, before any write; `record` takes none of `--area`,
`--purpose` and `--from-proposal`. `--purpose` is written under What it is for
in the page. `--area` is refused (exit 1) when the repository is not known, does
not declare the area at its origin/main, or a valid open record already names it.
`--from-proposal <path>` names a file directly in an area's
`~/mc/areas/<repo>/<area>/proposals/` (anything else, an archived one included,
is refused with exit 1 before anything is made, and so is one whose name is taken
in that area's `proposals/archive/`). A source already ordered returns the owning
programme before making a new one. The new `README.md` names its archived path
first under Where things are (`Ordered from the proposal \`<path>\`.`); after the
programme is made the proposal is moved to `proposals/archive/` of its area with
the first line `Utfall: ordered in programme <programme>`, and one that cannot be
moved is said with exit 1 after the programme exists.
`show` prints the record (`--json`: `{ "name", "record" }`, where `record` is
`null` without one; for a stated programme it also prints `phases: stated` and
a line `phase <n> after phase <m>[, <m>…]` per waiting phase) or says the programme has none; a record that does not
validate is printed as its problems with exit 1, a programme with no directory
exits 1, and a word that is not a programme name exits 2.

Who may write is decided from the environment alone: `MC_ROLE` through
`normalizeSessionRole`, else `MC_GOAL` alone is a build session, else a person.
Only a person and the interactive Martin role may create and record, and
`created_by` says which (`person`, `martin`); every headless role, the manager
included, is refused (exit 2). The page is
written before the record, so the runner never offers a programme whose page
is not whole. Every other role
and a build session get exit 2 with the role named; the Martin role with
`MC_HEADLESS=1` is refused too. A role added later is refused until it is
named. `show` and `list` have no guard. The pre-tool hook refuses a direct
write of the file (`programme-file`, [mc-hooks.md](mc-hooks.md)).

### Programme state and advisory reading

`mc programs state <programme> draft|ready` is available only to interactive Martin:
exactly `MC_ROLE=martin` and `MC_HEADLESS` not `1`. Every other caller exits 2
before effects. For ordinary desk orders it sets `draft` or `ready` without
condition on the document, directory or any reading. For repair orders see
[release](#repair-drafts) and [desk takeover](#repair-scope-stops-and-dispositions).
Setting `ready` also releases the holds the desk placed
(`by: martin`, not a creation hold) on the programme's unfinished goals, each with the log
entry `mc goal release` writes and a line `<programme>/<goal> released (held since <at>: <reason>)`;
setting the order ready is Martin's word that its work goes on. Any other hold is kept and named,
`<programme>/<goal> still held by <by> — mc goal release <programme>/<goal> frees it`. Setting
`draft` releases nothing.

`mc programs review <programme>` is an in-session call, not a runner lane or scheduled turn.
For desk orders the reading is advice: Martin's interactive session calls it when he wants, it writes its report
beside the programme as `PROGRAMME-REVIEW.md`, and no code reads the report: it gates
nothing in mc, is bound to no version of the text and never goes stale.
It records no verdict or currency. [Repair-owned drafts](#repair-drafts) use
the same command with a fixed snapshot and a receipt required for release.
The desk keeps the order in draft while
working through each part's user outcome and design with Martin. The desk
settles the technical solution, its supporting investigations and how to check
the result, then reviews the current text. The desk fixes review findings on
procedure and setup, works through changes to an agreed outcome or design with
Martin and reviews again if what a part delivers changes. Once the findings
are settled, Martin decides whether the whole order is ready. The desk records
his decision using `state ready` (see `canon/tasks/writing-a-programme-document.md`).
The child has MC_ROLE=programme-review, MC_PROGRAMME and its own
MC_PROGRAMME_REVIEW_TOKEN.
The reader writes PROGRAMME-REVIEW.md with line one `findings: <n>`, then findings naming
part/entry/narrowest fix. Paid sessions retain the existing run-row accounting.

`mc programs list` and the page's PROGRAMMES read the directory names that
hold a `PROGRAMME.json`, valid or not, so a recorded programme is listed (and
counted as dormant) before its first goal. `--json` adds a `record` key to
each programme: `null`, `{ horizon, end, state, created, created_by }` or
`{ problems }`, and `phases` inside `record` as the record holds it. The text line gains a last cell, `record ready · horizon <slug>`
(`no horizon` without one) or `record invalid`; a programme without a record
keeps its seven cells.

The complete record template is the first markdown fence of
`canon/tasks/references/programme-document.md`; area repairs use the unchanged
short template in `repair-page.md`. The older recordless page is
`programme-readme.md`. `create` fills name, end, horizon/area and purpose.
the no-record page only when no README exists. `mc programs show` prints the
`area` line and `--json` the key.

### Repair drafts

The draft is a full programme document with affected repositories, three to
eight numbered parts, observable acceptance and original source pointers in
Where things are. The draft writer rejects an order outside that part range
before writing it.
The validated record carries `repair.sources`: absolute source references
(`kind`, `path`), logical keys and SHA-256 evidence digests. Fingerprint
identity includes the repository, not the date or intake path; the evidence
digest covers the selected fingerprint row. Proposal archive moves preserve
proposal identity. Explicit source links and corroborating incident or
fingerprint evidence join one order; a shared incident without that
corroboration is not enough. An ordinary desk order can be found by its
proposal archive outcome or its original README pointer if the move failed.
The desk and repair entrances check proposal ownership and write their orders
under the same strict runner lock. An owned source returns the existing
order; an ambiguous match leaves the proposal available.

Input files over 128 KiB are unreadable to repair. `mc repair --error`
accepts only dated collector digests in intake or a dated intake archive
directory. It selects rows from the repository's fingerprint table
(`Error fingerprints` for memoro or `mc itself — this machine` for memoro-cli).
The analysis summary and new-error list are outside that table.

Feedback and collected errors reuse a corroborated proposal if one already
exists; otherwise they get one in the appropriate area before drafting.
Feedback uses the original task ID or a labelled
incident timestamp and build. Only minimum defect details and provenance are
copied. Waiting sources stay in their area while a draft exists. Resolved
sources archive their proposals with `Utfall: resolved — <where>`. If the
original archive name already holds a disposition for other evidence, the
resolution gets a separate archive file and the waiting path points to the
latest resolution once the waiting file has moved. An explicit archive path
still reads its own version. An unestablished or ambiguous report keeps its
proposal and a reason in `runner/repair-draft/`. Decline and resolution apply
across corroborated routes to the same evidence version, not to changed
evidence for the same fingerprint. A matching archive disposition is reported
before using defect ownership to resume or point to an order for other
evidence. The same recorded source key and evidence digest on waiting and
archived proposals corroborate the version for its archived disposition,
even when a collector file has moved or been replaced and no longer lists
the original fingerprint. This does not establish general order ownership.
A collector link alone can corroborate defect identity but not the archived
evidence version: today's row is not proof of the archived one. An
identity-only legacy link without a provable version is ambiguous and repair
makes no order. A recorded digest for a different row does not close the
selected row or let it consume a waiting proposal pinned to the other row.
A legacy feedback link can still corroborate a report with the
same original incident. Repair checks ownership and rechecks the selected
evidence in the strict programme lock; it does not hold the lock while the
role reads. Changed evidence or concurrent order changes cannot be committed
from a stale reading.

Ordinary `state` is not a release or a resume of an order still owned by repair.
`mc plan` and `mc goal new` refuse its draft and a stale ready order (exit 1).
Ordinary desk-created area repairs keep their existing route.

For a repair-owned draft, programme review requires the live entrance's
programme-bound repair identity on both claim and receipt write. The reader
must use a different tool/model pair. A new authorised attempt revokes the
previous receipt before inspecting the order or looking for a reader. The
reader sees a disposable snapshot of README and the programme-local files
linked or named in backticks under `evidence/`, `design/` or `designs/`. An additional
programme-local input can be named as `Binding design:` or `Binding evidence:`
followed by its backticked path on the same line. Binding files must be regular
files reached without symlinks; the snapshot is limited to 64 MiB total.
Source provenance pointers to proposals or intake files are not binding inputs.
An isolated, successful reader must write a fresh findings report (up to
64 KiB) with numbered findings, their part, entry, evidence and narrowest fix,
and a Not checked section. The wrapper compares the live inputs again before
storing the report and its receipt with the manifest and report digests. An
input change during the reading, failed reader, invalid report or superseded
attempt stores no usable receipt. A report alone grants no authority. The
ordinary desk reading remains advisory.

The assigned repair author releases with `mc programs release <programme>`.
It requires a receipt on the current manifest with no outstanding findings.
Making a correction or recording a reasoned answer under Read changes the
README: the new version must be read before release. The command commits a
new revision and its manifest under the programme lock. It does not take an
ordinary programme or trust a ready spelling without the current manifest.
A stale ready record keeps that spelling on disk and says `ready (needs
review)` in the terminal list. An authorised reopen changes it to draft and
revokes the receipt without removing sources, goals or the previous cut. The entrance
runs at most three independent readings per invocation. Each revision can
replace up to 16 exact lines in numbered parts. The editable fields are
Closes, Solution, Design, Proved by and Not in this part. The entrance
records the evidence for the revision's answers under Read.
A technical uncertainty retains the draft and its proposals for evidence.

A draft binds a programme-local summary of the checked defect and source
digests in addition to its order. Release records the ordered proposal
versions in their area's archive. A failed archive move leaves the release
in place with a resumable source operation. A private copy holds the exact
proposal version until archival succeeds, so a retry can archive what was
ordered while retaining any newer waiting evidence. Moving original intake
or proposal pointers does not change the released manifest.

Once reconciled, delivery writes are for that revision. A stale session keeps
its local work but cannot register a PR, publish a handoff or move a goal
forward under a new release. Goal review records the released revision and
the authorized PR heads before queueing. A later release requires a new
handoff even for a goal the planner keeps unchanged; see
[merge admission](mc-merge.md#repair-owned-work).

### Repair scope stops and dispositions

Repair can release a restoration of settled behaviour. When the written
standards leave the behaviour open, repository evidence of the app's
established pattern can establish what a repair restores. An order that needs
a new user-visible design decision or a change to a text Martin holds must
stop at the desk before release.

The assigned author records a scope stop with `mc programs repair-stop
<programme> --title <text> --summary <text> [--item <id>]`. The record moves
to `Martin` under the programme lock and loses its review receipt. It keeps
its source links and last reconciliation. The stop records the Swedish scope
summary, the goals already done, and, when necessary, a link to an existing
held-text or reserved-act item. The terminal
[desk](mc-martin.md#repair-scope-stops) can recover the stop from the
programme record even if the item write was interrupted. No part of delivery
may use the stopped record, even if it already has a runnable goal or queued PR.

The repair entrance persists a known scope stop with the draft, or when a
revision reading identifies it, before publishing any related desk brief.
While that decision is pending, review and release refuse. Resume completes
the pending stop without another reading. A related brief that is malformed
or no longer open cannot keep the scope stop from reaching the desk. The
entrance reports the missing link and still records the stop for disposition.
The move to Martin replaces the
pending decision with the durable stop.

Only interactive Martin records a disposition. `return` puts the order back
in repair draft with the narrowing in the disposition and with sources and
goals retained. It needs a new reading, release and reconciliation. `takeover`
puts it back in desk draft: the desk may run ordinary advisory review and
prepare the goal contracts using the goal verbs. Takeover records contracts
left by an interrupted cut before the desk starts those edits. The desk's
`mc programs state <programme> ready` validates coverage and reconciles the contracts
with the new manifest in one write. Superseded work is not delivered; a reused
goal must qualify against the new release and obtain a fresh merge handoff.
This does not change the ready command for programmes without repair provenance.

`decline` retires unfinished goals and records a declined source outcome for
the evidenced version. It does not remove local worktrees in the disposition:
ordinary dropped-goal cleanup proves that it may close PRs and remove trees.
An in-flight merge prevents recording decline until its outcome is known.
If a landed PR belongs to a retired goal, that goal stays retired but its
landed work is included in the reading. A recorded decline interrupted by a
retirement or source move must be retried with the same action and reason.
With landed work the record is ready for write-back only, under the decline's
own revision. Without landed work it is done without a write-back. Decline
cannot open a planning or delivery turn.

## What the session is told

`planLaunch` names the programme, asks it to read the aim first, names the
checkouts and their branches, and waits for Martin. In layout 2 it names the
goals beside them and `mc goal` as their writer. A `goal/<goal>` branch
belongs to that goal's worktree; a planning branch is `plan/<slug>`.
The prompt predicts no deliverable, pull request or landing route.

### Resume selection and provenance

`openInWorkArea` discovers conversations from the tools' native stores under
its area root. In layout 2 that includes descendant goal worktrees: newest
same-tool conversation alone is **not** a safe plan-session selection.
For a role-aware entrance (including `mc plan`), automatic selection walks
newest first within the requested tool and resumes only positive evidence of
the same normalized role **and** programme. `plan` and `plan-session` are the
same identity; `brief` and `manager` share the existing identity alias too.
Cwd, labels, user messages, and the environment for the new launch do not
prove a historical conversation's authority. A compatible older plan can win
over a newer descendant review. Unscoped ordinary work-area opens retain
their existing selection; they do not establish role provenance.

Skipped candidates are explained on stderr. With no compatible conversation,
the opener starts fresh with the requested role instructions and opening
prompt. `--new` always starts fresh. `mc plan <programme> --resume` offers a numbered
list of compatible conversations from both tools (filtered by an explicit
`--codex` or `--claude`). `--resume <id>` selects an ID or unique prefix.
An explicit resume never falls back to a new conversation; a missing or
ambiguous ID fails and cancellation opens nothing. An explicitly selected incompatible or
unknown conversation is refused, with a fresh-session route (`mc plan
<programme> --new` for planning); it is not silently replaced by another id.
A named id still selects its own tool; tool/model flags retain their existing
precedence. Compatible continuation has no introductory user message.

Evidence is deliberately bounded, and missing evidence means **unknown**.
Codex identity reads have a separate 1 MiB bound because native tool schemas
can push the first developer message beyond the 64 KiB used for labels:


- **Codex:** the first 1 MiB of the native rollout must contain mc's
  versioned role/programme launch marker in a `response_item` developer
  message or a `turn_context.developer_instructions` field. A marker in user
  text, a cwd or a label is ignored. Conflicting markers are unknown.
- **Claude:** native transcripts do not prove the appended system prompt.
  A fresh role-aware launch supplies a UUID through `--session-id` and records
  it, cwd, role, programme and instruction channel in the existing `work.open`
  log. A launch's process can leave a conversation under a new id that no
  `--session-id` named — a resume, or `/clear` inside the session. The
  foreground launch's `work.closed` names it as `started`; the `work.open` of
  the same `run` and `pid` is then that conversation's evidence, under the same
  cwd and channel conditions. Selection reads at most the last 4 MiB of the current mc log and its
  single rotated predecessor, once per selection, for a matching instructed
  launch. Missing, incomplete, conflicting or rotated-away evidence is
  unknown. This is not a new conversation registry: discovery and ids still
  come from Claude's store, not the log.

Legacy histories without that evidence start fresh even if their opening
words claim the right role. No history is rewritten or migrated. Bounds can
also conservatively reject a genuine compatible history. SessionStart's cwd
role hint is not historical instruction provenance.

### Instruction channel

Instructions are `all-sessions.md` plus the `plan-session` overlay, assembled
by `instructionsFor`. Role-aware launches use Claude's
`--append-system-prompt` and Codex's `-c developer_instructions=<JSON string>`;
the latter carries the launch marker beside the instructions. They are native
instruction configuration, supplied on fresh launches **and compatible
resumes**, not ordinary resume text purporting to override historical
developer instructions. The older `-c instructions=` path elsewhere is not
accepted as plan provenance. In particular, Claude's system configuration is
reapplied rather than assumed to live in its transcript. The isolated tests
verify discovery and launch composition, not a paid provider turn.

Launches set `MC_ROLE=plan` (the shared identity also accepts `plan-session`)
and `MC_PROGRAMME`, clearing inherited goal/step/headless identity as before.
Decision logs record requested and identified role/programme, evidence source,
conversation id and resume/exclude/fresh/refusal, without copying transcript
or prompt content. Session ownership and headless restrictions are unchanged.

The plan session owns the coherent programme README/design, prerequisite investigation/decisions, phases, complete goal briefs and executable checks; a finished brief moves to build once its acceptance procedure and setup are verified. It may also investigate,
write goals, build and land work itself, or take over a goal's branch when
that costs less than a new build session. This broad freedom belongs to interactive planning with Martin at the terminal. The runner may complete one next draft under [the programme trigger](mc-goals.md#next-draft-planning) (Martin, 2026-11-09);
a goal in `finish` gets a finish session and a red merge a mend session (a
merge failure only; a `blocked` goal before merge is Martin's), each with its own role ([mc-goals.md](mc-goals.md) § *Finish
and mend*).
See [mc-goals.md](mc-goals.md).

## Writing goals

`goal-verb.md`, included by the role, describes the verbs. The goal carries
the goal's numbered parts, its documents and its criteria with their checks.
Stages move forward; `ready` or `blocked` is a separate status. Phases order
work across the programme: in a sequential programme all goals of a lower phase
finish or are dropped before any goal in a higher phase starts; in one whose
record states its phases a phase starts when the phases it is stated to wait
for have finished, and the others run side by side. Build sessions neither rewrite the
brief nor invent another unit inside it. How a programme is designed before
its goals — its README (`canon/tasks/references/programme-readme.md`), the
decisions put to Martin in one sitting, the cut into phases, and every
verified goal set in `build`, and a consumer awaiting its producer kept in draft — is
`canon/tasks/designing-a-programme.md` (Martin, 2026-11-08).

A plan session writes a review or build follow-up as a goal without asking
Martin when its investigation is complete and its change applies a decided
standard (a `docs/technical/` document or a programme ruling) or repairs a
defect against one (Martin, 2026-11-08). What it still asks him is what `canon/tasks/asking-martin.md` names, through
`mc ask` as that page says (`mc goal martin` is gone). The
reason: plan sessions put "write this goal now" questions to jev, which could
not settle them (on 2026-11-08, 67 jev calls showed `settled` below 0.70 on 20
such questions).

A goal names a work class (`fast`, `medium` or `large`), not a pinned provider; the
class routes its build sessions only. The catalog and observed capacity choose
tool, model and effort at launch. Review, finish, mend, the runner's plan and
the unattended manager each have their own catalog list, whatever the class,
changed with `mc model add|remove <list>` or `mc model set <list>`; this is
`mc model add|remove review` and `mc model set review` for review.

Review ranks usable subscriptions by provider priority, then headroom; ties avoid the build model, then follow catalog order.

The catalog's first review candidate is read first whenever it can run; the author's removal from the list never promotes another candidate to first choice, so with the first candidate being the author the ranking above chooses among the rest.

## Archiving a programme

`mc plan <programme> --archive` is a person's act, or the interactive Martin
role's on his word at the desk (no other session and no headless role may call
it), and the only way to archive a programme without a record. The runner archives finished goals, and it archives
the programme above them only when the programme has a valid record: once every
goal is done or dropped, a write-back reading is OK and no restricted data is
held, it calls the same `archiveProgramme` itself and sets the record's `state`
to `done` ([mc-run.md](mc-run.md#programme-archive-turn)). `archiveProgramme`
(`src/mc/archive-programme.js`) refuses any goal not done or dropped and
anything the planning area's release forecast would keep, and any entry under
`~/mc/restricted/<programme>/` without a README.md. It checks before changing
anything.

In each repository that holds `docs/project/<programme>/`, archive retains
files that code or tests still read. It removes the other files and adds a
`closed` row for the programme in `project_log.md` in a docs-only pull
request. If all files are kept, there is nothing to remove and no row or PR
is created. An existing archive PR is reused. Only after those
PRs land are the planning worktrees released. In layout 2
`~/mc/restricted/<programme>/` is then removed, each entry's README.md first
copied to the programme's `evidence/<entry>/RESTRICTED-README.md`
([mc-layout.md § Data outside the repositories](mc-layout.md#data-outside-the-repositories)),
and the programme's directory is moved whole to `~/mc/archive/programs/<programme>/` (a dated
name if needed); its remaining documents are not deleted. Before the move the shared
writer records a versioned receipt of retained repository trees, their repository
identity, tracked paths and inspected main commits in the programme directory.
It takes the tree from the archive merge commit or, when every file is kept,
from the main commit inspected for that decision.
The rename carries that receipt to the shelf; older shelves need not have one.
A failure to land the repository change leaves the planning area intact so
a later attempt can continue. A failed receipt fetch leaves that repository's
membership unproven.

`--archive` refuses session-selection flags and requires an explicit name.
No-record programmes are not automatically archived or migrated. The manual
command can archive one after work and write-back without declaring its enduring
direction over. For a valid record, the runner checks its end and safety as
above; the manual command also archives it, leaving `state` as it finds it and
moving the directory whole.
No programme gets a `proposals/` any more. For a programme made before, the
runner's archive first moves its top-level `proposals/*.md` to an area's
`proposals/` — the page-area its record's `area` names, else `memoro-cli/system`
— each under a first line naming the programme, so a finding is not shelved with
the programme.

## How it is tested

`tests/mc/commands/plan.test.js` covers the paths, refusal inside a session,
programme picker, prompt, role body and the real discovery/launcher composition
for fresh, compatible resume and `--new`, with provider spawn replaced.
It also covers `a new programme gets its README from the programme template`
and `an existing README is left as it is`.
`tests/mc/work-open.test.js` uses isolated Codex rollouts and Claude stores
and launch evidence for descendant review, wrong programme, unknown identity,
explicit refusal, aliases and compatible continuation.
`tests/mc/archive-programme.test.js` covers archive refusals and ordering.

## Acceptance preparation before build

Programme review assesses each part's proposed acceptance procedure for an
observable failure, exercise of the promised behaviour and named workspace,
dependencies and usable inputs. It uses the existing read-only exports and
permitted checks; missing evidence is a finding, not a pass. For unbuilt
functionality it assesses the procedure and prerequisites, not a final result.
The desk corrects findings in the order before release.

The programme planning turn promotes directly only on evidence naming the
current check, required capability in the intended checkout and usable named
input. Unrelated main movement does not invalidate those premises. Missing
evidence or a changed check or relevant premise leaves a draft for next-draft
planning, even without a producer. A consumer requiring a producer stays draft
in a dependent phase; an open phase, including after a dropped producer, is not
evidence of output. Planning verifies the procedure and setup against the
checkout build will receive, accounting for the [unbuilt-branch
refresh](mc-goals.md#the-verbs) on promotion and the first build. In the
next-draft worktree, fetch first, fast-forward an unbuilt branch to the fetched
base, and verify there. On a branch with its own commits, verify the branch
the refresh will retain. Do not discard work or promote on unverified setup.
Before promotion, fetch again and confirm that the named premises still hold
against the source of the branch refresh. Reverify on the updated setup if a
named premise changed; unrelated main movement does not invalidate the evidence.
If either fetch or a required fast-forward fails, or planning cannot establish
what setup build will receive, leave the goal in draft and log why.

A sound check missing its input in an open phase is logged and left draft and
ready, with the blocking input and technical desk action in `mc goal log
--next`. The existing incomplete-session handoff keeps that Next visible; the
desk returns the draft when the input is verifiably available. A wrong setup
premise is reported by `mc goal defect` in
draft; the desk verifies the change before returning it to planning. Changes to
the programme promise go to the desk. This adds no runner admission service or
separate review. The report and goal log carry the evidence.
