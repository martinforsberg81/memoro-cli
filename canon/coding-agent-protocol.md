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

A large part of `src/` is still the session manager that preceded this:
a registry, a broker, a PTY host, managed providers, cloud runtimes and a
capability dispatcher. Measured 2026-08-29, 71 % of `src/` is unreachable
from the page and its verbs. It is being removed by
[`docs/project/mc/mc-cut/PLAN.json`](project/mc/mc-cut/PLAN.json). Do not build
new work on it, and do not assume a module is live because it exists —
`node docs/project/mc/mc-cut/reach.mjs .` answers that question.

## Stack + commands

- Two binaries from one package (`package.json` `bin` field):
  - `memoro-cli` / `memoro` → `src/bin.js` (low-level: login, legacy lens
    compatibility, hook installation, heartbeat daemon)
  - `mc` → `src/mc-cli.js` — the page and the verbs, falling through to
    `src/bin-mc.js` for the capability commands (auth, vault, github,
    connections, dev)
- Tests are the merge gate. `mc merge memoro-cli <pr>` runs the suite and
  cannot land a red one; see "Validation" below.
  `node --test --import ./tests/_isolate-home.mjs <files>` is the focused
  local loop.
- `docs/plans/worktree-lifecycle.md` is historical context. Do not execute its
  commands or use it to override current architecture, repository guidance, or
  live capability descriptors.
- Cloud workload changes: read
  [`docs/plans/mc-v2-workload-allowlist.md`](plans/mc-v2-workload-allowlist.md)
  first. No route outside that fail-closed table is permitted.

## How work is organized

Work is **projects**, and a project is a `PLAN.json` on `main`. This is the same
shape in memoro; the difference is only which repository the plan lives in.

```
mc brief    → Martin answers open questions with a **Beslut:** line
mc plan     → a foreground session writes docs/project/<programme>/<name>/PLAN.json
mc run      → the runner takes one step of one ready plan, in a fresh session
mc merge    → the gate, then the squash
              close-out → project_log.md + docs/technical/
```

- **Plans live at `docs/project/<programme>/<project>/PLAN.json`.** There is one
  programme here, `mc`. One file: the overall part — `goal`, `contract`,
  `out_of_scope`, `success_criteria`, `what_the_code_taught_us`, `documents` —
  then `steps[]`, each carrying its own `instruction`, `done_when` and `status`
  (`ready` | `done` | `blocked` | `waiting-decision`). The plan has no status of
  its own: it is the state of the first step that is not done. See
  [`docs/project/README.md`](project/README.md).
- **You do not write plan state by hand.** `mc plan <name>` opens the session
  that writes one, with Martin in it. A step session edits its own step's
  `status` and `pr`, the criteria it met and `what_the_code_taught_us` — and
  `mc run` compares the file before and after, so a session that touched a step
  it did not run leaves a PR the runner will not merge.
- **You do not decide.** An open question becomes
  `~/mc/<workarea>/decisions/<programme>-<n>.md`: the question, the options, one
  recommendation, and no menu. Martin answers it in `mc brief`. That directory
  is outside git and does not survive its workarea, so a ruling worth keeping is
  carried into [`docs/project/mc/rulings.md`](project/mc/rulings.md) **before**
  the file is retired — `mc brief --collect` deletes an answered file once no
  plan is still waiting on it.
- **A workarea is `~/mc/<project>/memoro-cli`,** a worktree on branch
  `<project>` from `origin/main`. `mc` owns it: it is created by `mc plan` or
  `mc work add`, and closed by `mc run` in the round after its plan says `done`.
  Never remove one, or its branch, by hand.
- **`status: ready` is what starts the runner on a plan.** Nothing else is a
  queue. Do not set it on a plan that is not ready to be executed unattended.

## Working on this codebase as a coding agent

Load `.claude/skills/agent-coordination.md` only when work is actually
delegated across sessions or agents. It defines roles and handoffs; it does not
duplicate repository, testing, or publication rules from this protocol.

For focused work, inspect, implement, verify, and publish directly. For larger
work, agree on a concise contract covering outcome, scope, non-goals,
completion criteria, validation, dependencies, and escalation points. Resolve
uncertainty through read-only inspection before asking or guessing.

**Priming as coordinator** depends on your tool:

- **Claude Code:** run `/be-coordinator` (slash command at
  `.claude/commands/be-coordinator.md`)
- **Codex / GPT / any other:** prompt the agent with: *"Read
  `.claude/skills/agent-coordination.md` and
  `.claude/commands/be-coordinator.md`, then follow the priming
  instructions in be-coordinator to enter coordinator mode."*

The command performs one bounded state snapshot through the App-backed
`mc github` surface. It does not require a personal `gh` login or repeated
polling.

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
  (`docs/mc-command-matrix.md`, this file and its `canon/` copy) still goes
  in a final commit touching nothing else, and a series against it lands in
  order with `main` merged in between (a merge commit, no rewritten
  history). A change to `docs/coding-agent-protocol.md` must carry the same
  change to `canon/coding-agent-protocol.md`: the gate compares the two
  copies byte for byte and stopped two pull requests that forgot.

