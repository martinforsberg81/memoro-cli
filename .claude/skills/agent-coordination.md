---
name: agent-coordination
description: Patterns for splitting work between a coordinator session and one or more implementation/spawned sessions. Load when about to delegate a multi-PR feature, when receiving a delegated task, or when planning to use mc spawn / mc fanout.
---

# Coordinator ↔ Agent coordination

This skill codifies a working pattern observed on 2026-05-27 — 28: one
coordinator session designed a 7-segment delivery, an implementation
session executed it across 7 PRs in 24 hours, +89 tests with zero
regressions. The pattern is now the contract for any future
coordinator-spawned work, including future `mc fanout` / `mc spawn`
agents (per `docs/plans/worktree-lifecycle.md` §10).

## Roles

**Coordinator** — owns the plan, design intent, and merge authority.
Holds the long context. Answers design questions. Reviews PRs.
Doesn't write production code in this role.

**Implementation session (agent)** — owns the build. Reads the plan,
asks design questions up front, codes one PR per drev segment, logs
judgment calls in the PR body, reports back with a one-line stats
summary plus a PR link.

Either role can be a human or an LLM. The contract is the same.

## The 7-step loop

```
1. Coordinator delegates  → scope + spec pointers + reminders
2. Agent reads + plans    → all design questions up front
3. Coordinator answers    → recommended option + rationale + subtlety
4. Agent implements       → small focused PR with tests first
5. Agent reports          → PR link, stats, judgment calls in body
6. Coordinator reviews    → spot-check judgment calls, merge or flag
7. Iterate until drev done
```

Steps 2–3 may repeat for a single drev (more questions surface mid-
implementation). Steps 4–6 produce one PR. Steps 1–6 produce one drev
(one logical scope of work).

## Step 1 — Delegate

A good coordinator handoff has four parts:

1. **Scope** — what segments of the plan are in / out
2. **Spec pointers** — exact section numbers in the plan file
3. **Reminders** — established patterns the agent should re-use
4. **Eskaleringsväg** — "come back to coordinator when X"

Template:

```
We're starting implementation drev #N against
docs/plans/<plan>.md. Scope:

- §X.a, §X.b, §X.c

Reminders from prior drev:
- Pattern A (with one-line reference)
- Pattern B
- ...

Deferred from this drev: §Y (reason)

Read the plan + ask all design questions up front before writing
code. Log every judgment call in the PR body (the TDD-style
pattern from PR #21). Come back to coordinator for any decision
that has 2+ reasonable options. Send the PR link when ready.
```

Anti-pattern: terse one-liners like "implement §11". Forces the
agent to guess, makes the loop noisy.

## Step 2 — Read + plan + ask up front

The agent reads the plan, then surfaces every ambiguity as a
multi-option question **before writing code**. Disciplined "ask vs
guess" is what keeps the loop tight.

The threshold:

- **Decide silently:** the answer is in the plan, or there's one
  obviously-correct option, or it's a trivial implementation detail
  with no design impact.
- **Ask coordinator:** there are 2+ reasonable options with
  different downstream consequences, OR the plan is ambiguous, OR
  the answer affects the public surface.

Format each question as numbered options with a recommendation:

```
Q3: Where should the X live?

❯ 1. Under src/foo/ (Recommended)
     Rationale.
  2. Under src/bar/
     Different rationale.
  3. Type something.
```

In the agent run for §11 the agent surfaced 5 such questions before
writing a line of production code. Every answer became spec; no
guesses leaked.

## Step 3 — Coordinator answers structurally

Each answer has four parts:

1. **Choice** — alt N (with "+" if hybrid)
2. **Rationale** — 2–4 bullets, why
3. **Subtilitet att skicka tillbaka** — one extra design nuance the
   agent should fold in beyond the alt itself
