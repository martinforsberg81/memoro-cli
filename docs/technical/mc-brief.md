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

`~/mc/brief/<date>.md`. That is all.

It used to delete answered decision files too. mc had a decision concept —
`<area>/decisions/*.md`, a `**Beslut:**` line Martin appended, a scan, a
render, a retirement rule keyed on which plans still waited — and all of it is
gone. What is decided with Martin is written into the plan it is about, by
whoever next opens that plan, and a plan comes back to the runner by its first
unfinished step being `ready`. There is nothing left for mc to read, count or
delete.

## The session

The bare verb opens **an ordinary foreground terminal program** — `spawn`
with `stdio: 'inherit'` through `openInWorkArea`
([`src/mc/work-open.js:127`](../../src/mc/work-open.js)) — not tmux, never
`--resume`. Opus by default from the role, `--codex` allowed through the
adapter, the Coding Profile appended, the overlay from
[`canon/roles/brief.md`](../../canon/roles/brief.md), and the brief file as
the first prompt. NOW says `brief` for exactly as long as it holds the
terminal.

It stands in `~/mc`, the work root, and not in a repository. It writes one
file, `~/mc/brief/<date>.md`, and giving it a worktree would only put a branch
under a conversation that must never commit anything.

The role tells it to take the decisions **one at a time**, each as a
proposal Martin says GO to — never a menu of options, and never a question
it has not read the code behind. If it cannot name one thing to do, the
question is not ready and it says so. Then the two lists the tidying leaves,
one row at a time. It ends when the lists are empty or Martin says stop.

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

## What is deliberately wide

Nothing, any more. The section that stood here explained how loosely a
decision file was recognised — anything under `<area>/decisions/` with a `# `
heading, minus three bookkeeping names — and why the looser rule was worth its
false positives: the narrower one had been hiding unanswered questions from the
only person who could answer them.

That reasoning went with the concept. It is worth keeping the shape of it,
because the same trap is one directory away: `~/mc/proposals/` is now counted
and never parsed, for the same reason. A reader that decides what counts as a
proposal is a reader that can decide wrongly, silently, about a file somebody
wrote for Martin.

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
the work root with the overlay and the brief as its first words, and that the
overlay asks for a proposal rather than a menu. It reads the overlay itself
rather than a copy of it.

**Not measured:** the interactive launch itself. No headless session can
watch a program take the terminal, so what is verified is that the right
argv is built and spawned with `stdio: 'inherit'`; that the session opens
and its first turn is the agenda is Martin's to see, once.
