# mc brief — the evaluation and decision session

`mc brief` is the hour Martin sits down. Everything else in mc runs without
him: the runner takes `ready` steps, opens PRs and merges them, archives what
is done and closes the workarea behind it. None of that asks a question. The
questions pile up anyway — a failed step, a project archived with no note, a
folder under `~/mc` no plan explains, a proposal the helper wrote — and until
they are put to the one person who can answer them, they are invisible.

This verb opens the session Martin puts them to. That is the whole of it: **the
foreground brief session, with the `brief` role, no gathered document and no
opening words.** Martin types the first message and says what he wants help
with — the runner, the proposals, or something else — and the session does
that and nothing more.
Nothing is resident — no daemon, no watcher, no inbox — and the runner does
not know the verb exists. The code is
[`src/mc/commands/brief.js`](../../src/mc/commands/brief.js), which is a
`openInWorkArea` call and the role.

It replaced the resident PM and the pm-helper (`~/mc/mc-utredning/utredning-2026-08-24.md`
§9–13, D-0218).

## What it does not do

Until 2026-09-19 `mc brief` ran `collectBrief` first: it fetched, asked `gh`,
read the plans, the runs and the runner's tables, wrote `~/mc/brief/<date>.md`
and handed the text to the session as its first words — or, to a resumed
session, as a reply. `mc brief --collect` was the same without the session, and
`--offline` kept it off the network. All three are gone (Martin, 2026-09-19:
"Ta bort båda"): `--collect` and `--offline` are unknown flags, exit 2.

The reason is that the document was a second copy of ground that is read live
elsewhere, and stale by the second question. The page (`mc`), `mc status
<name>` and `mc step <project>` carry the same ground now — the runner, the
queue, failed and blocked steps, the intake, the workareas — and the brief
keeps no script of its own to drift from them. The file that held the readers,
[`src/mc/brief-collect.js`](../../src/mc/brief-collect.js), stayed under its
name because a dozen modules import from it; what is left in it is what the page,
the runner, `mc status`, `mc plan` and the helper share: `listPlans`,
`listProgrammes`, `planFields`, `parseRuns`, `runsFor`, `listProposals`,
`defaultRepos` and the batch readers under them.

The five gathered files already in `~/mc/brief/` are left where they are; the
code never reads or deletes that directory. (`~/mc/brief/unblock/` below is
still used.)

## Where the session reads the ground

[`canon/roles/brief.md`](../../canon/roles/brief.md) is a few lines: do what
Martin asks and change nothing he has not asked for; that it may do every part
of the work — write a plan, write or drop a proposal, get a blocked or failed
step moving, fix and land a small problem in the code; and where to read — `mc
--fresh`, `mc status <name>`, `mc step <project>`, `~/mc/proposals/`,
`~/memoro-cli`. It includes `_plan-writing.md`, as `mc plan` does. Everything else a session needs comes from
`canon/roles/_common.md`; the role was cut to that on 2026-09-28 (Martin:
"för lång och babblig").

A file the runner has never written and a file it wrote and left empty are two
answers, and the session is to read them as two: "the runner has not written
one yet" is not "there is nothing to report".

## The session

The verb opens **an ordinary foreground terminal program** — `spawn` with
`stdio: 'inherit'` through `openInWorkArea`
([`src/mc/work-open.js`](../../src/mc/work-open.js)) — not tmux. The brief
session already there is resumed where it was (`pick: null`), with no prompt
of its own, as `mc helper` is; a fresh one starts on `--new`, or when there is
none, with no opening words: Martin types the first message (2026-09-28 —
`Start the meeting.`, from 2026-09-13, sent it walking the whole page and
unblocking steps on its own reading before he had asked for anything; the
resume prompt went 2026-09-19). Opus by default from the role, `--codex`
allowed through the adapter, the Coding Profile appended, then
`canon/roles/_common.md` and the overlay from `canon/roles/brief.md` —
assembled like every other session's ([`mc-roles.md`](mc-roles.md)). NOW says
`brief` for exactly as long as it holds the terminal. A missing role is exit 1.

It stands in `~/mc/brief/`, and not in a repository. Giving it a worktree
would only put a branch under a conversation that must never commit anything.
Not in `~/mc` either, the work root it stood in until 2026-09-28: a session
resumes the newest conversation at or below where it stands, and every
planning, intake and helper session is below the root — so `mc brief` opened
whichever of them had been used last.

## How an answer travels

Into the plan, and nowhere else.