4. **Action line** — exact words for the agent (often: "Säg till
   sessionen: alt N, plus X. Fortsätt med nästa fråga.")

The *subtilitet* part is what makes design quality propagate without
the original spec needing every edge case. Example: when answering
"adapter status probe location", the alt was "extend existing
adapter file". The subtilitet added: "Two separate functions
(detect + getStatus), not one — they have different latency
budgets." The agent implemented that distinction even though it
wasn't in the question.

## Step 4 — Implement, small + focused

One PR per drev segment. Tight scope. Tests first (TDD spec
pattern).

Files-changed sweet spot from drev 2: 3–7 files per PR.

If a "while I'm at it" temptation arises, fold it only if it's a
known coordinator-approved follow-up (e.g. the orphan-count one-liner
folded into #34). Otherwise: separate PR.

## Step 5 — Report with judgment calls

Every PR body has these sections:

```markdown
## Summary
- 3–5 bullets, what shipped + why

## Judgment calls
- **Decision in bold.** Why I made it. Trade-off considered.
- (one bullet per non-obvious choice)
- Pre-existing flake (if any) noted as not introduced by this PR

## Test plan
- [x] Pure unit tests: N cases covering …
- [x] CLI integration tests: M cases covering …
- [x] Full npm test: X/X pass
- [ ] Manual: thing the coordinator should verify post-merge

## Follow-ups
- Item the coordinator may want next
```

The **judgment calls section is the load-bearing one.** It lets the
coordinator review in two minutes instead of twenty. It lets future
readers know *why* a non-obvious choice was made. It prevents
regression — a future change to that area must engage with the
documented reasoning.

If the agent has nothing in this section, the work was either
trivial (rare) or under-considered (much more likely).

## Step 6 — Coordinator reviews

Review heuristic:

1. **Read the judgment-calls section.** This is 80% of the review.
2. **Check files-changed against scope** — drift = flag.
3. **Tests pass + new tests proportionate** to changes — if 200
   lines of code landed without new tests, ask.
4. **Spot-check 1–2 key files** — usually the pure helper or the
   contract test. Don't read every line.
5. **Look for the patterns** — was authority-lives-in-the-verbs
   honored? Were dep-portals injected? Etc.

A solid PR can be reviewed and merged in 5 minutes. A solid drev
(7 PRs) in under 45 minutes total review.

## Established technical patterns (engineering)

These were observed across drev 1 (foundation) + drev 2 (polish +
onboarding). Use them by default in any new mc work; deviate only
with documented reason.

1. **Authority lives in the verbs.** Docs, error messages, and
   output footers point at the canonical mc verb (`mc setup`,
   `mc end`, etc.) as the source of truth. Never duplicate their
   logic in docs or hints — if `mc setup` changes, the docs
   automatically stay correct. Established in §11e, propagated to
   mc reconcile output footer without prompting.

2. **Injectable dep-portals with soft-degrade.** Every external
   syscall (`gh`, file-system, `kill`, `which`, network) is taken as
   an injection parameter with a default that silently degrades
   (returns `[]` / `null` / `false`) on failure. Tests inject stubs;
   prod gets the default. Established in #32; applied through #38.

3. **Exit-before-side-effect.** Argv validation → preflight checks →
   side effects, in that order. `mc new` checks fresh-install state
   *before* touching git. `mc reconcile --apply` rejects missing
   `--only-safe` *at parse time*, before reading the registry. No
   half-states on failure.

4. **Pure-helper export for in-process tests.** Pure logic
   (heuristics, classification, path computation, format decisions)
   is exported separately and tested in-process. Subprocess CLI
   tests stay on deterministic red branches. This sidesteps the
   "real keychain / real network / real registry" testing wall.
   Example: `missingSteps(report)` and `writeSentinel()` from #35,
   `classifyEntries(deps)` from #38.

5. **"Install with: <command>" prefix DRY.** Adapter `getStatus()`
   returns user-facing hint strings; `mc setup` parses the prefix
   and promotes the rest to a checklist row. Single source of
   truth across `auth status` / `auth <tool>` / `setup` / README.
   When the install command for a tool changes, you change it
   once.

6. **Real-data validation for filesystem conventions.** Path
   encoders / decoders / glob patterns are validated against
   *actual* on-disk layouts before being asserted in tests. Test
   fixtures miss edge cases like the `/.` → `--` double-hyphen
   in `~/.claude/projects/` paths (caught in #38). When touching
   anything FS-related, do a `find` or `ls` against the real
   layout first, then encode the test.

7. **Defensive `--apply` parsing.** Auto-applying verbs require an
   explicit narrowing flag (`--only-safe`, `--only-X`). Plain
   `--apply` is rejected with an error explaining what v1 supports.
   Prevents future "I assumed it was always safe" footguns when
   more action buckets land.

8. **Subprocess test hygiene: env-scrub + `close` event.** Test
   helpers that spawn subprocesses must (a) explicitly scrub env
   vars that flip CLI I/O routing
   (`MC_EMIT_SHELL_DIRECTIVES`, `MEMORO_MC_PARENT`, `MC_TEST_MODE`)
   so a test runner running inside an mc-wrapped shell doesn't
   inherit state, and (b) wait on the `close` event (stdio drained)
   rather than `exit` (process terminated), or trailing output is
   silently truncated. The two together is what unflaked
   `tests/mc/lifecycle/cd.test.js` in PR #34.

## Meta-patterns (process)

9. **Ask-vs-guess discipline.** Agent guesses zero times on
    design. Anything with 2+ reasonable options → ask coordinator.
    Anything with a clear answer in plan or one-obvious-right →
    decide. This single discipline is what makes the loop tight.

10. **Subtilitet att skicka tillbaka.** Coordinator's answer to a
    design question always adds one nuance beyond the alt
    selection. Design quality propagates without the original spec
    needing every edge case.

## Anti-patterns observed (don't repeat)

- **Template-literal backticks in code.** Inline backticks in
  comments inside a `String.raw\`...\`` template literal terminate
  the literal early. Use double-quotes in such comments. (PR #25
  → PR #28.)
- **Wrapper not importing the module it wraps.** Tests for code
  paths require *importing* the module under test, not just
  spawning a subprocess that loads it indirectly. Syntax errors
  in install-shell.js shipped because no test ever imported it.
  (PR #28 added the smoke test.)
- **fd-3 redirect to fd 3 instead of skipping.** `2>&3` after
  `3>&1 1>&2` captures stderr into the eval buffer. Don't
  redirect stderr at all if you only want fd 3. (PR #24.)
- **Wrong binary in the shell wrapper.** `command memoro-cli` ≠
  `command mc`. They are two different binaries in the same
  package. (PR #25.)
- **Passing wrapper-injected flags through to subcommands.**
  Strip them once at the dispatcher, lift to env var, let
  emitCd-style helpers pick them up by default. (PR #29.)

The pattern under these: **a wrapper that affects every invocation
must be tested by importing + invoking, not by manual `mc list`
after install.** Add smoke tests for any wrapper / dispatcher / glue
code that gets installed into the user's shell.

## CLAUDE.md pointer

Project-wide instructions live at `CLAUDE.md` in the repo root and
should include a one-line pointer here:

> For multi-agent or multi-PR work, load
> `.claude/skills/agent-coordination.md` first — it codifies the
> coordinator ↔ agent loop and the engineering patterns established
> across drev 1 + drev 2.

## When this skill is most useful

Load explicitly (via the skill mechanism or by reading the file)
when:

- You're about to use the `Agent` tool to spawn subagents
- You're about to use `mc spawn` / `mc fanout` once §10 lands
- A request mentions "coordinate", "delegate", "fan out", or
  "implementations-session"
- You're working in `~/memoro-cli/` and reading the plan file

Auto-loading depends on the harness; today's Claude Code loads
skills on slash-command invocation. Future runtimes (notably
`mc spawn`) should treat this file as a required preamble for any
spawned agent.
