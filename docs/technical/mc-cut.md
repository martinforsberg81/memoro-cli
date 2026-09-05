# mc-cut — what mc is made of

`mc` was one page and a dozen verbs sitting on top of a different product: a
session manager with a registry, a broker, a PTY host, managed providers,
cloud runtimes and a capability dispatcher. Measured 2026-08-29, 71 % of
`src/` was unreachable from anything the page or its verbs did. This project
removed it.

Not by grepping for what looked legacy. The rule was **the verb goes first,
then the code**: a file could only be deleted because a verb had been taken
off a router in an earlier step and a static reachability run showed nothing
else reached it. That is why the cut is six pull requests in an order and not
one act of judgement.

| | files | lines |
|---|---:|---:|
| `src/` before (2026-09-02, `184be5d`) | 281 | 80 345 |
| `src/` after | 153 | 40 945 |
| `tests/` before | 263 | 62 111 |
| `tests/` after | 155 | 30 331 |
| `docs/plans/` before | 34 | 13 048 |
| `docs/plans/` after | 2 | 469 |

`src/mc/` itself went from 152 files to 89. Line counts here are `wc -l`;
`reach.mjs` counts one line more per file, so its `src/` row reads 41 098.

## The surface

Two routers, thirteen verbs, and the page.

- **`src/mc-cli.js`** — bare `mc` is the page, and its `modules` map is
  `status`, `work`, `repo`, `merge`, `test`, `worker`, `brief`, `helper`,
  `plan`, `run`, `roles`, `log`. Twelve. Anything that used to be a verb and
  is now part of the page answers through `moved()` — one line saying where it
  went, never a second list beside the first one.
- **`src/bin-mc.js`** — `CAPABILITIES` is `vault`, and nothing else.
  `mc-cli.js` falls through to it, so `mc vault` is reached the way every
  other verb is.

Fourteen verbs went off those two tables on 2026-09-03: `setup`,
`install-shell`, `auth`, `tool-auth`, `connections`, `github`,
`coding-profile`, `dev`, `deps`, `cloud-session`, `cloud-runtime`,
`security`, `doctor`, `migrate` — and `pm` / `pm-helper` with them. The
session verbs (`new`, `end`, `resume`, `fanout`, `gc`, `cd`, `sessions …`)
had already gone with `mc-dormant` and `mc-ui`.

## What is left, and who reaches it

Four sets, measured by `scripts/reach.mjs`. They partition `src/` exactly.

| | files | lines | |
|---|---:|---:|---|
| the page and its twelve verbs | 101 | 23 354 | mc |
| `mc vault`'s own door | 13 | 4 628 | `bin-mc.js`, `cli/vault.js`, the engine behind them |
| vault's carcass | 19 | 9 451 | kept so the two files above it can load; nothing calls it |
| `memoro` / `memoro-cli` | 20 | 3 665 | `package.json`'s other two `bin` entries |
| | **153** | **41 098** | |

By directory, as it stands:

| directory | files | lines |
|---|---:|---:|
| `src/mc/` | 75 | 20 012 |
| `src/mc/commands/` | 14 | 3 207 |
| `src/lib/` | 17 | 2 778 |
| `src/vault/engine/` | 13 | 2 498 |
| `src/vault/credential-domain/` | 2 | 3 647 |
| `src/adapters/` + `managed-runtime/` | 10 | 3 567 |
| `src/cli/` | 2 | 1 947 |
| `src/commands/` + `handlers/` | 9 | 1 257 |
| `src/runtime/broker/` | 6 | 883 |
| `src/capabilities/github/` | 1 | 732 |
| `src/` (root) | 4 | 417 |

`src/cli/` is two files: `vault.js`, the vault verb, and `status.js`, a
42-line shim that prints where the page went and hands a named project to
`mc/commands/status-project.js`. Everything else that lived there is gone.

## The three things nothing reaches, and why they are still here