## Work Method Updates

When the user wants durable changes to how coding agents should work with
them, use `mc coding-profile read`, `mc coding-profile diff`, and `mc
coding-profile write` in dialogue with the user. Do not edit generated
adapter files, `AGENTS.md`, `CLAUDE.md`, or old repo roadmap files as a
substitute for the server-owned Coding Profile.

The expected loop is explicit: read the current profile with `--json`, discuss
the change, draft a full replacement Markdown profile, show the diff, and write
only after the user approves. When no profile exists, `read --json` returns
`base_revision: 0` plus `template_markdown` for the first revision.

A rule that should bind the next agent in a repository — a way of merging,
a way of running subagents, a thing never to do again — is written into
that repository's agent contract (`docs/coding-agent-protocol.md` here,
`AGENTS.md`/`CLAUDE.md` in memoro), in the section the next agent will be
reading when the rule matters. It is never left only in an agent's
per-project memory store: a memory is read by one agent, a repository file
by all of them. Ruled by Martin 2026-08-29 after a merge-gate rule had been
saved as a memory and nowhere else.

## Code conventions

- `src/mc/commands/<name>.js` for new `mc` subcommands (NOT
  `src/commands/`, which belongs to `memoro-cli` / `memoro`).
- `src/mc/` for mc-only subsystems (`registry.js`, `vault/`,
  `orchestration/`, `paths.js`, `git.js`, `adapter-sync.js`, …).
- Lazy import in `bin-mc.js` `LIFECYCLE` table — cold start matters
  because `mc` is called frequently from fanout flows.
- Tests mirror `src/` structure under `tests/`.
- Adapter contract: every `src/adapters/<tool>.js` exports
  - `ID` and `LABEL` — identity for sync + registry
  - `detect()` — soft signal that the user has the tool installed
  - `TOOL_NAME`, `STATUS_TIMEOUT_MS`, `getStatus()` — `mc auth
    status` probe (§11a)

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

- `docs/plans/credential-blind-capabilities.md` is the normative
  confidentiality and provider-execution contract. No mc vault secret may be
  exposed in plaintext to an LLM-controlled process, command, file,
  environment, argv, output, log, transcript, browser payload, credential
  helper, or inspectable peer process. Vault secrets back typed capabilities;
  they are never materialised for Codex, Claude, generic adapters, or repo
  dotenv files.
- `docs/plans/connected-capabilities.md` is the normative foundation for every
  external connection. GitHub, Cloudflare, LLM tools, and future providers
  share one connection registry, token-free descriptors, readiness/repair
  vocabulary, source/session binding, and short-lived broker-grant model.
  Provider commands, adapters, brokers, and executors must not import Keychain
  or mc vault code; only the common identity service may read the first-party
  local Memoro device identity.
- `docs/plans/github-app-capability.md` is the normative product and security
  provider contract. The target is one central Memoro GitHub App and the same
  typed mc broker operations for local and cloud sessions.
- GitHub credentials are not mc vault material. App private keys and durable
  connection authority stay in the Memoro control plane; short-lived
  installation credentials must never enter the coding-tool child environment,
  argv, files, prompt, transcript, logs, browser payloads, or session records.
- GitHub behavior belongs to mc core and its source/session broker, not an LLM
  adapter. All tools get the same token-free capability descriptor, operations,
  hard operation policy, errors, and compatibility surface. The coding-tool
  host applies the user's native approval settings to mutating invocations; mc
  does not store, override, or duplicate that preference.
- `mc github` is canonical. A session-scoped `gh` compatibility shim may map
  only allowlisted commands to typed broker operations. Never invoke or expose
  `gh auth token`, `gh auth status --show-token`, arbitrary `gh api`, GraphQL,
  extensions, or real-CLI passthrough inside the managed capability.
- The local host-keyring/preflight prototype is transitional and superseded by
  the central-App contract. Do not expand it or treat `MC_HOST_CAPABILITIES` or
  `MC_HOST_GH_BIN` as public interfaces. Cloud must work with the local machine
  offline, and neither source may fall back implicitly to a local `gh` login.

### Deterministic publication lifecycle

Use one bounded transaction for ordinary commit → PR → main work:

1. Inspect the current branch, complete diff, and base once. Reading the diff
   is the review; no test run gates this step.
2. Stage only intended files, commit, and freeze the exact local head SHA.
3. Publish only the registered session branch through the typed Memoro GitHub
   App operation advertised by the live session. Publication is non-force and
   expected-head/base guarded. If branch publication is not advertised, stop
   with the capability repair state; do not fall back to GitHub login, a host
   credential helper, raw authenticated `git push`, or per-file GitHub object
   reconstruction.
4. Create or update the PR through `mc github`. The PR description states what
   changed, why, user impact, root cause for fixes, and known gaps. It does not
   claim validation that was not performed.
