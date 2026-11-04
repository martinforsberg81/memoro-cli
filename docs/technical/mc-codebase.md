# The memoro-cli codebase

Facts about this repository's own code that hold whoever works on it. How to
work — test, publish, merge, resolve a conflict, write a proposal — is not
here: it is the mc skill, `canon/SKILL.md` ([mc-skills.md](mc-skills.md)),
and what a role session is told is `canon/roles/` ([mc-roles.md](mc-roles.md)).
This file replaced `docs/coding-agent-protocol.md` on 2026-11-02 (goal
`agent-skills-text`), keeping its facts about the code and moving its working
rules into skills.

## What the repository is

`memoro-cli` ships one binary, `mc`, and is private: `npm publish` refuses it.
Node 22+, ESM, `node --test`. `mc` runs Martin's coding work: one page (bare
`mc`), plans and goals under `~/mc/programs/`, a runner that takes their work
in fresh headless sessions, and one door that work lands through. It is built
for that one user (D-0205); a feature that does not serve it does not belong
here.

`src/` used to be mostly a session manager — a registry, a broker, a PTY host,
managed providers, cloud runtimes — 71 % of it unreachable from the page and
its verbs when measured on 2026-08-29. `mc-cut` removed it on 2026-09-03; what
survives that no verb reaches, and why, is [mc-cut.md](mc-cut.md). Do not
assume a module is live because it exists: `npm run reach` answers that, and
its last row should read `0%`.

- Two commands (`package.json` `bin`): `mc` → `src/mc-cli.js`, the page and its
  verbs, falling through to `src/bin-mc.js`, whose whole table is `mc vault`;
  and read-only `mc-admin` → `src/mc-admin-cli.js`, which delegates its fixed
  dashboard child through `mc keys run` (see [mc-admin](mc-admin.md)). The
  `memoro` and `memoro-cli` binaries went with ruling 24.
- `docs/plans/` holds only the custody design `mc vault` still implements
  ([mc-custody.md](../plans/mc-custody.md), [vault-import.md](../plans/vault-import.md)).
  Nothing there is an instruction.

## Code conventions

- A new subcommand is `src/mc/commands/<name>.js`, added to the `modules` map in
  `src/mc-cli.js` — not `src/bin-mc.js`.
- `src/mc/` holds mc's subsystems; `src/vault/` is the vault engine, the one
  subsystem kept without a verb reaching all of it.
- Cold start matters: `mc` is typed constantly, so a verb's module is imported
  when it is routed to, never at load.
- Test strategy and construction: read the mc task reference (source:
  [`canon/tasks/writing-tests.md`](../../canon/tasks/writing-tests.md)).
  Test authority is assigned by the canonical session roles.
- Tests mirror `src/` under `tests/`. `tests/_isolate-home.mjs` answers every
  git a test spawns from the model in `tests/mc/_helpers/fake-git.js`; a file
  that reaches real git ends red. Files that need git's own behaviour are named
  in `tests/_real-git-files.mjs`, a list that only shrinks.
- `src/adapters/index.js` is the launch adapter every verb that starts a tool
  goes through (`resolveLaunch`), so no verb spells out `claude` or `codex`.