**Keeping `mc vault` cost 9 451 lines of the world this project removed.**
The contract kept `src/vault/`, `src/cli/vault.js` and `mc vault` whatever
reachability said. What it did not say is that
`src/vault/credential-domain/local-claude.js` and `local-codex.js` — 3 647
lines that not even `mc vault` reaches — import the managed-runtime adapters,
the C1 broker artifacts, the GitHub contract and the managed-provider
journals at module top level. Deleting those would have left the two files
the contract keeps unable to load at all. Roughly two and a half times the
contract's own estimate, and it is a **preserved carcass rather than a
preserved capability**: two of the path lists inside `local-codex.js` name
files this project deleted — `MANAGED_GITHUB_RUNTIME_PATHS` names
`src/capabilities/github/github-session.js`, `github-shim.js` and
`github-write-client.js`, and the launch path `realpathSync`s
`src/adapters/artifacts/codex.js`. None of those three directories exists any
more. Read, not run: that code path throws before it does anything. The
contract kept the files; the capability was already gone.

**`memoro` and `memoro-cli` are the one decision this project left standing.**
`package.json` maps two of its three `bin` entries to `src/bin.js` and `main`
to `src/index.js`. Between them they reach 20 files no mc verb touches — the
whole of `src/commands/`, five files under `src/lib/`,
`src/mc/session-projector.js` (773 lines), `src/mc/git.js`,
`src/mc/open-question.js`, and `runtime/broker/client.js` and `paths.js`.
No step of this project removed a `memoro` verb, so the contract's first rule
forbade deleting what they reach. Whether those two commands should still
ship is a product decision, not a cleanup, and it is now the largest single
thing standing between mc and a `src/` that is only mc.

**The C1 custody chain is kept by a pinned hash, not an import.**
`src/vault/engine/c1-claude-lease.js` spawns `runtime/broker/c1-child.js` by
path and pins its SHA-256 in its own source, so the child stays.
`c1-source-closure.js`'s pinned digests for `package.json` and
`src/mc/paths.js` already did not match `main` before this project touched
anything — `verifyInstalledC1SourceClosure()` was returning failure, which is
why `tests/runtime/broker/c1-source-closure.test.js` has been red on `main`.

## Edges no import graph can see

A static graph is **necessary evidence for a cut, never sufficient**. Four
files in `src/` are reached only by a path literal:

| spawned | by |
|---|---|
| `lib/update-check-worker.js` | `lib/update-check.js` |
| `mc/nightly-run.js` | `mc/nightly.js` |
| `mc/repo-watch-run.js` | `mc/repo-watch.js` |
| `runtime/broker/c1-child.js` | `vault/engine/c1-claude-lease.js`, SHA-256 pinned |

All four were on the unreached list. Three of them are load-bearing today:
deleting `nightly-run.js` would have left `mc test nightly start` spawning a
file that is not there, and the parent only ever checks the child's command
line afterwards. They were found by grepping every `.js` path literal in the
surviving files against the deletion list — the check the graph cannot do for
itself. `reach.mjs` seeds all four by name now and says why.

### The edge it cost a verb

The fifth edge was not a path literal, and nothing above would have found it: a
**sibling repository's shell-out**. memoro's dev-server wrapper has run
`execFile('mc', ['dev', 'list', '--json'])` before every register and
unregister since 2026-08-29, and `reach.mjs` is a graph over `memoro-cli/src`.
No seeding, no grep of this repository's own path literals and no reading of
the surviving verbs could see it, because the caller is not in this repository
at all.

So `dev` was cut with the other twelve on 2026-09-03, and for two days after
that every `npm run dev` in every memoro worktree spawned an `mc` that printed
*unknown command* and exited 2 — **1 132 times**, logged as `mc dev inventory
unavailable` into a dev-server log nobody tails. It was found by the error
digest, not by anything in this repository.

The rule the four path literals taught holds, and needs widening: a static
graph is necessary evidence, never sufficient, **and its edge is the
repository, not the import**. Before removing a verb, ask what outside this
checkout types it. `~/.memoro/mc/logs/mc.log` answers that: it has recorded
every invocation with its `cwd` since 2026-08-05, and it would have shown 555
calls to `dev` from ten different worktrees. Teaching `reach.mjs` to read it is
a much larger job and is not done — knowing to look is most of the value.

`mc dev` came back on 2026-09-05 as three verbs, because `mc test dev` gives
the inventory a reader it did not have before. The cut was right about this
repository.

### And the seed list drifted anyway

