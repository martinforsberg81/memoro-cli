# mc brief — the evaluation and decision session

`mc brief` is the hour Martin sits down. Everything else in mc runs without
him: the runner takes `ready` plans off `queue.md`, opens PRs and merges
them, archives what is done and closes the workarea behind it. None of that
asks a question. The questions pile up anyway — a decision file a step
session could not answer, a project archived with no note, a folder under
`~/mc` no plan explains, a proposal the helper wrote — and until they are
put to the one person who can answer them, they are invisible.

This verb puts them. It is two halves that share nothing but a file:

- **`mc brief --collect`** — a script, no model, that gathers the ground
  into `~/mc/brief/<ISO timestamp>.md`.
- **`mc brief`** — that, and then a fresh foreground session whose first
  words are the file.

It replaced the resident PM and the pm-helper (`~/mc/mc-utredning/utredning-2026-08-24.md`
§9–13, D-0218). Nothing in it is resident: no daemon, no watcher, no inbox,
nothing to wake. The runner does not know it exists and runs whether or not
it is ever called. The code is
[`src/mc/brief-collect.js`](../../src/mc/brief-collect.js) — pure builders
plus one `collectBrief` that touches the machine — and
[`src/mc/commands/brief.js`](../../src/mc/commands/brief.js), which is fifty
lines: collect, then hand the file to `openInWorkArea`.

## What it reads

Nine sections, in this order, each from a file something else already
writes:

| section | source |
|---|---|
| Merged since last brief | `gh pr list --state merged --search merged:>=<since>`, per repository |
| Opened, not merged | `gh pr list --state open` |
| Waiting on Martin | every `~/mc/<area>/decisions/*.md` with no `**Beslut:**` line |
| Proposals | `~/mc/proposals/*.md`, what `mc helper`'s turn wrote |
| Plan status | every `docs/project/*/*/PLAN.json` on `origin/main` of both repositories |
| Archived without a note | `~/mc/intake/undocumented-closures.md` |
| Workareas with no project on main | `~/mc/intake/unplanned-workareas.md` |
| Runner | the last 24 h of `~/mc/runner/log/runs.tsv` |
| Queue | `~/mc/queue.md` |

The two repositories are `~/memoro` and `~/memoro-cli` (`MC_REPOS_HOME`
moves them, `MC_WORK_ROOT` moves `~/mc`). Plans are read off the ref, never
out of a checkout: one `ls-tree` for the names and one `git cat-file
--batch` for every plan's text — the loop this replaced spent a `git show`
per plan, 1.22 s for memoro's 38 against 54 ms for the whole listing.

**"Since last brief" is the mtime of the newest file in `~/mc/brief/`**, and
24 hours when there has never been one. There is no state file: the briefs
themselves are the record of when there was last a brief. The *Runner*
section is the exception and always looks back 24 h — it is a picture of the
machine's day, not of the interval.

Two answers are kept apart everywhere. A file the runner has never written
is reported as absent; a file it wrote and left empty is reported as none.
"The runner has not written one yet" is a different thing from "there is
nothing to report", and reading it as the second is how a board looks clean
when nobody has looked.

## What it writes

`~/mc/brief/<date>.md`, and deletes answered decision files. That is all.

The deletion is `retireDecisions`, and it is deliberately **not** "has a
`**Beslut:**` line". `decisions/` is meant to hold open questions and
nothing else; on 2026-08-29 it held 51 files, 42 of them answered, some for
weeks, so every reader had to sort 51 to find the 6 that were live. But the
answer has to land somewhere first. A file goes only when every plan that
owns it has left `waiting-decision` — measured against `~/mc`, the
difference was eleven files, `avatar-image-animation` alone carrying seven
answered decisions while its plan still waited on one of them by name.
Deleting on the answer alone takes the answer away before whoever must apply
it has read it.

A plan owns a file in its own area, or one named `<programme>-*` or
`<project>-*`. **A file no plan owns is an orphan and is never deleted** —
the project it belonged to is gone from main, and silently removing a
question nobody answered is the one failure worse than keeping it. It is
reported in the run's notes instead.

This runs from `mc brief --collect` and nowhere else. `mc run` has nothing
to do with decisions (Martin, 2026-08-29), so the tidying happens at the
moment somebody sits down to read the list, which is the moment it matters.

## The session

