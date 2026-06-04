---
name: agent-coordination
description: Patterns for splitting work between a coordinator session and one or more implementation sessions. Load when about to delegate a multi-PR feature, when receiving a delegated task, or when using an available agent tool from a grounded coordinator session.
---

# Coordinator ↔ Agent coordination

This skill codifies a working pattern observed on 2026-05-27 — 28: one
coordinator session designed a 7-segment delivery, an implementation
session executed it across 7 PRs in 24 hours, +89 tests with zero
regressions. The pattern is now the contract for any future
coordinator-delegated work through whatever agent surface the host tool
provides.

## Roles

**Coordinator** — owns the plan, design intent, and merge authority.
Holds the long context. Answers design questions. Reviews PRs.
Doesn't write production code in this role.

The coordinator has three targets: keep roadmap/end-goal awareness alive,
preserve orchestrator-role discipline, and maintain cross-session
work-project order through `MEMORO.md`, session state, worktrees, branches,
and tool choice.

**Implementation session (agent)** — owns the build. Reads the plan,
asks design questions up front, codes one PR per drev segment, logs
judgment calls in the PR body, reports back with a one-line stats
summary plus a PR link.

Either role can be a human or an LLM. The contract is the same.

## Why the orchestrator role exists (read this before acting as one)

The mechanics below — the 7-step loop, the patterns — are downstream of
two purposes. If you lose these, you've lost the role and the loop
becomes empty ritual. They are why the project fans work out to agents
**even when the coordinator could just do it inline:**

1. **Protect the orchestrator's context.** The coordinator's scarcest
   resource is its own attention and context window — that is what holds
   the plan, the design intent, and the bird's-eye view across many PRs.
   Implementation detail (which file, which flag, the diff, the test
   output) *pollutes* that context and degrades the very judgment the
   role exists to provide. Detail work is pushed OUT to agents whose
   contexts are disposable; the orchestrator stays high-altitude on
   purpose. **Symptom you've dropped altitude:** you're reasoning about
   how a function is wired, or which option a verb takes, instead of
   whether the slice is the right slice. When you catch that, stop — the
   detail belongs in a brief, not in your context.

2. **Writing the brief is the quality mechanism.** When an LLM must
   write a prompt for *another* LLM, it is forced to make intent
   explicit, complete, and bounded — it takes ownership of the whole.
   Doing the same work in one session collapses planning and execution
   into a single stream where the critical eye is lost: the model that
   is heads-down implementing cannot simultaneously be the skeptic
   examining intent. The split *manufactures* critical distance. A
   worse-but-examined design beats a faster-but-unexamined one — which
   is why "just do it here" is the wrong default for non-trivial work
   even when it's available.

`mc` exists to serve both by making the coordinator wake grounded. The
coordinator session then externalises intent into briefs and sends work
through the agent tools already available in the host. Everything else in
this file is in service of these two purposes. Load them before you start
coordinating, not after you've drifted.

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

## Why this loop mitigates LLM failure modes

LLMs have two opposing failure modes with the same root cause:

- **Lazy**: silent skipping under time/effort pressure. "Tests
  don't apply here", "this edge case is uncommon", placeholder
  strings shipped as done.
- **Over-eager**: "while I'm at it" creep, unrequested
  abstractions, refactors that weren't asked for, gold-plating.

Both come from **underspecified prompts** — the model fills in
from its own priors when "done" is ambiguous, picking its own
threshold (lazy or eager depending on the day).

The 7-step loop mitigates both via six mechanisms:

1. **Coordinator is allowed to be slow + thorough.** Different
   cognitive load than the builder. Can think through edge cases
   while the worker focuses on shipping.
2. **Up-front design questions kill ambiguity.** When the worker
   asks "alt 1/2/3" before coding, the choice is locked
   explicitly. It can't be silently skipped (it was answered) and
   can't be over-built (the alt is bounded).
3. **PR-body judgment-calls forces honesty.** A worker that
   silently skips something must explain *why* in the body.
   Laziness becomes visible. Scope-creep becomes flaggable
   ("I added X because…").
4. **TDD spec as definition of done.** "Done" = "tests pass". No
   vibe-based completion. The worker can't claim done with
   unmet requirements.
5. **Coordinator review catches scope drift.** 200 lines when 50
   were asked → review flags. 50 lines when 100 were needed →
   tests fail → review flags.
6. **Fresh worker context per drev.** Worker sessions are
   short-lived; no accumulated bias. Coordinator owns the long
   context.

The deeper structural insight: **LLMs work better with a peer
than a manager.** Manager-LLM (gives orders) → blind to own
errors. Helper-LLM (serves) → accepts vagueness, fills in too
much. **Peer-LLM with different stakes and a different time
budget → friction → quality.**

In the coordinator/worker split, the coordinator owns design
quality (does the review), the worker owns shipping velocity
(does the build). The tension between the two roles produces
output neither would alone. This is the load-bearing insight
that makes the protocol work — preserve it as you evolve the
specifics. If the loop ever feels ritualistic, the peer dynamic
is what to re-establish first.