- Don't add a verb nothing reaches, or leave a module nothing reaches. Don't
  import a wrapper without checking that it loads (PR #28). Don't print to
  stdout in a way that breaks `--json` consumers. Don't add `--non-interactive`
  to a command that already is.

**A reason says what was measured, not what was inferred.** Every refusal,
verdict and status line mc prints is read as a fact by somebody who cannot see
what it read, so the sentence claims exactly what the reading supports. The
case that set the rule (2026-08-22): the wake guard read text after the prompt
mark and said *there is already something in its prompt*, but a pane redraws
old orders there; it now says *something is drawn in its prompt — a draft, or
a ghost only a wake can tell apart*. When a reading is uncertain, say
*unknown* or *drawn*, never the confident neighbour of what you know.

## Shared documents and the changelog

Every pull request here used to write one entry in `CHANGELOG.md` and one row
in `docs/mc-command-matrix.md`, so any two conflicted on every gate round
(#366–#368, 2026-08-22). A pull request adds a fragment,
`changelog.d/<topic>.md` (see `changelog.d/README.md`), and never touches the
Unreleased section; `node scripts/changelog-fold.js` folds them at release.
Another shared document (`docs/mc-command-matrix.md`) changes in a final
commit that touches nothing else.

## The door to main

`mc merge <repo> <pr>` runs the round in `src/mc/repo-gate.js`; there is no way
to merge a red one — no flag, option or environment variable
(`src/mc/repo-merge.js`). Red is a set of failing test names against a ratchet
floor (`src/mc/tap-red.js`, `src/mc/red-ratchet.js`), never a count, so a
standing red name does not block an unrelated change and a new one does. The
runner lands through the same door: `runMergeRound`, in its own process, and a
row reads `merged` only when GitHub says the base it landed on was `main`.

## Credential boundary (normative)

Treat the coding agent and every model-directed surface as adversarial: the
model context and tool results; commands and child processes it directs; their
files, mounts, environment, argv, streams and history; process, socket and
`/proc` inspection; PTY output; logs, errors, status, transcripts and browser
payloads; and any helper an agent can repurpose as a credential proxy. The
explicitly approved `mc keys run` interface is a trust exception for scripts
and dependencies invoked through it, not a sandbox or a trust grant to other
session-directed executors.

- No raw secret, login artifact, provider token, CRK, DEK, recovery material or
  reusable credential authority may enter the adversarial domain. `mc keys run`
  is the approved exception that delivers the shared dotenv entries to trusted
  Node scripts and their dependencies, as documented below. No other command,
  debug surface, fixture, adapter, environment variable or repo file may make
  one available to the adversarial domain.
- `mc vault`, custody administration, device and keychain access and provider
  transports are trusted subsystems outside it. The model gets only opaque
  handles, bounded typed operations and redacted results, and cannot choose an
  arbitrary secret, destination, command or request body through them.
  `mc vault get` and `mc vault bind` refuse for this reason.
- `0600`, hooks, redaction, environment scrubbing, TTLs and shredding are
  defence in depth, never the boundary. The boundary is enforced separation of
  principals, namespaces, mounts, process inspection, sockets, IPC and egress.
- Script and dev-server credentials reach project code through `mc keys run`
  or `mc keys serve`, using the shared dotenv source and trusted project code.
  The script or server and its imports
  receive all entries in their child environment; there are no per-script
  declarations or source-closure checks. Output filtering is accidental-output
  protection, not a sandbox, and same-user processes are not isolated. Values
  do not enter the parent/session environment or audit records
  ([mc-keys.md](mc-keys.md)). This is separate from Memoro vault custody and
  does not weaken C1 or production/admin boundaries.
- A tool that cannot keep its credential out of the model-directed executor is
  unsupported for managed bootstrap and fails closed: no fallback to
  interactive login, a tool-home auth file, a generic token or dotenv.
- GitHub credentials are not vault material, and a session uses the machine's
  own `git` and `gh` (`mc github` and its shim went with mc-cut). Never read or
  print `gh auth token` or any token `gh` holds, and never put one in a file,
  environment variable, argv, log or PR body.

## Critical paths

- `src/mc/repo-gate.js`, `src/mc/repo-merge.js` — the only door code lands
  through. A bug lands a red tree, or lands it on the wrong base.
- `src/mc/run.js`, `src/mc/run-plan.js` — the runner, spending unattended
  sessions on what these decide, in two repositories at once.
- `src/mc/goals.js`, `src/mc/commands/goal.js` — validated goal records,
  criteria, phases and forward-only stage moves.
- `src/mc/work-area.js`, `src/mc/goal-archive.js`, `src/mc/tidy.js` —
  destructive worktree, branch and directory work under exact checks.
- `src/mc/push-guard.js`, `src/mc/branch-landed.js` — what stops a push over
  work that has landed.
- `src/vault/engine/` — the secret store: client-side crypto, custody, the C1
  lease. `src/lib/device-flow.js`, `src/lib/keychain.js`,
  `src/lib/auth-accounts.js` — token issuance and the keychain account names
  (`memoro-api-token`), kept so no stored token is orphaned.

## What each tool reads

mc writes no instruction file. A role reaches a session it launches as a launch
argument — `--append-system-prompt` for Claude, `-c instructions=` for Codex
(`src/mc/portrait.js`) — with no `CLAUDE.md`, `AGENTS.md` or memory loaded
beside it. A session opened by hand reads the repository's `CLAUDE.md` (Claude
Code) or `AGENTS.md` (Codex), and both tools read mc's installed skills. A
conversation's tool is chosen when it starts and cannot switch in place.