The bare verb opens **an ordinary foreground terminal program** — `spawn`
with `stdio: 'inherit'` through `openInWorkArea`
([`src/mc/work-open.js:127`](../../src/mc/work-open.js)) — not tmux, never
`--resume`. Opus by default from the role, `--codex` allowed through the
adapter, the Coding Profile appended, the overlay from
[`canon/roles/brief.md`](../../canon/roles/brief.md), and the brief file as
the first prompt. NOW says `brief` for exactly as long as it holds the
terminal.

It stands in `~/mc`, the work root, and not in a repository. Its writes are
`~/mc/<area>/decisions/*.md`, which no checkout contains, and giving it a
worktree would only put a branch under a conversation that must never
commit anything.

The role tells it to take the decisions **one at a time**, each as a
proposal Martin says GO to — never a menu of options, and never a question
it has not read the code behind. If it cannot name one thing to do, the
question is not ready and it says so. Then the two lists the tidying leaves,
one row at a time. It ends when the lists are empty or Martin says stop.

## How an answer travels

Three files, in order, and no daemon between them:

1. The brief session appends one line to the decision file, in the shape the
   overlay fixes:
   `**Beslut:** <what was decided> (Martin, <YYYY-MM-DD>). <one sentence why>`
2. The **next step session** writes that decision into the plan — into the
   Contract, the Steps or `next:` as it requires — and sets `status:` back to
   `ready`. That, and nothing else, is what puts the project in front of the
   runner: the runner runs `ready` plans and does not read decision files at
   all.
3. The next `mc brief --collect` deletes the decision file, because no plan
   waits on it any more.

The brief session never edits a plan. That line is the whole of what it
writes, and the plan is where a decision lives — `decisions/` holds open
questions and nothing else.

An earlier design had the answer line as the runner's own trigger, grepped
out of `~/mc/bin/runner.sh`. It was wrong twice over: it started
`waiting-decision` projects on the wrong file (any `<programme>-*.md` with a
line counted), and it let a decision live outside the plan that depends on
it. The shell runner and its grep are deleted; `ANSWER_LINE` is read in
`brief-collect.js` and nowhere else.

## What is deliberately wide

A decision file is anything under `<area>/decisions/` with a `# ` heading,
minus three bookkeeping names (`README.md`, `log.md`, `merge-log.md`).

The test used to be narrower — a file also had to carry an options-or-
recommendation section written as `## Alternativ`, `## Options` or a bold
lead. Measured against `~/mc` on 2026-08-29 that narrower rule dropped five
files, one of them unanswered and never once shown to anybody
(`swedish-grammar/decisions/language-content-1.md`, whose options are
written as `## Half one …` and a bullet list), while `## Alternativen` — the
Swedish definite form — failed the `\b` after `Alternativ`. It also let in
`pm/decisions/log.md`, 358 kB of append-only log, on one matching line among
thousands. The brief was hiding open questions from the only person who can
answer them, which is the one thing it exists not to do.

The recommendation is quoted when there is one, in either shape that exists
in the wild — a `## Rekommendation` heading or a bold lead
`**Recommendation: option 2.**`. A question with neither shows a dash, which
is honest.

## Speed

The whole thing is a script, so it must feel like one. Measured 2026-08-29
against a copy of the real `~/mc` and both real repositories: **1.5 s**
online and **0.2 s** offline, for 51 plans, 15 decision files, 8 proposals
and 72 runner rows.

The network is the cost, and it is spent concurrently: one `git fetch` and
two `gh pr list` per repository, run side by side. Run one after another the
same calls took 10.4 s, which was the plan's entire budget. `--offline`
skips all of them and reads only what is on disk.

## How it is tested

`tests/mc/brief-collect.test.js` covers the parsers on text: decision files
answered and unanswered, the wide heading rule and the bookkeeping names,
`retireDecisions`'s three outcomes (removed, held, orphan), plan
frontmatter including folded scalars, `cat-file --batch` framing on bytes
rather than characters, the runs.tsv window, and both intake tables
including absent-versus-empty.

`tests/mc/commands/brief.test.js` covers the verb: that `--collect` stops
after the file, that the bare verb opens a new foreground conversation in
the work root with the overlay and the brief as its first words, and — the
round trip that matters — that a `**Beslut:**` line built from
`canon/roles/brief.md`'s **own template** is the shape `ANSWER_LINE`
accepts, and closes the question in the next brief. The overlay is the
specification of that line, so the test reads the overlay rather than a
copy of it.

**Not measured:** the interactive launch itself. No headless session can
watch a program take the terminal, so what is verified is that the right
argv is built and spawned with `stdio: 'inherit'`; that the session opens
and its first turn is the agenda is Martin's to see, once.