## Drev sizing + risk assessment

Empirical from drev 3 + 4 (the first two fully-autonomous agent
drev runs against this repo):

| Drev | Scope | Files | Time | Tokens | New tests | Judgment calls |
|---|---|---|---|---|---|---|
| 3 — vault phase 1 | 10 verbs, crypto port | 10 | 17 min | 165k | 35 | 7 |
| 4 — vault phase 2 | keychain + JIT + adapter ext | 16 | 23 min | 203k | 42 | 9 |

Approximately linear scaling: 60 % more scope ≈ 35 % more time.
Strong signal that drev-scale tasks fit within one agent invocation
when properly briefed.

**Risk axes that matter when sizing a drev:**

1. **Single-repo vs cross-repo.** Single-repo (drev 3, drev 4) is
   lower risk: one PR, one merge, one test suite to run. Cross-repo
   (server + client changes together, e.g. §14 phase 1+2) introduces
   coordination cost, deploy timing, and rollback complexity. **Split
   cross-repo drev into single-repo sub-drev when possible.**
2. **Live deploy required vs not.** Drev that needs a memoro server
   deploy can't be smoke-tested before deploy. Higher risk. Split
   server-side changes into a separate drev that the coordinator
   reviews + deploys before client-side lands.
3. **Touches user-global config (e.g. `~/.zshrc`, `~/.claude/settings.json`).**
   Higher risk because bugs land in every session. Require importing
   smoke tests (per anti-pattern below). Drev brief should call out
   the user-global surface explicitly.
4. **Cryptographic / security-critical code.** Drev 3 ported existing
   crypto with byte-identical verification. Lower risk than designing
   new crypto, but still requires golden-value tests as the gate.
5. **Hooks into the host LLM TUI.** PreToolUse hook installation
   touches host-specific machinery. Either confine to project-scoped
   `.claude/settings.json` (per worktree) or split into a coordinator-
   verified follow-up.

**When to split a drev:**

- Any combination of cross-repo + live deploy + user-global config →
  split.
- Any single dimension scoring "high risk" → coordinator should
  verify each sub-drev before next one starts.
- A drev with no high-risk dimensions can ship autonomously with
  coordinator review-only at the PR stage.

The drev 4 brief explicitly excluded the PreToolUse hook (§12 phase 3)
*because* it would have crossed the user-global config axis. That
exclusion is what kept drev 4 single-repo + autonomous-safe.

## Step 1 — Delegate

A good coordinator handoff has four parts:

1. **Scope** — what segments of the plan are in / out
2. **Spec pointers** — exact section numbers in the plan file
3. **Reminders** — established patterns the agent should re-use
4. **Eskaleringsväg** — "come back to coordinator when X"

Template (used in drev 3 + 4; refine as the project evolves):

```
You're implementing drev #N against <repo>. Work in <absolute path>.
The coordinator session that spawned you cannot answer mid-run
questions — read this brief as your complete contract.

## First: load the protocol
1. CLAUDE.md + docs/coding-agent-protocol.md
2. .claude/skills/agent-coordination.md (this file)
3. The plan section(s) in scope
4. Read-only references the drev depends on

## In scope (positive)
- Bullet per sub-feature with one-line "what" + "why"

## NOT in scope (negative — same weight as positive)
- §X (reason: belongs to drev N+1)
- §Y (reason: cross-repo, separate split)
- (anything else worth pre-emptively forbidding)

## Critical engineering constraints
- Predictable platform / edge-case gotchas the coordinator wants
  prescribed up front. Drev 4's "embedded expiresAt in cache value
  because OS-keychain TTL varies" is the form.
- Hard gates (e.g. "extend contract test to enforce X").

## Security expectations (gate before ship)
- Anything that, if it slips, leaks secrets / corrupts user state /
  bricks a live system.

## Workflow
- Branch name, single PR vs split, no-merge.

## Design questions — if any
- STOP at the decision point. Continue with unblocked work.
  Surface question(s) in the final report with options + recommended.

## Final report shape
- Status (PR URL, tests, branch)
- What shipped (one-liner per sub-feature)
- Open design questions (if any)
- Judgment calls (the obvious ones; full set in PR body)
- Deferred / blocked
```

Anti-pattern: terse one-liners like "implement §11". Forces the
agent to guess, makes the loop noisy.

**The "NOT in scope" section is load-bearing.** Drev 3 + 4 both
respected it verbatim, which is what kept their scope tight.
Coordinator should think harder about what to forbid than about
what to permit — the agent's natural failure mode (over-eager
scope creep) is blocked at this gate.

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
- **Any acceptance criterion you could NOT verify yourself**
  (because a security hook blocked a read, an external system
  was unreachable, or you lacked credentials) — explicitly here,
  not buried elsewhere. Pattern 12 in this skill.
