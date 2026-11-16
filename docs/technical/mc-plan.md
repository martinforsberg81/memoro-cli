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

A programme may have a record, `PROGRAMME.json` directly in its directory
(`src/mc/programme-record.js`): a bounded piece of work serving a horizon, or storage for small area work
without one. A programme without the file is also bounded. Version 2 has the
following keys; `area`, `phases` and `legacy` are optional, and no others are accepted:

| key | value |
|---|---|
| `schema` | `"mc-programme"` |
| `version` | `2` (version 1 remains readable) |
| `horizon` | the slug of the horizon served, or `null` |
| `area` | optional: `<repo>/<id>`, an area a repository declares; allowed only with `horizon` `null` |
| `end` | one non-empty sentence saying when the programme is done |
| `state` | `draft`, `open`, `done` or `dropped` |
| `created` | an ISO instant in UTC to the second |
| `created_by` | `person`, `martin` or `manager` |
| `signed_at` | ISO instant in UTC, or `null` |
| `signed_by` | `"martin"`, or `null` |
| `signed_text` | sha256 hex digest of `SIGNED.md`, or `null` |
| `cut_text` | signature consumed by the last complete goal cut, or `null` |
| `legacy` | optional boolean; `true` exempts an existing record from sign-off |
| `phases` | optional: `{"order": "stated"}` with, when a phase waits, `"after": {"3": [1, 2]}` |

`draft` means the document is being written or waiting for sign-off; `open`
means goals may be cut and built; `done` means archived; `dropped` means the
draft was declined. The three `signed_*` keys are null in draft/dropped and
set together in open/done. Area repairs and `legacy: true` records may instead
have all three null in open/done; a partial signature is never valid. `cut_text`
may stay set after a return. Every new record is draft, with or without a
horizon and for every author, except an area repair, which is open and unsigned.

Reading a version 1 open/done record normalizes it in memory to version 2,
`legacy: true` and four null signature/cut keys. It does not change disk bytes
or state. Only an actual write persists that upgrade; a no-op phase/state call
does not migrate. `writeRecord` remains create-only even for old input. Old
processes reject version 2 records as invalid, not understand their sign-off
semantics; use normal installed-code/runner handover before relying on new
gates. In particular an old goal-new caller has no new sign-off guard.

The record module's transition writers take the strict runner lock around a
fresh read and replacement: `signRecord` requires draft, reads README, runs
the caller's structure/current-reading check on those exact bytes, appends a
`## Signed designs` block listing every nested design file with sha256, writes
`SIGNED.md`, then opens the record with Martin/time and the signed-copy hash,
removing legacy. It retains phases and cut_text. A failed check/validation
writes neither file. `returnRecord` requires open, nulls signed_* and keeps
cut_text and the old signed copy until a re-sign replaces it. `dropRecord`
requires draft and records dropped, without moving or deleting any material;
reason logging and shelving belong to the command. Neither writer invents a
reading or grants caller authority.

