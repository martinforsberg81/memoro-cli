# Help cleanup: measurements, shared usage and remaining audit

**Status:** partial goal work, second session, 2026-11-02. This is not the completed
line-by-line command/flag audit. No working command has been removed.

## What changed

The daily page before IN FULL is 37 lines, none wider than 80 columns,
including the title and blank lines. It groups planning/follow-up, running
and landing, observing/shipping, and workspaces. Less-used entries moved to
IN FULL, rather than disappearing. `mc merge` no longer promises the same
measurement as `mc test`, and `mc tidy --apply` describes rechecking facts,
not asking the person a confirmation question (`src/mc/tidy.js`, `runTidy` /
`applyTidy`).

`src/mc-verbs.js` already answered help anywhere after an ordinary verb. Before
this change, probes of both `mc work add --help` and `mc run lanes --help`
returned 0, not the 2 reported in the goal's starting brief. The exception
found by reading the code was the vault capability: only its first argument
was checked for help. It now uses the same `wantsHelp`, and `src/bin-mc.js`
answers capability help before device authentication. No non-help vault
operation or credential boundary changed. The deliberate passthrough of
`mc keys run <script> --help` to the declared script is unchanged.

The help regression test walks literal prefixes in both the long help and
every routed handler's usage, expanding finite alternatives (including nested
`project criterion` and `repo watch` forms). It checks `--help` and `-h` for
exit 0 and the same usage text. It separately walks the vault dispatch table,
checking help before credentials can be read, and probes representative forms
through the binary. This is **not yet** a parser/route-validity test: the
central help interceptor would also answer an invented subcommand. That
independent validation remains required below.

## Usage measured again

Window: 2026-10-03 08:46 UTC through 2026-11-02 08:46 UTC. Read 660 session
JSONL files modified in that window, checking record timestamps; examined
14,735 Bash tool calls. The terminal column covers all retained zsh history,
not just 30 days. These are command occurrences, not unique users, successes,
or proof that a hook allowed execution. This pass uses a conservative
shell-token scan for executable `mc`, excluding quoted prose and here-document
bodies. It recognizes ordinary command separators, assignments, and
`env`/`nohup`/`time`/`command` prefixes; embedded `bash -c` strings, dynamic
commands and other wrappers are not measured. Zero means not observed by this
method, not proved unused. The starting brief's counts are not reused.

| Verb | Session commands | Terminal commands |
| --- | ---: | ---: |
| `gate` | 2163 | 0 |
| `shot` | 1461 | 4 |
| `project` | 908 | 14 |
| `publish` | 614 | 0 |
| `step` | 312 | 12 |
| `status` | 272 | 0 |
| `dev` | 258 | 1 |
| `prs` | 153 | 0 |
| `goal` | 122 | 0 |
| `merge` | 122 | 82 |
| `test` | 104 | 4 |
| `run` | 68 | 68 |
| `deploy` | 62 | 129 |
| `work` | 30 | 0 |
| `plan` | 31 | 201 |
| `repos` | 17 | 0 |
| `build` | 25 | 6 |
| `brief` | 12 | 25 |
| `vault` | 11 | 9 |
| `docker` | 11 | 0 |
| `repo` | 11 | 0 |
| `tidy` | 6 | 2 |
| `layout` | 3 | 7 |
| `model` | 3 | 0 |
| `keys` | 2 | 0 |
| `roles` | 1 | 0 |
| `language` | 1 | 10 |
| `helper` | 1 | 2 |
| `hook` | 0 | 0 |
| `deps` | 0 | 4 |
| `log` | 0 | 0 |
| `worker` | 0 | 0 |

The same scan found 101 session occurrences of the removed programme verb,
12 of the removed session-control verb, and 1 of the plural models typo
(terminal: 1, 0, 0). These are attempted commands, not evidence of live routes.

### Candidates for Martin, not deletions

- **`mc log`**: reads invocation/event/round/lease logs, joins one run, or
  lists abandoned rounds. Zero in both measurements. `src/mc/commands/log.js`
  implements it; `src/mc/helper-cli-collect.js` recommends it in digest output
  but does not execute it. Keep documented; troubleshooting can be infrequent.
- **`mc worker`**: creates/opens a workarea marked with the worker role so its
  conversations inherit that overlay and default model. Zero in both
  measurements. Its dispatcher entry, handler, comments and help were found,
  not a programmatic caller. Retained for Martin to judge.
- **`mc hook` is not unused** despite zero in these Bash/terminal samples.
  `src/mc/hooks.js`'s `MC_HOOKS` registers `session-start` and `pre-tool` as
  coding-agent hooks; those are callers outside ordinary Bash tool input.

