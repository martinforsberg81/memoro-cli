# mc brief — the evaluation and decision session

`mc brief` is the hour Martin sits down. Everything else in mc runs without
him: the runner takes `ready` steps, opens PRs and merges them, archives what
is done and closes the workarea behind it. None of that asks a question. The
questions pile up anyway — a failed step, a project archived with no note, a
folder under `~/mc` no plan explains, a proposal the helper wrote — and until
they are put to the one person who can answer them, they are invisible.

This verb opens the session that puts them. That is the whole of it: **the
foreground brief session, with the `brief` role and no gathered document.**
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

[`canon/roles/brief.md`](../../canon/roles/brief.md) opens by saying nothing is
gathered for it and where each thing lives:

| the ground | where |
|---|---|
| the runner, the queue, failed and blocked steps, the intake, the workareas | `mc --fresh`, the page — read first |
| one project | `mc status <name>`, `mc step <project>` |
| proposals | `ls ~/mc/proposals/` — names only; `archive/` is a directory |
| the runner's three questions | `~/mc/runner/undocumented-closures.md`, `unplanned-workareas.md`, `unreadable-plans.md` |
| what landed | `gh pr list --state merged` in each repository |

A file the runner has never written and a file it wrote and left empty are two
answers, and the session is to read them as two: "the runner has not written
one yet" is not "there is nothing to report".

## The session

The verb opens **an ordinary foreground terminal program** — `spawn` with
`stdio: 'inherit'` through `openInWorkArea`
([`src/mc/work-open.js`](../../src/mc/work-open.js)) — not tmux. The brief
session already there is resumed where it was (`pick: null`), with no prompt
of its own, as `mc helper` is; a fresh one starts on `--new`, or when there is
none, with `Start the meeting.` as its first words (Martin, 2026-09-13; the
resume prompt went 2026-09-19). Opus by default from the role, `--codex`
allowed through the adapter, the Coding Profile appended, then
`canon/roles/_common.md` and the overlay from `canon/roles/brief.md` —
assembled like every other session's ([`mc-roles.md`](mc-roles.md)). NOW says
`brief` for exactly as long as it holds the terminal. A missing role is exit 1.

It stands in `~/mc`, the work root, and not in a repository. Giving it a
worktree would only put a branch under a conversation that must never commit
anything.

The role tells it to take the decisions **one at a time**, each as a proposal
Martin says GO to — never a menu of options, and never a question it has not
read the code behind. If it cannot name one thing to do, the question is not
ready and it says so. It ends when the lists are empty or Martin says stop.

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
brief settles by reading is answered in the session that read it, and that
makes the brief a fourth writer beside the step session, the planning session
and the runner ([`docs/project/README.md`](../project/README.md) § *Who writes
what*). It reaches `main` by a route the role names, because a route that is
not written down will not be taken:

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
conversation in the work root with the overlay and `Start the meeting.`, that
a resumed session is handed no prompt, that `--new` starts a fresh one, that
`--collect` and `--offline` exit 2, and that the overlay asks for a proposal
rather than a menu and says where the ground is read. It reads the overlay
itself rather than a copy of it. `tests/mc/brief-collect.test.js` covers the
shared readers on fixtures: the proposal listing, plan frontmatter,
`cat-file --batch` framing on bytes rather than characters, and `runsFor`.

**Not measured:** the interactive launch itself. No headless session can
watch a program take the terminal, so what is verified is that the right
argv is built and spawned with `stdio: 'inherit'`; that the session opens
and reads the page first is Martin's to see, once.