A record cannot name both a horizon and an area. An area carrier is existing
storage for one small goal without a horizon, not an extra product planning
level. Small work includes a single fix; a user-promise change needs a horizon.
The create guard refuses a second open carrier for an identified area and goal
creation refuses a second live goal in it. Other work waits oldest first. If no
area can responsibly be assigned, say unassigned; no global guard covers it.

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
a programme with a valid `open` record, a `README.md` and no goal gets one
headless planning turn that cuts its phases and goals inside the page's End
([mc-run.md](mc-run.md#programme-planning-turn)). A programme with no record, or
with an invalid one, is never started that way; `mc plan` stays the person's
entrance.

The slug is not checked against the desk's horizons: mc stores what it is
given. Its reader says `none`, `valid` or `invalid` with the problems; a
record is validated before every write. Creation never replaces a file that
is there (a temporary file linked into place). All existing-record writers (phase, state, sign, return and drop)
take the shared runner lock with `strict: true` around a fresh read, validation
and atomic replacement, retaining the other fields. They refuse rather than
write without that lock; archive destination bookkeeping takes its own lock
separately, never wrapping the record writer in a nested acquisition.
`state` is read by the programme
planning turn and the manager's horizon turn (a turn starts only for `open`),
and by the archive turn, and the list and the page show it. Only the runner
sets it to `done` (`setRecordState`), once it has archived the programme
([mc-run.md](mc-run.md#programme-archive-turn)); `mc plan <programme> --archive`
archives a programme of either kind, as in
[Archiving a programme](#archiving-a-programme), and leaves `state` as it finds it.

```
mc programs create <programme> --end "…" [--horizon <slug> | --area <repo>/<id>] [--purpose "…"] [--from-proposal <path>]
mc programs record <programme> --end "…" [--horizon <slug>]
mc programs show <programme> [--json]
mc programs sign <programme> [--reason "…"]
mc programs return <programme> --reason "…"
mc programs drop <programme> --reason "…"
mc programs model
mc programs review <programme>
mc programs review <programme> verdict ok|not-ok
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
`draft` (or `open` for an area repair), created now), `README.md` from its template, and empty `goals/`,
`proposals/archive/` and `evidence/`, so `mc goal new <programme>/<goal>`
is available after sign-off (immediately for an area repair). It refuses a name that exists (exit 1) and, when the page
template cannot be read, makes nothing. `record` gives an existing directory
without a record its record and touches nothing else; it refuses a directory
that is missing or already has a record (exit 1). Both refuse a bad name, a
blank `--end`, a blank `--purpose`, a horizon that is not a slug, an `--area` that is
not `<repo>/<id>`, `--horizon` together with `--area`, and `--from-proposal`
without `--area` with exit 2, before any write; `record` takes none of `--area`,
`--purpose` and `--from-proposal`. `--purpose` is written under What it is for
in the page. `--area` is refused (exit 1) when the repository is not known, does
not declare the area at its origin/main, or a valid open record already names it.
`--from-proposal <path>` names a file in `~/mc/proposals/` or a programme's
`proposals/`; after the programme is made it is moved into the new programme's
`proposals/` with a line saying where it came from, and one that cannot be moved
is said with exit 1 after the programme exists.
`show` prints the record (`--json`: `{ "name", "record" }`, where `record` is
`null` without one; for a stated programme it also prints `phases: stated` and
a line `phase <n> after phase <m>[, <m>…]` per waiting phase) or says the programme has none; a record that does not
validate is printed as its problems with exit 1, a programme with no directory
exits 1, and a word that is not a programme name exits 2.

Who may write is decided from the environment alone: `MC_ROLE` through
`normalizeSessionRole`, else `MC_GOAL` alone is a build session, else a person.
A person, the interactive Martin role and the manager may create and record,
and `created_by` says which (`person`, `martin`, `manager`). The manager
differs in three ways ([mc-manager.md](mc-manager.md)): `create` needs `--purpose`
and exactly one of `--horizon` and `--area`; a `--horizon` must be open and have
no valid open record naming it; and `record` is refused to it. The page is
written before the record, so the runner never offers a programme whose page
is not whole. Every other role
and a build session get exit 2 with the role named; the Martin role with
`MC_HEADLESS=1` is refused too. A role added later is refused until it is
named. `show` and `list` have no guard. The pre-tool hook refuses a direct
write of the file (`programme-file`, [mc-hooks.md](mc-hooks.md)).

### Sign-off and independent programme reading

`sign` is interactive-Martin-only: exactly `MC_ROLE=martin` and
`MC_HEADLESS` not `1`. Every other caller, including a bare shell, exits 2
with `mc: only Martin at the desk signs a programme`, before effects. A bad
request also exits 2. It exits 1 unless the record is draft, the complete
[document structure](../../canon/tasks/references/programme-document.md) is present, and an independent
reading judges the exact current README bytes. Each structural refusal names
its heading/entry/Repositories line; this is not a prose-quality judgement.
No reading or a stale reading refuses even with `--reason`, naming
`mc programs review <programme>`. Current NOT OK needs nonempty `--reason`;
current OK does not. A successful sign prints `<programme>: signed — goals may
be cut` and appends Martin/time and any override reason to programme LOG.md.
The record writer checks the current reading inside its strict lock before
writing either sign-off file; normal record writes retain their other fields.

`return <programme> --reason "…"` is available only to interactive Martin or
`MC_ROLE=plan` with that exact `MC_PROGRAMME` and no `MC_GOAL` (the programme
planning turn, not a goal session). It requires open, clears signed_* but
retains cut_text and SIGNED.md, appends time/role/reason to RETURNED.md, and
prints `<programme>: returned to draft — <reason>`. `drop` is interactive
Martin only and requires draft. It writes dropped and appends the reason,
then uses the archive's collision-avoiding whole-directory shelving into
`archive/programs/<programme>` (then `-2`, `-3`, …). It does not release a
worktree or hold, delete restricted data, move proposals separately, or
remove dirty/unpushed material: the complete directory is retained. A failed
move reports the retained location and leaves the dropped record/reason in
place. Malformed/unauthorized calls exit 2 without effects; wrong state or a
failed write/move exits 1. No sign-off desk item is created by either verb.

`model` prints the SIGNED.md path with the latest signed_at among valid live
and archived records that still have that file; legacy unsigned copies do
not qualify. No signature exits 1 with `mc: no programme document is signed
yet`. `show` and list expose signature time/author and legacy (`legacy: not
signed`); their record JSON includes the signature/cut keys. For a signed
record they compare the complete current designs inventory with the signed
hash block: changed, new or removed files print `designs changed since
sign-off` (JSON `designs_changed`). Reads never update a record or signature.

`review` is an in-session call, not a runner lane or scheduled turn. A manager,
interactive desk, interactive programme plan without MC_GOAL, or a person can
call it; other roles and headless Martin/plan are refused (2) before effects.
The Repositories line names known repository names (comma/space separated,
optional terminal full stop); unknown names or no entries refuse (2), never
turning document text into arbitrary filesystem paths. Read exports are the
existing `git archive origin/main` mechanism, without repository metadata.
Cleanup proves the owned export directory's device/inode/birthtime and retains
and reports a replacement directory or symlink rather than deleting it.

`src/mc/plan-review.js` shares reader selection, adapter/capability and billing
routing, token/launch mechanics, session launch and report/verdict checks with
goal plan review. It removes the caller's tool/model from the review catalogue
when another can run (the catalogue first retains priority only if still
present), with the same capacity/API-reserve and fallback rules. No provider
command or extra routing policy is added. Goal plan review retains its
20-minute/two-reading policy and draft-to-build gate. Programme review has a
30-minute timeout and no reading cap, including a third call on the same text.

The child has MC_ROLE=programme-review, MC_PROGRAMME and its own
MC_PROGRAMME_REVIEW_TOKEN, not the caller's goal/session/review identity. The
one in-flight `.programme-review-launch.json` holds only the token's sha256,
programme/role, README hash, caller model and pid/start. Its verdict verb accepts
only this role/programme/token while the launch is live; it rejects changed
README bytes, an earlier report, conflicting verdict or missing findings count.
The reader writes PROGRAMME-REVIEW.md with line one OK or NOT OK, line two
`findings: <n>`, then findings naming part/entry/narrowest fix. The verdict binds
the report hash too. On completion a strict-lock fresh-text check writes
`.programme-review.json`: verdict, judged README sha256 (`hash`), ISO time
(`at`), findings count, report sha256, tool/model and author. The report and
metadata must still agree for sign to accept the current reading. No raw token
is persisted. Calls print verdict/path and exit 0 for OK, 1 for NOT OK, 2 for
refusal, timeout or no valid verdict (including changed judged files). Launch
bookkeeping is removed; paid sessions retain the existing run-row accounting.
Only report/metadata persist as the reading; no sign-off desk item is made here.
The role's eight questions are owned by `canon/roles/programme-review.md`.
It is a reader, with no goal mutation, sign-off or mc ask authority.

`mc programs list` and the page's PROGRAMMES read the directory names that
hold a `PROGRAMME.json`, valid or not, so a recorded programme is listed (and
counted as dormant) before its first goal. `--json` adds a `record` key to
each programme: `null`, `{ horizon, end, state, created, created_by }` or
`{ problems }`, and `phases` inside `record` as the record holds it. The text line gains a last cell, `record open · horizon <slug>`
(`no horizon` without one) or `record invalid`; a programme without a record
keeps its seven cells.

The complete record template is the first markdown fence of
`canon/tasks/references/programme-document.md`; area repairs use the unchanged
short template in `repair-page.md`. The older recordless page is
`programme-readme.md`. `create` fills name, end, horizon/area and purpose.
The document reference owns the eleven ordered nonempty entries and five
ordered label-start entries of every numbered part. `documentProblems` checks
title/scope/Repositories, headings, part presence and labels, ignoring fenced
examples, never prose or design quality. Labels may continue freely on their
first line and in paragraphs/lists. Decisions is optional; sessions keep
working decisions in README, not the signed copy. A new draft copies the
model's form, never content. `mc plan` writes
the no-record page only when no README exists. `mc programs show` prints the
`area` line and `--json` the key.

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

The plan session owns the coherent programme README/design, prerequisite investigation/decisions, phases, complete goal briefs and executable checks; every finished brief moves to build in its assigned phase. It may also investigate,
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
finished goal set in `build` in its phase rather than parked in `draft` — is
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

`mc plan <programme> --archive` is a person's act, and the only way to archive a
programme without a record. The runner archives finished goals, and it archives
the programme above them only when the programme has a valid record: once every
goal is done or dropped, a write-back reading is OK and no restricted data is
held, it calls the same `archiveProgramme` itself and sets the record's `state`
to `done` ([mc-run.md](mc-run.md#programme-archive-turn)). `archiveProgramme`
(`src/mc/archive-programme.js`) refuses any goal not done or dropped and
anything the planning area's release forecast would keep, and any entry under
`~/mc/restricted/<programme>/` without a README.md. It checks before changing
anything.

In each repository that holds `docs/project/<programme>/`, it removes that
directory and adds a `closed` row for the programme in `project_log.md`, in a
docs-only pull request. An existing archive PR is reused. Only after those
PRs land are the planning worktrees released. In layout 2
`~/mc/restricted/<programme>/` is then removed, each entry's README.md first
copied to the programme's `evidence/<entry>/RESTRICTED-README.md`
([mc-layout.md § Data outside the repositories](mc-layout.md#data-outside-the-repositories)),
and the programme's directory is moved whole to `~/mc/archive/programs/<programme>/` (a dated
name if needed); its remaining documents are not deleted. A network failure
leaves the planning area intact so a later attempt can continue.

`--archive` refuses session-selection flags and requires an explicit name.
No-record programmes are not automatically archived or migrated. The manual
command can archive one after work and write-back without declaring its enduring
direction over. For a valid record, the runner checks its end and safety as
above; the manual command also archives it, leaving `state` as it finds it and
moving its `proposals/` with the directory, whole.
The runner's archive moves the top-level `proposals/*.md` to `~/mc/proposals/`
first, so a finding is not shelved with the programme.

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