- Pre-existing flake (if any) noted as not introduced by this PR

## Test plan
- [x] Pure unit tests: N cases covering …
- [x] CLI integration tests: M cases covering …
- [x] Full npm test: X/X pass
- [ ] Manual: things the coordinator should verify post-merge,
      especially anything an uncertainty disclosure above flagged

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

11. **Negative requirements in delegation prompts.** Positive
    requirements ("build X") leave room for additions. Negative
    requirements ("build X, do NOT add Y or Z, if tempted stop
    and ask") read tighter and bind better. Use both: state what
    to build, state what NOT to build, state when to escalate.
    The drev 2 coordinator prompts paired positive spec with
    explicit "deferred from this drev" lists — that's the form.
    Models read negative constraints more carefully than positive
    ones; lean on them when the natural failure mode is creep.

12. **Honest uncertainty disclosure.** When verification of an
    acceptance criterion is blocked (security hook denies a read,
    external system unreachable, missing OAuth credential, etc.),
    surface it explicitly in *both* judgment calls AND the report's
    follow-ups. Never silently ship "verified" when you couldn't
    actually verify. Drev 4's claude-code on-disk shape is the
    template — the agent flagged "I couldn't read the actual file;
    I trusted the drev 3 documented shape; coordinator should do a
    real smoke before phase 3" *as a judgment call*, not buried in
    a follow-up. That clarity is what makes the disclosure
    actionable. Zero open questions is suspicious; zero open
    questions + zero uncertainty disclosures on a non-trivial drev
    is a smell.

13. **Architectural self-upgrades (bounded).** When the agent
    identifies a DRY opportunity (shared helper), an extensibility
    seam (e.g. `cacheAccountFor(identity)` reserved for future
    per-user scoping), or a portability concern (embedded
    `expiresAt` because OS-keychain TTL semantics vary), ship the
    improvement with a one-line PR-body explanation. **But: this
    is bounded by anti-gold-plating.** The test: would a skeptical
    reviewer ask "why is this here?" If yes, document the why. If
    you can't justify it in one PR-body line, you're gold-plating
    — don't ship it. Drev 4's `_materialise.js` shared helper
    passes this test (DRY across claude-code + codex, file mode
    0600 invariant); a hypothetical "I made the registry pluggable"
    would not.

14. **Parallel agents — safe when briefs are disjoint.** Drev 5a
    (mc PreToolUse hook for vault paths) and 5b-server (memoro
    Device Flow endpoints) ran fully in parallel in separate repos.
    Both shipped clean PRs, zero cross-contamination. The conditions
    that made it safe: (a) briefs touched mutually exclusive file
    paths, (b) neither's acceptance criteria depended on the
    other's output, (c) both got the same coordinator-protocol
    priming so divergence on conventions was bounded. When briefs
    share files or one's output is the other's input, sequence them
    instead — the parallel saving is small and the merge-conflict
    risk plus design-drift compound. The heuristic: parallel-safe
    if you can describe each agent's "done" without mentioning the
    other.

15. **Which-layer-fired verification.** When testing a security
    hook or gate, prove *the specific layer under test* fired —
    not just "the deny happened". Drev 5a's smoke test tried to
    read a materialised vault path under the new per-session
    PreToolUse hook; the read got denied — but the global
    `~/.claude/hooks/block-secret-reads.sh` caught it first, so we
    couldn't tell whether the new hook worked at all. When you set
    up the test, isolate the layer (disable upstream hooks
    temporarily, route through a path only the layer under test
    matches, or assert on the layer's own stderr/log signature).
    Otherwise you've verified that *something* denies — not that
    the thing you just shipped denies. A sub-case of pattern 12
    (honest uncertainty disclosure): "verified" must mean
    "verified the right mechanism".

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
- **Test-only the `--json` path for errors.** Drev 3 shipped vault
  with 35 new tests but every error test asserted JSON shape. The
  non-JSON path silently swallowed errors when an `emit()` helper
  was missing a `humanLine` arg, so `mc vault setup` with a bad
  password printed nothing and the user saw a stale status with
  no clue why. Tests MUST cover the human-readable path too —
  errors on stderr must be asserted in non-JSON mode. (PR #48.)

The pattern under these: **a wrapper that affects every invocation
must be tested by importing + invoking, not by manual `mc list`
after install.** Add smoke tests for any wrapper / dispatcher / glue
code that gets installed into the user's shell. The non-JSON error
path is the equivalent for command output — tests must drive a
failing input through the path the user actually sees, not just
the JSON variant.

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
- You're about to use an equivalent agent surface in another host tool
- A request mentions "coordinate", "delegate", "fan out", or
  "implementations-session"
- You're working in `~/memoro-cli/` and reading the plan file

Auto-loading depends on the harness; today's Claude Code loads
skills on slash-command invocation. Other runtimes should treat this
file as a required preamble for any delegated implementation agent.
