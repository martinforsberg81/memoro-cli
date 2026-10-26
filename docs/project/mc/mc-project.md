# mc project: mc owns programmes, projects and plans; the repositories get only results

System: memoro-cli (a new `mc project` verb family, the runner, the register, the page, the role canon), with
memoro's `docs/project/` and guidance (`AGENTS.md`, `CLAUDE.md`).

Worked out with Martin on 2026-10-19 (ruling 48); carried here from the proposal `2026-10-19-mc-project`. An earlier conversation the same day proposed the first version (`mc project new/check/send`, schema tightening, roles rewritten after the verbs); this file is the
concept as it stands after that conversation. Read it before writing any plan for it.

## Why

Martin, 2026-10-19: *"Det måste bli mycket enklare att skriva en projekt-plan och att då den iväg … mc är så pass
utbyggd nu att nu är det dags att vi syr ihop detta till en helhet."*

What went wrong the same day:
- `mc-docker` and `mc-build-ios` got "Martin's check" criteria although `_plan-writing.md` forbids them. Prose rules
  do not hold.
- `mc-build-ios` step 3 depended on a memoro project, but the dependency was a sentence in `out_of_scope`, not a
  `blocked_by`. The step started, failed and lay there.
- `mc-ownership` step 4 was `blocked_by: {kind: project, name: mc-runner-hardening}`. `step-release.js` releases a
  project blocker only when that plan is on main with status `done`; `#986` archived the plan to `closeout/` first,
  so the blocker read "not on main" for ever. A bug that exists only because plans live in git.

And the cost of plans in git: since 2026-10-01, 140 of memoro-cli's 228 commits on main touch `docs/project/`.
`plan-merge.js`, `merge-boundary.js` and `archive-plan.js` (721 lines), `mc merge --docs` and the docs fast path
exist so that plans can be landed like code.

## Principle

**A rule that can be checked does not belong in a prompt.** Every rule the verbs can enforce moves into the verbs.
Prose keeps only what needs judgement.

## Decisions (Martin, 2026-10-19)

- `mc project` owns the plan. No session writes the plan file; it changes it through verbs. The file format is mc's
  own business and can change without a single instruction changing. (Not back to Markdown: *"Vi har bytt från md
  till json en gång redan. Jag tror lösningen är någon helt annan än att byta tillbaka. Jag tror lösningen kan ligga
  i mc."*)
- Every step names `--model haiku|opus`. Required, no default, no other value. No `why_opus`.
- Later, for a plan drafted with `--tool codex`: a step names `gpt-6.1-sol` or `gpt-6.1-luna` instead, and a Claude name is refused on that plan. The rule above is the claude plan's. (Added by the codex-models project; not a ruling from Martin.)
- Plans live in mc, not in the product repositories: *"Med ett smart 'mc project' system så kommer det synas även om
  det ligger lokalt i mc."*
- The programme session (`mc plan <programme>`, as today) is the foundation. It creates and drives its programme's
  projects through the verbs. There are no project sessions: a project is data, and its steps are run by the runner
  in the project's worktrees.
- `discard` (the word `mc work discard` already uses) removes the whole project directory, everything. `archive` is
  the way out for a project that is done.
- Backup of mc's state waits until this has landed. (memoro-cli is mc's repository, but it holds mc's code; plans in
  it would be the same mix again.)
- Sessions outside this machine (`/remote-control`) need no special handling.
- Project 2 keeps a step's prose in `PLAN.json`'s `instruction`; the `steps/` files come later. An unsent plan is
  `DRAFT.json` and `send` renames it to `PLAN.json`. `mc status <name>` stays, beside `mc project <name>`.

## Structure

Revised by ruling 51 (2026-10-20). The first version put the steps' worktrees inside the project's directory; mc
removes an area by removing its directory, and counts every process, conversation and dev server under it as the
area's, so a closed step area would have taken the plan with it and an archived programme every project. The rule
now: **a directory mc removes as an area holds only worktrees; a directory that holds a project's knowledge is
never an area.**

```
~/mc/programs/<programme>/            everything of the programme; the programme session starts here
  memoro/  memoro-cli/                the programme session's worktrees (branch plan/<programme>), made by mc plan
  rulings.md, project_log.md, …       the programme's documents (ruling 50)
  <project>/
    DRAFT.json → PLAN.json            what is to be done; written only by the mc project verbs
    STATE.json                        where it stands: the register (ruling 21), moved from runner/projects/
    CLOSEOUT.json                     what it came to, written by archive

~/mc/runner/                          everything the runner runs
  step/<project>/<repo>/              a step's worktree, made by the runner when a step in <repo> runs
  mend/<repo>-<pr>/                   as today
  deps/<name>/<repo>/                 mc deps bump (today step/deps-…)
  log/  merges.json  held.json  unmergeable.json  foreground/  runner.json  billing  caches
                                      what is running now, raw logs, caches; may be pruned or rebuilt

~/mc/work/<name>/<repo>/              a person's workareas, unchanged
```

- **The test:** if `~/mc/runner/` were wiped, only work in flight and raw logs are lost; nothing a person or a
  session needs to know about a project. `~/mc/programs/` is what a backup of mc covers.
- A project is one directory: `discard` removes it, an archived project keeps its whole state beside its plan.
- Linked by name, never by nesting: a project's name is unique over every programme and is its step area, its
  branch prefix and its register; a step is told its plan's path. `mc project new` writes only `DRAFT.json` and
  refuses a repository's name as a project name (it would be the programme session's worktree).
- In `~/mc/programs/<programme>/` mc removes only git worktrees, never another file or directory and never the
  programme's directory: archiving a programme releases `memoro/` and `memoro-cli/` and keeps the rest.