5. Read one current PR/check/review snapshot for the frozen head. This
   repository currently has no automatic pull-request workflows; an empty
   checks result is terminal normal state, not a reason to poll. Never claim a
   hosted gate ran unless GitHub reports that exact head's run.
6. Review the final combined diff. After the required explicit merge approval,
   merge through the App with the exact expected head SHA and the repository's
   established merge method. Do not pass `--delete-branch`: whether the remote
   branch survives a merge is the repository's setting, not a session's
   decision. Some repositories delete it deliberately, to stop branches
   accumulating — that is not a fault to report or undo. The local branch and
   its worktree belong to `mc` and are never removed by hand.
7. Confirm the merge result once. Re-read or revalidate only when the head,
   base, diff, review state, or external condition actually changed.

The session-scoped `gh` shim is compatibility syntax for its advertised typed
operations, not native GitHub authority. `mc github` is the canonical wording
in instructions and diagnostics.

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
- `npm test` locally is the fast loop, but it runs 2 107 tests with no
  `--test-concurrency` cap and is load-flaky on this machine. A local red is
  worth re-running before it is worth reporting; the gate's verdict is the one
  that counts.

Two things this does **not** yet cover, both known and both written down rather
than left to be rediscovered:

- **The runner does not gate.** `mc run` lands a step's pull request with
  `mergePr` (`src/mc/run.js`), a raw `gh pr merge --squash`. Ruling `mc-test-1`
  ([`docs/project/mc/rulings.md`](project/mc/rulings.md) §4) replaces that path
  so the runner goes through `mc merge`; until it does, a runner-landed PR was
  not gated.
- **Never claim a run you did not make.** Say in the PR body what was run and
  what was not. "Suite not run" is an acceptable sentence; implying it passed
  is not.

## Critical paths — extra care

- `src/commands/auth.js` — Memoro keychain accounts, browser OAuth
  flow
- `src/commands/heartbeat-loop.js` — daemon with WebSocket reconnect
  policy (4003 'Replaced' is terminal — don't reconnect)
- `src/lib/device-flow.js` + `src/lib/keychain.js` — token issuance
  and macOS keychain access (§14)
- `src/mc/vault/` — provider-independent secret store (§12);
  client-side crypto + PreToolUse hook
- `src/mc/commands/end.js` + `src/mc/commands/delete.js` — session archival
  and explicit session-home deletion
- `src/mc/commands/cleanup.js` + `src/mc/owned-resource-cleanup.js` —
  destructive worktree, branch, and directory cleanup under exact provenance
- `src/mc/commands/new.js` + `src/mc/commands/resume.js` — re-exec
  the same mc binary in wrap mode (PR #30); changes here affect
  every "open a tool in a session" path
- `src/mc/commands/adapter.js` + `src/mc/adapter-sync.js` —
  materialises CLAUDE.md / AGENTS.md from this file; bugs propagate
  to every repo using mc-managed wrappers
- `src/bin-mc.js` — dispatcher strips wrapper-injected flags before
  routing; commands rely on the env-var default (PR #29)
- The shell wrapper template literal in
  `src/mc/commands/install-shell.js` — wrapper bugs land in every
  user's `~/.zshrc`; read the rendered wrapper before shipping

## What not to do

- Don't import a wrapper / dispatcher without checking that it loads
  (PR #28 lesson)
- Don't duplicate install-hint strings (they belong in adapter
  `getStatus()` only)
- Don't make `mc` / `mc auth status` print to stdout in a way
  that breaks `--json` consumers
- Don't guess on design with 2+ reasonable options — raise a decision
  file (`~/mc/<workarea>/decisions/<programme>-<n>.md`) with one
  recommendation and let `mc brief` answer it. A menu of options is not a
  decision file; if you cannot recommend one, investigate further first
- Don't add `--non-interactive` flags to commands that are already
  non-interactive by default
- Keep `CLAUDE.md` / `AGENTS.md` thin. They are hand-edited wrappers
  around this file: put repo conventions here and reflect them there.
  Use `mc coding-profile read|diff|write` for durable user work-method
  changes — those are the user's, not the repository's.

## Per-tool surface (what each tool reads natively)

| Tool | Reads | Notes |
|---|---|---|
| Claude Code | `CLAUDE.md` (root) + `.claude/skills/`, `.claude/commands/`, `.claude/hooks/`, `.claude/settings.json` | Full native support today |
| Codex / GPT | `AGENTS.md` (root) | Markdown only; skills and slash commands are read manually via the prompt above |
| Gemini CLI | none yet | no verified project-instruction convention |

mc writes none of these files. The user's Coding Profile is handed to a new
conversation as a launch argument — `--append-system-prompt` for Claude,
`-c instructions=` for Codex — and a resumed conversation already has it.
Existing sessions change tool only when relaunched with
`mc resume <name> --codex` / `--claude`; a running TUI cannot switch tool
in place.
