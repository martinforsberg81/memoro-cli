# Coding-agent protocol for memoro-cli

Canonical, tool-agnostic project instructions for any coding agent
working on this repo. Claude Code reads `CLAUDE.md`, Codex / GPT
agents read `AGENTS.md`; both are thin wrappers around this file, edited
by hand. mc writes neither, and no longer has any machinery that could:
the user's Coding Profile reaches a new conversation as a launch argument
and is never copied into an instruction file.

`memoro-cli` — the terminal coordinator for Memoro. Ships the `mc`,
`memoro-cli`, and `memoro` binaries. Node 22+, ESM, `node --test`.

Current product boundary: `mc` runs Martin's coding work. It is one page
(bare `mc`), a set of plans on `main`, a runner that takes their steps in
fresh headless sessions, and one door those steps land through. It is
built for that one user (D-0205); a feature that does not serve it does
not belong here. The description this paragraph replaced — "a minimal
grounded coordinator runtime, not a project-management system and not an
agent runner" — described the product before `mc plan`, `mc run` and
`mc brief` existed.

A large part of `src/` used to be the session manager that preceded this — a
registry, a broker, a PTY host, managed providers, cloud runtimes and a
capability dispatcher, 71 % of `src/` unreachable from the page and its verbs
when it was measured on 2026-08-29. `mc-cut` removed it on 2026-09-03:
`src/` is 153 files where it was 281, and nothing in it is unreached. What
survives that no verb reaches, and why each piece was kept, is
[`docs/technical/mc-cut.md`](technical/mc-cut.md). Do not assume a module is
live because it exists — `npm run reach` still answers that question, and its
last row should read `0%`.

## Stack + commands

- Three commands from one package (`package.json` `bin` field):
  - `memoro-cli` / `memoro` → `src/bin.js` (low-level: login, legacy lens
    compatibility, hook installation, heartbeat daemon). No mc verb reaches
    any of it; whether it should still ship is Martin's decision, not a
    cleanup — see [`docs/technical/mc-cut.md`](technical/mc-cut.md).
  - `mc` → `src/mc-cli.js` — the page and twelve verbs, falling through to
    `src/bin-mc.js`, whose whole table is now `mc vault`
- Tests are the merge gate. `mc merge memoro-cli <pr>` runs the suite and
  cannot land a red one; see "Validation" below.
  `node --test --import ./tests/_isolate-home.mjs <files>` is the focused
  local loop.
- `docs/plans/` held the planning directory `docs/project/` replaced. mc-cut
  emptied it of everything but the custody design `mc vault` still implements
  ([`docs/plans/mc-custody.md`](plans/mc-custody.md) and
  [`vault-import.md`](plans/vault-import.md)). Nothing there is an instruction;
  do not execute its commands or use it to override current architecture.

## How work is organized

Work is **projects**, and a project is a `PLAN.json` on `main`. This is the same
shape in memoro; the difference is only which repository the plan lives in.

```
mc brief    → Martin and a session read what happened and what is waiting
mc plan     → a foreground session on one programme, with Martin in it;
              plans come out of it as docs/project/<programme>/<project>/PLAN.json
mc run      → the runner takes one step of one ready plan, in a fresh session
mc merge    → the gate, then the squash
              close-out → project_log.md + docs/technical/
```

- **Plans live at `docs/project/<programme>/<project>/PLAN.json`.** There is one
  programme here, `mc`. One file: the overall part — `goal`, `contract`,
  `out_of_scope`, `success_criteria`, `documents` — then `steps[]`, each
  carrying its own `instruction`, `done_when`, `status`
  (`ready` | `done` | `blocked`) and `comments`. The plan has no status of
  its own: it is the state of the first step that is not done. See
  [`docs/project/README.md`](project/README.md).
- **You do not write plan state by hand.** `mc plan <programme>` opens the
  session a plan is written in, with Martin in it. A step session edits its own
  step's `status`, `pr` and `comments`, and `met` on the criteria it met — and
  `mc run` compares the file before and after, so a session that touched a step
  it did not run leaves a PR the runner will not merge.
