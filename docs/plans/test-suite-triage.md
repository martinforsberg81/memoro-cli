# Test-suite triage: what is still red, and what has to be decided

**Status:** proposed · 2026-08-13 · open decisions, no owner assigned

The suite failed 85 times on `main`. PR #336 took it to 42 by fixing what could
be fixed without a scope call. This document records what is left, because each
remaining group needs a decision about the product rather than a change to a
test.

| | |
|---|---|
| Before | 1527 pass · **85 fail** |
| After PR #336 | 1555 pass · **42 fail** · 10 skipped |

---

## Already settled (PR #336)

Recorded here so nobody re-derives it.

- **The shared CLI helper drove the wrong binary.** `tests/mc/_helpers/cli.js`
  spawned `src/bin-mc.js`; the session verbs moved to `src/mc-cli.js` when that
  became the binary `package.json` installs. Every such verb exited 2 —
  *unknown command*. One line, 19 failures.
- **`fanout-cli`, `reconcile-cli`** — deleted. They drove commands the command
  matrix lists as removed; no router entry, no implementation module.
- **`squash-phantom`** — skipped, not deleted. It is a TDD spec for
  `src/mc/squash-phantom.js`, which was never written.
- **`bin-mc.test.js`** — could not be imported: eleven named imports from a
  module exporting two, nine of which exist nowhere in `src/`. The two live
  units kept coverage in `tests/mc/session-intro.test.js` and
  `tests/mc/pty-write.test.js`.

---

## Decision 1 — is the broker / certified-execution path alive?

**This is the one that unblocks most of the rest.** 36 of the 42 remaining
failures sit in this layer:

| Suite | Fails |
|---|---|
| `runtime/certified-execution/launch-plan` | 16 |
| `cli/lifecycle/restart` | 8 |
| `mc/session-fabric` | 6 |
| `mc/session-cutover` | 6 |
| `runtime/broker/launch-client` | 4 |
| `runtime/broker/c1-source-closure` | 4 |
| `mc/session-lifecycle-v1` | 4 |
| `cli/lifecycle/resume`, `cli/lifecycle/cd` | 4 each |
| `architecture/certified-execution` | 4 |
| `runtime/certified-execution/credential-boundary` | 2 |

They fail on shape, not on wiring — `launch-plan` reports
`Cannot read properties of undefined (reading 'startRuntime')`, i.e. the runtime
object the test expects no longer exists in that form.

The contradiction to resolve: `docs/mc-command-matrix.md` documents the broker
as removed — *"There is no global broker. Each session owns its runtime host
under `run/`"* — while `src/runtime/broker/` still exists and is still tested.
Parts of it are not reachable from any entry point at all
(`c1-child.js`, `c1-lease-host.js`).

**What the answer changes:**

- *The path is dead* → delete the suites with the source, in one change. Fastest
  route to a green suite, and it removes ~1 000 lines of unreachable code.
- *The path is alive* → the tests are the only description of the contract it
  used to honour, and repairing them is real work that needs an owner.

**Recommended sequencing:** decide this before touching any of the ten suites.
Repairing them first and deleting them afterwards is the worst order.

## Decision 2 — the session intro advertises a removed command

`src/mc/session-intro.js` prints, verbatim:

```
mc sessions watch   review local broker sessions
```

`mc sessions watch` is listed as removed, and the broker it names does not
exist. Users are being offered something unrunnable at session start.

PR #336 deliberately dropped the test assertion that locked this copy in, so
the fix is unblocked; the copy itself is untouched because it is a source
change with its own review.

**Note:** `renderIntro` is called only from
`src/runtime/broker/launch-client.js`. If Decision 1 goes the *dead* way, this
fixes itself by deletion — which is why it is listed second, not first.

## Decision 3 — does squash-phantom detection get built?

`tests/cli/lifecycle/squash-phantom.test.js` is a written specification for a
helper that was never implemented:

```
detectSquashPhantom({ repoDir, branch, gh? })
  → { isPhantom, cherryConfirms, hadMergedPr, diffEmpty }
```

Three-tier detection per plan §9b: `git cherry` first, `gh pr list --head
… --state merged` second, degraded `NEEDS_REVIEW` third.

It is skipped rather than deleted because the header is the only surviving
record of that design. Either build it and remove the `.skip`, or delete the
file and let the plan doc carry the intent — but it should not sit skipped
indefinitely, because a skipped suite is a promise nobody is tracking.

---

## Non-decision: keep the suite honest meanwhile

Whatever is decided, two properties are worth holding:

- **No suite may be red for work that was never started.** That is what made 85
  failures unreadable — real regressions were indistinguishable from
  never-built features.
- **The CLI helper must point at the installed binary.** The failure it caused
  looked like 19 unrelated assertion errors across nine files. A contract test
  asserting `CLI_PATH` matches `package.json`'s `bin.mc` would have caught it
  in one line, and is worth adding whoever picks up Decision 1.