The brief is where Martin and a session agree what to do. What they agree is
written into `docs/project/<programme>/<project>/PLAN.json` — the contract, a
step, or a step's instruction — and setting the stopped step back to `ready` is
what puts the project in front of the runner again. mc records none of it:
there is no file to write, no line to grep for, and no state to keep in step.

That is a deliberate loss of a round trip. The old shape wrote the answer as a
`**Beslut:**` line in a file mc then parsed, retired and deleted, and the parse
was the whole reason the line had a fixed shape. Removing the reader removes
the shape with it.

### When the brief itself is the writer

One case does not wait for whoever next opens the plan. A blocked step the
brief settles by reading, once Martin has asked it to, is answered in the
session that read it, and that
makes the brief a fourth writer beside the step session, the planning session
and the runner ([`docs/project/README.md`](../project/README.md) § *Who writes
what*). It reaches `main` by this route:

- **One pull request per repository per brief**, not one per unblocked step.
  Every unblocking that brief made travels together and reads as one decision.
- A worktree at **`~/mc/brief/unblock/<repo>`**, on branch
  **`brief/unblock-<date>`**, cut from `origin/main`.
- `gh pr create`, then **`mc merge <repo> <pr> --docs`** — a plan is a file
  under `docs/`, so the docs door lands it with no suite at all and refuses by
  GitHub's own file list if anything outside `docs/` crept in
  ([`mc-merge.md`](mc-merge.md)). Landed before the brief ends, and the
  worktree removed after: an open pull request on a project's plan keeps that
  project out of the runner's picks until it lands.

Both names are load-bearing and neither is decoration, and both were checked by
running them rather than by reading (2026-09-05, against the real `~/mc` with
the worktree in place). The worktree sits a level below `~/mc/brief/`, where
`areasWithCheckout` and the runner's `workareas()` cannot see it — both list a
top-level directory only when `<area>/<repo>/.git` exists, which is why
`~/mc/plan/` and `~/mc/gate/` are invisible too; with the worktree at
`~/mc/brief/unblock/memoro-cli`, `areasWithCheckout` listed 80 areas and
neither `brief` nor `unblock` was among them. And the branch is not `<project>`
or `<project>-…`, which is the shape `projectForBranch`
(`src/mc/project-prs.js`) claims for a project: against the 46 project names on
main, `brief/unblock-2026-09-05` returned `null` where `brief-blocked-steps-4`
returned `brief-blocked-steps`. A branch of the claimed shape would read as
that project's own work in flight and keep it out of every pick. (The runner's
own block pull request uses exactly that on purpose — `<name>-blocked-<stamp>`
— so a block that has not landed holds its project; see
[`mc-run.md`](mc-run.md) § *Blocked by the runner*.)

No verb was built for this. `mc unblock <repo> <project> <step>` was the
alternative and was rejected: the route above needs no new code and no new
authority, and a route that has to be built first cannot be walked by the step
that walks it.

## What the brief does with a proposal

The listing is a list and a rule, and the rule is the half that gets skipped.
A proposal is a reading, not work: it becomes a project (`PLAN.json` on main,
then its name in `~/mc/queue.md`), or the brief builds it, or it is dropped.

**Whichever of the three happens, the file is archived: it moves to
`~/mc/proposals/archive/` with one line at its foot saying what happened —
built and where it landed, or dropped and why.** The move happens at the
moment it is decided, and the brief does it without asking. Asking costs a
round trip for a filesystem move nobody would refuse, and the cost of not
moving it is the real one: a proposal already built stays in every brief until
somebody re-reads it to find that out. That is how 2026-09-19's list came to
carry four gate-red proposals that main had fixed days earlier.

`archive/` is a directory, and `listProposals` filters on `.md`, so an
archived proposal drops out of the listing with no second mechanism.

A proposal only **partly** handled does not move. Rewrite it in place to what
is actually left, dated, saying what closed the rest — so the list says what
the proposal is waiting on rather than what it said the day it was written.

## How it is tested

`tests/mc/commands/brief.test.js` covers the verb: that it opens the foreground
conversation in `~/mc/brief/` with the overlay and no opening words, that
a resumed session is handed no prompt, that `--new` starts a fresh one, that
`--collect` and `--offline` exit 2. The role's own text is not tested
(Martin, 2026-09-28). `tests/mc/brief-collect.test.js` covers the
shared readers on fixtures: the proposal listing, plan frontmatter,
`cat-file --batch` framing on bytes rather than characters, and `runsFor`.

**Not measured:** the interactive launch itself. No headless session can
watch a program take the terminal, so what is verified is that the right
argv is built and spawned with `stdio: 'inherit'`; that the session opens
and waits for him is Martin's to see, once.