- **You do not decide.** An open question becomes a
  `decisions/<programme>-<n>.md` file at the root of the session that raised it
  — `~/mc/<workarea>/` for a step session, `~/mc/plan/<programme>/` for a
  planning one: the question, the options, one recommendation, and no menu.
  Martin answers it in `mc brief`. Those directories are outside git and do not
  survive the session, so a ruling worth keeping is carried into
  [`docs/project/mc/rulings.md`](project/mc/rulings.md) **before** the file is
  retired — `mc brief --collect` deletes an answered file once no plan is still
  waiting on it.
- **A workarea is `~/mc/<project>/memoro-cli`,** a worktree on branch
  `<project>` from `origin/main`. `mc` owns it: it is created by `mc run` when
  it first steps that project, or by `mc work add`, and closed by `mc run` in
  the round after its plan says `done`. Never remove one, or its branch, by
  hand. A planning session has no workarea and makes none: it lives at
  `~/mc/plan/<programme>/`, which the runner cannot see (see
  [`docs/technical/mc-plan.md`](technical/mc-plan.md)).
- **`status: ready` is what starts the runner on a plan.** Nothing else is a
  queue. Do not set it on a plan that is not ready to be executed unattended.

## Working on this codebase as a coding agent

For focused work, inspect, implement, verify, and publish directly. For larger
work, agree on a concise contract covering outcome, scope, non-goals,
completion criteria, validation, dependencies, and escalation points. Resolve
uncertainty through read-only inspection before asking or guessing.

### A series of pull requests (normative)