- `PLAN.json`, `DRAFT.json`, `STATE.json` and `CLOSEOUT.json` are written by verbs only; `mc hook pre-tool`
  refuses an edit of them.
- A step's prose stays in `PLAN.json`'s `instruction`: one file per plan keeps every verb's write one write under
  one lock. `mc project <name>` is how a person reads it. No `steps/` files.
- `~/mc/plan/` and `~/mc/step/` go.

## Verbs

```
mc project new <programme>/<project> --repo <repo>[,<repo>] --goal "…" [--tool codex]
mc project criterion add <project> "…" --check "<command>"
mc project criterion edit <project> <n> --check "<command>"   a new check; a met criterion goes back to not met
mc project step add <project> "<title>" --model haiku|opus|gpt-6.1-sol|gpt-6.1-luna [--effort …] --done-when "…"
                                        [--after <repo>:<project>] --instruction-file <md>
mc project step edit <project> <n> [any of the above]
mc project [<project>]                  the project as a person reads it; `mc status` becomes an alias
mc project send <project>               the whole check, then `ready` for the runner. No branch, no PR
mc project archive <project>            done: worktrees and branches go, plan and steps kept, results to the repo
mc project discard <project> [--apply]  gone: the whole directory. Without --apply it shows what would go
```

`mc step …` (register transitions) stays as it is.

`mc project archive` and `mc project discard` are the two ways a project under `~/mc/programs/` leaves. `archive` takes a sent project its register says is done and not yet archived: its row goes to the repository's `project_log.md` through a docs-only pull request, `CLOSEOUT.json` is written beside its `PLAN.json`, and its step area is closed unless a worktree in it has an uncommitted change or its session is live (the archive stands either way). The runner does the same by itself for a project done for 24 hours. `discard` removes a project that is not archived (its directory, step area, register file and open pull requests); without `--apply` it says only what would go, and with `--apply` it refuses a step that is running or landing, a live session or a worktree in use. Neither reaches a plan in a repository, and neither archives a programme.

What the verbs refuse, at the write, so that an invalid plan never exists:
- a step whose `--model` its plan's tool does not run: `haiku` and `opus` on claude, `gpt-6.1-sol` and `gpt-6.1-luna` on codex (`--tool codex`), so either tool's name on the other's plan;
- `Martin`, `by hand`, `manually`, `a person` in `--done-when` or `--check`. Narrow on purpose: "review", "show" and
  "decide" have legitimate uses (App Store review). Elsewhere these are warnings, not refusals;
- a criterion without a `--check` command, or a check that needs the plan to have landed;
- a dependency on another project written anywhere but `--after`. `--after` names `<repo>:<project>` across
  repositories, and mc resolves it over every project at once, archived ones included;
- a change to a frozen field of a started project (today's `plan-merge.js` rules move into the verbs).

## Situations

1. A new project: `new`, then `criterion add` and `step add`, then `send`.
2. A step needs its context: the runner hands it the step file, goal, contract and earlier steps' notes.
3. Two programme sessions changing plans at once (as on 2026-10-19): the verbs take a lock; no conflicting PRs.
4. A plan changes mid-project: a verb write, no PR; the frozen-field rule sits in the verb.
5. Cross-repository dependency: `--after memoro:x`, resolved by mc. The "not on main" bug cannot happen.
6. Done: `archive`. Abandoned: `discard`.

## Instructions

After the verbs exist, not before; the verbs shrink the text.
- `_common.md`: one page. What mc is, the glossary (programme, project, step, runner, merger, register), where
  things live.
- A verb reference generated from each verb's `--help` (`mc help --agent`). Roles name verbs, never describe them.
  Early, since it is what keeps the text from going stale.
- Each role at most about 30 lines: what it owns, which verbs it uses, what it never does.
- memoro's and memoro-cli's `CLAUDE.md`/`AGENTS.md` are in scope: they still describe flows the verbs have taken
  over.
- Roles say what holds now, not "ruling 35, 2026-10-10".

## Order

| # | Project | Size |
|---|---|---|
| 0 | An archived project releases its blockers | small, now |
| 1 | `~/mc/programs/` structure, `PLAN.json` + `steps/` there, the runner and register reading it, `import` | medium |
| 2 | `mc project new/criterion/step/send/show` with the refusals above | medium |
| 3 | `archive`/`discard`, results to the repository, `plan-merge.js`/`merge-boundary.js` removed; the docs route stays (ruling 49) — as `project-archive`, then `plans-out-of-repos` | medium |
| A | `step-area-never-dirty`: a step area is never blocked on its own sessions' files (ruling 50) | small, sent 2026-10-20 |
| B | The structure of ruling 51: programme worktrees under `~/mc/programs/<programme>/`, step areas under `~/mc/runner/step/`, the register as `STATE.json` beside the plan, the edit guard, and the one-time move of what exists | large, before 4: the roles name where a session stands |
| 4 | Roles rewritten against the verbs, generated verb reference, repository guidance | medium |
| 5 | Docs: everything under `docs/project/` moves to `~/mc/programs/` (ruling 50); technical docs that still describe plans in git are rewritten; `archive` writes nothing in a repository | last |

The one-time move of repository plans to `~/mc/programs/` was done by `plans-in-mc` and `plans-out-of-repos`; no verb
imports plans now.

## Out of scope

- Follow-ups: discoveries that are not picked up later, verbs that print "by hand" (`--testflight`'s
  `asc:attach-build` line), the proposal backlog. A later concern (Martin, 2026-10-19).
- Backup of `~/mc` (later, deliberately).
- Sessions outside this machine.
- Moving archived `closeout/` files out of the repositories; they stay as history.