While that was being fixed, `reach.mjs` was calling `mc deploy` — routed since
2026-09-04, working, 379 lines — dead. `mc-cli.js` dispatches through
`runModule(modules[command], …)`, a lookup rather than a literal, so the script
could not see the router's table and every verb needed a second entry in `LIVE`
that somebody had to remember. Nobody did.

A reachability tool whose answer depends on a hand-kept list being remembered
will eventually recommend deleting something that works. The table is read
where it lives now, and `LIVE` holds only what no import edge can reach: the
router, and the files spawned by path.

## The measurement

[`scripts/reach.mjs`](../../scripts/reach.mjs) is the evidence this project
was built on, and it is kept as a guard rather than retired with it:

```sh
npm run reach          # the four rows above, plus what is unreached, by directory
npm run reach -- --list   # every unreached file, largest first
```

It seeds the graph **by hand from the surviving router entries**, not by
parsing the tables, and that is deliberate: while the tables still held the
verbs being cut, seeding from them reported the whole session manager as
live. The last row is the one to read — `NOT reached — 0% of src/` is the
state this project leaves behind, and any number above zero is either new
code nobody wired up yet or a seed the script is missing.

**It is not in `npm test`, on purpose.** A file added in the middle of a
change is legitimately unreached for as long as that change is open, and a
test that goes red for it would be a gate against ordinary work rather than
against drift. Run it when a verb is added or removed, and when a directory
looks dead.

## What is still untrue

Named here rather than left to be rediscovered. None of it is a consequence
of a step going wrong; all of it is documentation and tooling that outlived
its subject.

- **`README.md` describes the deleted product.** Its command table still
  offers `mc setup`, `mc auth …`, `mc new`, `mc end`, `mc resume`,
  `mc sessions …`, `mc dev …`, `mc deps …`, `mc gc …`, `mc install-shell`,
  `mc cd` and `mc coding-profile` — roughly forty rows, almost none of which
  route anywhere. It is the package's front door and the description of what
  mc *is*, so rewriting it is Martin's copy rather than a cleanup.
- **`docs/onboarding.md` is worse.** Every section of it walks a verb that no
  longer exists. It should be deleted rather than corrected; there is no
  longer story to tell about a first-run flow that is `mc` and nothing else.
- **`scripts/mc-release-smoke.js` is a smoke test of a product that is
  gone** — it drives `mc auth status`, `mc tool-switch`, `mc new`,
  `mc resume` and `mc fanout` — and `npm run smoke:mc` still points at it.
  Nothing this project deleted broke it; it was already dead.
Not on that list, because the cut fixed it: **`npm test` is green.** Measured
on the close-out branch, 2026-09-03 — 1 534 tests, 1 525 passing, 9 skipped,
0 failing, 64 s. The suite was ~2 100 tests and carried a standing red set
before this project, and the six files still failing after step 4 were tests
of verbs that had left the router and of a C1 source closure whose pinned
digests no longer matched `main`; they went with step 5. Ruling `mc-test-1`
still stands on the cause of the load-flakiness — this repository runs
`node --test` with no `--test-concurrency` cap — but there is no standing red
set left to attribute to it. One run is evidence of one run; the gate is the
measurement.

## What it took

| step | PR |
|---|---|
| 1 — the handoff concept | [#538](https://github.com/martinforsberg81/memoro-cli/pull/538) |
| 2 — the inbox channel | [#539](https://github.com/martinforsberg81/memoro-cli/pull/539) |
| — `pm` and `pm-helper` off the router | [#540](https://github.com/martinforsberg81/memoro-cli/pull/540) |
| 3 — the verb list | [#543](https://github.com/martinforsberg81/memoro-cli/pull/543) |
| 4 + 5 — the deletion, and the tests that could no longer load | [#561](https://github.com/martinforsberg81/memoro-cli/pull/561) |
| 6 — `docs/plans/` | [#564](https://github.com/martinforsberg81/memoro-cli/pull/564) |

Step 4 was asked for as one pull request per directory and landed as one
pull request with a commit per directory instead. That is a property of the
code, not a shortcut: the unreached set imported across its own directories —
`cli/cloud-runtime.js` reached the broker, `mc/session-cutover.js` reached the
session host — so no single directory could be removed on its own and leave
the rest loadable. Only the last commit is a tree that runs.