Measured four times in one evening (#366, #367, #368, 2026-08-22): every PR
here writes one entry in `CHANGELOG.md` and one row in
`docs/mc-command-matrix.md`, so two PRs that touch the same two files conflict
on every gate round whatever their code does — and each conflict cost the PM
a round. Two rules, both cheap:

- **One branch from `main` per change, never stacked.** A child PR merged
  after its squashed parent lands on the orphan parent branch, not on `main`
  (#363, re-landed as #364). Stack only when the child literally cannot be
  built without the parent's commits on `main` — and then merge the child
  first, or retarget it to `main` once the parent lands.
- **The changelog entry is a fragment, never a line in `CHANGELOG.md`.** A
  pull request adds `changelog.d/<topic>.md` (a `section:` line and the
  entry; see `changelog.d/README.md`) and does not touch the Unreleased
  section. `node scripts/changelog-fold.js` folds every fragment into
  `CHANGELOG.md` at release, in one commit. "Document lines in the PR's own
  last commit" was the earlier rule: measured, it isolated the conflict and
  made every resolution *keep both*, but git still stops on two insertions
  within three lines of each other and GitHub's mergeability ignores local
  merge drivers — nine resolutions and two red gate rounds later, the
  conflict class is removed rather than managed. Any other shared document
  (`docs/mc-command-matrix.md`, this file) still goes in a final commit
  touching nothing else, and a series against it lands in order with `main`
  merged in between (a merge commit, no rewritten history). This file had a
  byte-for-byte copy at `canon/coding-agent-protocol.md` once, and a gate that
  compared them; both are gone — `canon/` holds the role overlays and nothing
  else, and this file is the only copy.

## Work Method Updates

Durable changes to how coding agents should work with the user are the
**Coding Profile**, which is the user's and lives in Memoro. mc reads it
(`src/mc/portrait.js`, `GET /api/mc/coding-profile`) and hands it to a new
conversation as a launch argument — `--append-system-prompt` for Claude,
`-c instructions=` for Codex. It has no verb of its own any more:
`mc coding-profile read|diff|write` went with mc-cut, and the profile is
edited in Memoro. Do not edit `AGENTS.md`, `CLAUDE.md`, or old repo roadmap
files as a substitute for it.

A rule that should bind the next agent in a repository — a way of merging,
a way of running subagents, a thing never to do again — is written into
that repository's agent contract (`docs/coding-agent-protocol.md` here,
`AGENTS.md`/`CLAUDE.md` in memoro), in the section the next agent will be
reading when the rule matters. It is never left only in an agent's
per-project memory store: a memory is read by one agent, a repository file
by all of them. Ruled by Martin 2026-08-29 after a merge-gate rule had been
saved as a memory and nowhere else.

## Code conventions

- `src/mc/commands/<name>.js` for new `mc` subcommands, added to the
  `modules` map in `src/mc-cli.js` (NOT `src/commands/`, which belongs to
  `memoro-cli` / `memoro`, and NOT `src/bin-mc.js`, whose whole table is
  `mc vault`).
- `src/mc/` for mc-only subsystems (`paths.js`, `run.js`, `repo-gate.js`,
  `page-collect.js`, …). `src/vault/` is the vault engine and is the one
  subsystem this repository keeps without a verb reaching all of it.
- Cold start matters: `mc` is the page and is typed constantly, so a verb's
  module is imported when it is routed to, never at load.
- Tests mirror `src/` structure under `tests/`.
- Adapter contract: `src/adapters/index.js` is the launch adapter every verb
  that starts a tool goes through — `resolveLaunch(toolInput)`, called from
  `src/mc/run.js`, `src/mc/work-open.js` and `src/mc/helper-turn.js`, so no
  verb spells out `claude` or `codex` itself. Each `src/adapters/<tool>.js`
  still exports `ID`, `LABEL` and `detect()`; its `TOOL_NAME` /
  `STATUS_TIMEOUT_MS` / `getStatus()` probe lost its only caller when
  `mc auth status` was removed.

### A reason says what was measured, not what was inferred (normative)

Every refusal, verdict and status line mc prints is read as a fact by
somebody who cannot see what it read. So the sentence must claim exactly what
the reading supports and no more. The case that set the rule (2026-08-22): the
wake guard read text after the prompt mark and said *there is already
something in its prompt* — but a pane redraws old orders there, and only a
probe typed into the input can tell a draft from a ghost. A reader that cannot
probe now says *something is drawn in its prompt — a draft, or a ghost only a
wake can tell apart*. Same evidence, a sentence the evidence can carry. Nine
meters that claimed more than they measured were found that week; the word
`GREEN` over 55 standing red names was another. When a reading is uncertain,
say *unknown* or *drawn* — never the confident neighbour of what you know.

## GitHub interaction in coding sessions

### Credential boundary (normative)

Treat the coding agent and every model-directed surface as adversarial. The LLM
domain includes the model context and tool results; commands and child processes
it directs; their files, mounts, environment, argv, standard streams, and
history; process, socket, and `/proc` inspection; PTY output; logs, errors,
status, audit, transcripts, snapshots, and browser payloads; plus any helper or
endpoint the agent can repurpose as a credential proxy.

- No raw secret, login artifact, provider token, CRK, DEK, recovery material, or
  reusable credential authority may enter the LLM domain. Do not add a command,
  debug surface, test fixture, adapter, environment variable, repo file, or
  project-service path that makes one available there.
- `mc vault`, custody administration, device/keychain access, broker grant
  consumption, and provider transports are trusted subsystems outside the LLM
  domain. The model may receive only opaque handles, bounded typed operations,
  and redacted results. It must not be able to choose an arbitrary secret,
  destination, command, or request body through those operations.
- `0600`, hooks, redaction, environment scrubbing, TTLs, and shredding are
  defence in depth, never the isolation boundary. A compliant design requires
  enforced separation of principals, namespaces, mounts, process inspection,
  sockets, IPC, and egress between the credential owner and model-directed
  execution.
- Never pass a managed credential to arbitrary project code, even in a separate
  process. Such code is LLM-editable and can become a credential oracle. Use
  only immutable, signed, policy-bound typed adapters with a narrow schema and
  redacted output.
- If a coding tool or integration cannot keep its login/provider credential out
  of the model-directed executor and cannot prevent its transport from becoming
  an unrestricted proxy, it is unsupported for managed portable bootstrap and
  must fail closed. Do not fall back to interactive login, a tool-home auth file,
  a generic environment token, dotenv, or a legacy binding.

- **No mc vault secret may be exposed in plaintext to an LLM-controlled
  process,** command, file, environment, argv, output, log, transcript, browser
  payload, credential helper, or inspectable peer process. They are never
  materialised for Codex, Claude, generic adapters, or repo dotenv files —
  `mc vault get` and `mc vault bind` refuse for exactly this reason. This
  paragraph is the normative copy; the plan it was quoted from
  (`docs/plans/credential-blind-capabilities.md`) went with mc-cut.
- GitHub credentials are not mc vault material. App private keys and durable
  connection authority stay in the Memoro control plane; short-lived
  installation credentials must never enter the coding-tool child environment,
  argv, files, prompt, transcript, logs, browser payloads, or session records.
- **A session uses the machine's own `git` and `gh`.** The managed GitHub
  capability that used to sit between them — `mc github`, the session-scoped
  `gh` shim, the typed broker operations, `MC_HOST_CAPABILITIES` — was deleted
  by mc-cut on 2026-09-03, and nothing replaced it. The workarea is the
  boundary mc trusts, not a capability inside it. Do not reintroduce a
  credential path here to get around that: never read or print `gh auth
  token`, `gh auth status --show-token`, or any token `gh` holds, and never
  put one in a file, an environment variable, an argv, a log or a PR body.

### Deterministic publication lifecycle

Use one bounded transaction for ordinary commit → PR → main work:

1. Inspect the current branch, complete diff, and base once. Reading the diff
   is the review; no test run gates this step.
2. Stage only intended files, commit, and freeze the exact local head SHA.
3. Push the workarea's own branch — `<project>` or `<project>-<n>`, whatever
   the worktree stands on — and no other. Never force-push and never rewrite
   published history. A branch you named yourself is one `mc run` neither
   lands nor sees as in flight, so it will run the next step on top of your
   unlanded work.
4. Create or update the PR with `gh pr create` / `gh pr edit` from that
   branch. The PR description states what changed, why, user impact, root
   cause for fixes, and known gaps. It does not claim validation that was not
   performed.
5. Read one current PR/check/review snapshot for the frozen head. This
   repository currently has no automatic pull-request workflows; an empty
   checks result is terminal normal state, not a reason to poll. Never claim a
   hosted gate ran unless GitHub reports that exact head's run.
6. Review the final combined diff. Landing is `mc merge <repo> <pr>` and
   nothing else — see *Validation* below — and it happens after the required
   explicit merge approval. A step session never lands its own code PR: the
   runner does, in the round after it. Do not pass `--delete-branch`: whether
   the remote branch survives a merge is the repository's setting, not a
   session's decision. Some repositories delete it deliberately, to stop
   branches accumulating — that is not a fault to report or undo. The local
   branch and its worktree belong to `mc` and are never removed by hand.
7. Confirm the merge result once. Re-read or revalidate only when the head,
   base, diff, review state, or external condition actually changed.

### Validation (normative)

**The suite is the gate again.** This section replaced "Validation is
suspended", which said the opposite and had stopped being true: `mc merge
<repo> <pr>` runs the round in `src/mc/repo-gate.js`, and there is no way to
merge a red one — not a flag, not an option, not an environment variable
(`src/mc/repo-merge.js`). Red is measured as a set of failing test **names**
against a ratchet floor (`src/mc/tap-red.js`, `src/mc/red-ratchet.js`), never
as a count, so a standing red name does not block an unrelated change but a new
one does.

- `mc merge <repo> <pr>` — the gate, then the squash. The only door for code.
- `mc merge <repo> <pr> --check` — the same measurement, stopping at the
  verdict. Use it before you claim anything about the suite.
- `mc merge <repo> <pr> --docs` — a pull request whose every file is under
  `docs/`: no suite, no lease, no worktree, no model. The session that opened
  it lands it itself.
- `npm test` locally is the fast loop and it is green: 1 534 tests, 1 525
  passing, 9 skipped, 0 failing in 64 s, measured 2026-09-03 after mc-cut took
  out the tests of the deleted machinery. There is no standing red set left.
  It still runs with no `--test-concurrency` cap, which ruling `mc-test-1`
  ([`docs/project/mc/rulings.md`](project/mc/rulings.md) §4) names as the
  cause of the load-flakiness, so a local red is worth re-running before it is
  worth reporting. `npm run test:affected` selects the files a diff actually
  touches and is what a step session runs; the gate's verdict is the one that
  counts.

**The runner lands through the same door.** `mc run` has no `gh pr merge` in
it: a finished step's pull request goes through `runMergeRound`
(`src/mc/repo-merge.js`) called in the runner's own process, and the row reads
`merged` only when GitHub says the base it landed on was `main`. So the gate
measures every landing, whoever started it.

One thing to keep saying out loud all the same:

- **Never claim a run you did not make.** Say in the PR body what was run and
  what was not. "Suite not run" is an acceptable sentence; implying it passed
  is not.

## Critical paths — extra care

- `src/mc/repo-gate.js` + `src/mc/repo-merge.js` — the only door code lands
  through, for a session and for the runner alike. A bug here lands a red
  tree, or lands it on the wrong base.
- `src/mc/run.js` + `src/mc/run-plan.js` — the runner. It spends
  ninety-minute unattended sessions on what these two decide, in two
  repositories at once.
- `src/mc/plan-schema.js` — a plan the schema refuses hands out no step, and
  a project sits still until somebody notices.
- `src/mc/work-area.js` + `src/mc/close-workarea.js` +
  `src/mc/archive-plan.js` — destructive worktree, branch and directory work
  under exact provenance. `mc work discard` and `mc work release` are the
  verbs on top of it.
- `src/mc/push-guard.js` + `src/mc/branch-landed.js` — what stops a session
  pushing over work that has already landed.
- `src/vault/engine/` — provider-independent secret store; client-side
  crypto, custody and the C1 lease.
- `src/lib/device-flow.js` + `src/lib/keychain.js` — token issuance and
  macOS keychain access. Per-device tokens are `api-tokens` with scope
  `device`.
- `src/commands/auth.js` — Memoro keychain accounts, browser OAuth flow
  (`memoro` / `memoro-cli`, not `mc`).
- `src/commands/heartbeat-loop.js` — daemon with WebSocket reconnect
  policy (4003 'Replaced' is terminal — don't reconnect)

## What not to do

- Don't import a wrapper / dispatcher without checking that it loads
  (PR #28 lesson)
- Don't add a verb to a router without something reaching it, and don't
  leave a module nothing reaches — `npm run reach` is the check, and its last
  row should read `0%`
- Don't make `mc` / `mc --json` print to stdout in a way that breaks `--json`
  consumers
- Don't guess on design with 2+ reasonable options — raise a decision
  file (`~/mc/<workarea>/decisions/<programme>-<n>.md`) with one
  recommendation and let `mc brief` answer it. A menu of options is not a
  question; if you cannot recommend one, investigate further first
- Don't add `--non-interactive` flags to commands that are already
  non-interactive by default
- Keep `CLAUDE.md` / `AGENTS.md` thin. They are hand-edited wrappers
  around this file: put repo conventions here and reflect them there.
  Durable user work-method changes go in the Coding Profile in Memoro —
  those are the user's, not the repository's.

## Per-tool surface (what each tool reads natively)

| Tool | Reads | Notes |
|---|---|---|
| Claude Code | `CLAUDE.md` (root) + `.claude/skills/`, `.claude/commands/`, `.claude/hooks/`, `.claude/settings.json` | Full native support today |
| Codex / GPT | `AGENTS.md` (root) | Markdown only; skills and slash commands are read manually via the prompt above |
| Gemini CLI | none yet | no verified project-instruction convention |

mc writes none of these files. The user's Coding Profile is handed to a new
conversation as a launch argument — `--append-system-prompt` for Claude,
`-c instructions=` for Codex — and a resumed conversation already has it.
A conversation's tool is chosen when it starts — `mc work <name> new`, with
`--codex` / `--claude` / `--model <m>` — and a running TUI cannot switch tool
in place. There is no handover between tools mid-conversation; the machinery
that once offered one went with mc-cut.