This is only the top-level candidate list. The per-subcommand unused/caller
inventory still needs to be completed before the goal can be marked done.

## First-pass decision table

| Surface | Decision | Why / code read |
| --- | --- | --- |
| Bare page, JSON/fresh | Reworded on first screen; detailed text retained | `mc-cli.js` page flag routing, `commands/home.js` |
| brief, plan | Kept on first screen | Existing launch descriptions retained; role/person markings belong to the other goal |
| status, step, project, goal | Reworded on first screen; old forms retained in full | Dispatch, handler usage, goal/status handlers and project/step routing |
| run/start/stop/lanes/billing | Shortened on first screen; full control descriptions retained | `commands/run.js` usage, `parseRunArgs`, `order` |
| gate, test | Shortened on first screen | `commands/gate.js` and `commands/test.js` usage/dispatch; complete long-form behavior audit pending |
| publish, merge | Reworded on first screen | `commands/publish.js` queues by default; `commands/merge.js` delegates code to the gate/queue and handles docs inline |
| shot, dev, deploy, build | Shortened on first screen | Handler usage and deploy/build/dev dispatch; detailed text retained |
| work, prs, tidy | Shortened on first screen | Handler usage/routing; prs reads GitHub or cache; tidy rechecks before removal |
| keys, hook, language, deps, layout, repos and less-used forms above | Moved from daily page to IN FULL, or already there | No working verb or previously named subcommand deliberately removed |
| vault subcommand help | Fixed | `cli/vault.js` and capability auth/dispatch in `bin-mc.js` |
| Working command code | Removed: none | Goal explicitly reserves removal decisions for Martin |

## Coordination and remaining goal work

Read `mc goal show mc/session-knows-its-role` before edits. That goal was open,
with uncommitted work and no open PR when checked. No other worktree was opened
or merged. This pass leaves the existing plan/brief launch wording intact,
adds no role/person markings, and does not touch its matrix rows or role files.
The second session integrated its open PR as recorded below; its role identity and caller markings are now retained on this branch.

Before completion:

1. Audit **every long-form line, subcommand and flag** against its handler,
   run its help, and complete the PR's kept/reworded/removed table. Known
   places needing scrutiny include the test PR baseline/comparison description,
   PLAN.md versus PLAN.json wording, helper intake flow, and missing handler
   forms in the long text (project editing, model mutation, shot sessions).
2. Make long help and each verb's usage share their descriptions from one
   dependency-free source. Do not turn top-level help into eager imports of
   every runtime handler; cold-start help is deliberately thin.
3. Add a route/flag validity test independent of the help interceptor, including
   negative controls. The prefix-walker regression above cannot prove routing.
4. Complete subcommand usage/caller classification and put the whole unused
   list before Martin in the PR. Keep scripted/runner verbs even when a person
   never types them.
5. Audit/update the command matrix and current technical/canon/instruction
   descriptions. A Python word-boundary search found **no** references to the
   three guessed verbs in src, canon, docs/technical, the matrix, CLAUDE.md or
   the coding-agent protocol. Fourteen references remain in
   `docs/project/mc/autonomy-goals.md` (explicitly marked superseded, machinery
   removed) and historical ruling 60. Review that historical context rather
   than presenting its removed design as instructions; the archive was not
   rewritten in this first pass.
6. Reconcile the other goal's person/session markings without losing either
   intent, rerun the affected gate and the two touched help tests, and publish
   the final table and inventory before marking the goal done.


## Second session: shared text and role coordination

Fetched and merged origin/main first (already up to date). Read the role goal
again: done, with PR #1220 still open at `a927d374`. Fetched and merged
`origin/goal/session-knows-its-role`, not its worktree. The only conflict was
in help-text.js. Kept both intents: person/session guidance remains in
IN FULL, daily brief/plan/runner controls carry short person labels, and the
first screen remains **37 lines, maximum 80 columns**. Re-read the merged
reference: no duplicated role block or runner synopsis was retained.
The role work is consequently included in this PR until its own PR lands.
Do not mistake this integration for either PR being merged into main.

`src/mc/command-help.js` is static data plus two render functions, with no
runtime imports. Seven handlers return `commandUsage(verb)` and IN FULL
embeds `commandReference(verb)`: only the leading usage marker differs.
The parity test checks exact text, one reference block per command, and the
absence of runtime imports from that source. Other verbs still need migration.

### Synopsis/description decisions in this session

