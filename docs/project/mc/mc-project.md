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

```
~/mc/programs/<programme>/
  memoro/              the programme session's worktrees (today ~/mc/plan/<programme>/)
  memoro-cli/
  <project>/
    PLAN.json          the structure; written only by mc
    steps/
      01-<slug>.md     the prose; read by people and by the step, never parsed by mc
      02-<slug>.md
    memoro/            the steps' worktree, only when the project touches memoro (today ~/mc/step/<project>/)
    memoro-cli/        the steps' worktree, only when the project touches memoro-cli
```

- Replaces `docs/project/<programme>/<project>/PLAN.json` in a repository, `~/mc/plan/<programme>/` and
  `~/mc/step/<project>/` with one tree.
- The programme session starts in `~/mc/programs/<programme>/` and sees every project of its programme beside its
  own worktrees.
- A worktree belongs to a project and goes when the project goes. Stale plan branches (today:
  `plan/ios-build-declaration`, 48 behind) and `branch-foreign` get much harder to reach.
- A step's worktree has `../PLAN.json` and the step files beside it; nothing is searched for.
- `PLAN.json` is structure only: goal, contract, out_of_scope, success criteria with their checks, and per step
  title, model, effort, `done_when`, dependencies and the step file's name. The register stays where a step's state
  lives (ruling 21).

## What goes in the repositories

| In the repository (true about the code) | In mc (the work of changing it) |
|---|---|
| Code and tests | Programmes, projects, plans, step prose |
| `docs/technical/*`: how the system works now | The register |
| Product rulings that constrain future code | Proposals and follow-ups |
| One `project_log` line per delivered project | How a plan changed over time |

Results reach a repository only through the steps' own pull requests (a step updates its technical doc as part of
its `done_when`) and through `archive`, which writes the `project_log` line and a short paragraph on goal and
decisions in the technical doc the project changed. A plan never lands in a repository.

## Verbs

```
mc project new <programme>/<project> --repo <repo>[,<repo>] --goal "…"
mc project criterion add <project> "…" --check "<command>"
mc project step add <project> "<title>" --model haiku|opus [--effort …] --done-when "…"
                                        [--after <repo>:<project>] --instruction-file <md>
mc project step edit <project> <n> [any of the above]
mc project [<project>]                  the project as a person reads it; `mc status` becomes an alias
mc project send <project>               the whole check, then `ready` for the runner. No branch, no PR
mc project archive <project>            done: worktrees and branches go, plan and steps kept, results to the repo
mc project discard <project> [--apply]  gone: the whole directory. Without --apply it shows what would go
mc project import                       once: the active PLAN.json files from the repositories
```

`mc step …` (register transitions) stays as it is.

What the verbs refuse, at the write, so that an invalid plan never exists:
- a step without `--model haiku|opus`;
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
| 3 | `archive`/`discard`, results to the repository, `plan-merge.js`/`merge-boundary.js`/docs path removed | medium |
| 4 | Roles rewritten against the verbs, generated verb reference, repository guidance | medium |
| 5 | Docs consolidation | last |

## Out of scope

- Follow-ups: discoveries that are not picked up later, verbs that print "by hand" (`--testflight`'s
  `asc:attach-build` line), the proposal backlog. A later concern (Martin, 2026-10-19).
- Backup of `~/mc` (later, deliberately).
- Sessions outside this machine.
- Moving archived `closeout/` files out of the repositories; they stay as history.