This is the reviewed subset, **not the completed every-line audit**. Existing
behavior is unchanged: only usage strings, their source, and documentation moved.
The existing handler suites were also run, not replaced with text comparisons.

| Surface | Decision | Handler/flag reading and reason |
| --- | --- | --- |
| `run`, `start`, `stop`, `lanes`, update and billing flags | Kept; descriptions shared/reworded | `parseRunArgs`, `parseLoopArgs`, `order`, lane and billing handlers; loop flags, start-only `--if-was-running`, stop/update `--force`, lane `--total`, billing provider on/off all routed. Expanded synopses are parsed without `--help`; invented commands, misplaced and retired flags fail. |
| `run` plan/digest descriptions | Reworded | `run.js` chores and `run-plan.js` helper/intake gates: ready PLAN.json under programmes, not PLAN.md on origin/main; collection daily after 05:00Z and intake on its own cadence, not one daily model turn. `--once` skips chores. |
| `project` display/new/edit/amend/send/archive/discard | Kept; missing full-reference forms added | Dispatch and per-verb `onlyFlags`, NEW_FLAGS/EDIT_FLAGS; show permits json/offline, discard alone permits apply; amendment-file/reason dispatch stays. Send validates, appends review and renames DRAFT.json to PLAN.json. |
| `project criterion` add/edit/drop/met/unmet; `project step` add/edit | Kept; all handler synopses now shared | Dispatch and per-verb check/reason/step flag lists. Existing criterion/check, work-class, effort, instruction-file and dependency descriptions retained. This is not a fresh exhaustive audit of every plan-validation invariant. |
| `step` reading/failed/blocked/note/ready/done | Kept; missing forms and flags now visible in full | STATES, scanner and special after-deploy handling; json reading, reason/answer, on/on-project/until/after-deploy/hours, pr. Register writes and time/deploy constraints read; only memoro deploys. |
| `goal` new/log/open/blocked/done/show/list | Kept; descriptions shared | VALUE_FLAGS, VERB_FLAGS, STATUS_VERBS and dispatch; status choices now explicit in long synopsis, log tags/MC_GOAL default, path, fetch-first behavior and show/list output retained. |
| `status` name/json/offline | Reworded and shared | cli/status.js, commands/status-project.js, collectProject; plan plus register, not PLAN.md frontmatter; missing name points to mc, goals to goal show. |
| `model` list/add/remove/set review | Kept; mutation forms now explicit in full | Handler dispatch and arity, class/target/candidate parsing; json only for list, no capacity poll. |
| `helper` desk/collect/intake | Reworded and shared | Scanner, openDesk and collect/drain branches; collect works without intake, one digest per repository, one oldest-first turn per inbox file. Tool/model/new and digest window/limit/threshold forms retained. |
| Matrix runner `--rounds` | Removed from active syntax | parseLoopArgs explicitly refuses it; the technical runner document already marks it retired. No working flag was removed. |
| Matrix helper/start/update descriptions | Reworded | Same handler/source readings as above, preserving the role goal's caller labels. |

### Validation and remaining work

- Post-integration `mc gate`: **3,556 tests, 0 failed, 436 seconds** on the
  committed merge result, before the shared-source changes.
- Focused shared-help/handler gate (14 files): **353 tests, 0 failed, 18 seconds**.
- Real binary `run --help` and `helper --help` printed the new shared text.
- Daily page probe: **37 lines / 37 screen lines / maximum 80 columns**.

The real-parser negative controls currently cover **run only**. The generic
help-prefix walker still cannot prove that other verbs' subcommands and flags
are valid. Do not call the route/flag criterion complete. Continue migration
of the remaining handlers and vault, then add independent parser/route checks
for all documented forms. Finish the per-subcommand usage/caller inventory;
no new unused determination was made in this session. Preserve the measurements
above rather than treating unobserved syntax as unused by inference.


### Main moved during publication

The first publish of shared-help head 4f46a497 reported a conflicting PR.
Fetching origin/main brought in #1219 (repository MERGES queues / STEPS) and
#1220 (the role work already integrated here, now squash-landed at 46a61dea).
Resolved the matrix by retaining the new repository queue row plus the shared
help corrections and caller labels. The repeated role patch also reinserted
its role-guidance section above the short page: removed that duplicate and
added an explicit one-section assertion. The single complete guidance block
remains in IN FULL. No generated files were involved.

The pre-sync 3,561-test green is historical, not evidence for the final merged
head; subsequent post-sync measurements supersede it and are recorded in the
PR/log. The role PR no longer adds separate work to this PR's diff against main.
