---
status: blocked
next: "Step 1 — the handoff concept goes: the read line in `src/mc/commands/plan.js:107`, the same sentence in `canon/roles/plan.md:19`, and `'handoff'` out of `FILING_DIRECTORIES` (`src/mc/work-area.js:55`), plus the 5 `HANDOFF.md` and 3 `handoff/` in `~/mc` — done when `grep -rin handoff src/mc canon docs` returns only the provider-handoff world (`src/mc/handoff.js`, `session-runtime-*.js`, `handoff-controller-capability.js`, `src/runtime/broker/`), `mc` prints the page unchanged, and `mc run --rounds 1` completes a round."
budget: 400k
needs: []
---

# mc cut — one surface, and the 52 000 lines behind the other one

## Goal

mc is one page and eight verbs now. The code underneath is still the product it
was before: a session manager with a registry, a broker, a PTY host, managed
providers, cloud runtimes and a capability dispatcher. Measured on 2026-08-29,
**71 % of `src/` is not reached by anything the page or its verbs do.**

This project removes that half. Not by grepping for what looks unused — by
taking the verb away first and then deleting what the verb was the only reason
for. `vault/` stays; see the contract.

## Success criteria

- [ ] The verb list in `src/mc-cli.js`'s `modules` map and `src/bin-mc.js`'s
      `CAPABILITIES` is the surface `mc --help` describes, and nothing else.
      Today they hold 29 and 16 entries against a page that names eight.
- [ ] The workarea `handoff` concept is gone from the code, the plan role and
      `~/mc`. It has three sites and zero writers.
- [ ] The workarea `inbox` channel is gone: `mc work send`, `mc sessions send`,
      `mc sessions read`, `src/mc/work-send.js`, and `tellHolder`'s delivery
      half in `src/mc/lease-refusal.js`.
- [ ] Every file that no surviving verb reaches is deleted from `src/`, and the
      reachability run in `reach.mjs` proves it — checked in beside this plan and
      re-run in each step, not trusted from this document.
- [ ] `docs/plans/` no longer describes machinery that does not exist.
- [ ] `npm test` green, `mc` prints the page, and `mc run --rounds 1` completes
      a round — after **every** step, not only at the end.
- [ ] Close-out: `docs/technical/mc-cut.md` says what mc is made of afterwards,
      and a `project_log.md` row.

## Contract

- **`vault/` stays.** `src/vault/`, `src/cli/vault.js` and `mc vault` are out of
  scope for deletion this round, whatever reachability says about them — and it
  does say something: `src/vault/credential-domain/` (3 649 lines, 2 files) is
  not reached even by `mc vault`, only by the broker world this project removes.
  Keeping vault means keeping those two files too, deliberately and with a note,
  not by accident.
- **The verb goes first, then the code.** A deletion is only allowed because a
  verb was removed in an earlier step and the graph shows nothing else reaches
  the file. No file is deleted because it reads as legacy.
- **One cut, one PR.** `mc` and `mc run --rounds 1` work after each. A step that
  cannot keep both working stops and says so.
- **Measured, never assumed.** `reach.mjs` is the evidence; each step reports its
  before/after numbers in the PR body.
- **Not in scope:** `#410` (`cut-old-surface`) is not merged into this and is not
  decided here — it deletes 22 test files to escape load-flakiness, and ruling
  `mc-test-1` says the cause is memoro-cli's uncapped `npm test` concurrency and
  must be re-measured first. The `mc test` split (same ruling) is its own project.
  The memoro repository is untouched.
- **Nothing merges to main without Martin.** No force-push, no rewritten history.

## Steps

1. **The handoff concept.** Three sites, zero writers — `plan.js:107`,
   `canon/roles/plan.md:19`, `work-area.js:55`. Then the 5 `HANDOFF.md` and 3
   `handoff/` under `~/mc`. Order matters: the files before the
   `FILING_DIRECTORIES` entry, or the directories surface on the page as
   repositories that are not repositories in between.
2. **The inbox channel.** `tellHolder` (`src/mc/lease-refusal.js`) stops
   delivering and only refuses; `src/mc/work-send.js` (736 lines) and the
   `mc work send` / `mc sessions send` / `mc sessions read` verbs go. Callers to
   fix: `repo-gate.js:54`, `commands/suite.js:31`, `commands/repo.js:22`. Then
   the 29 `inbox/` directories in `~/mc`.
3. **The verb list.** Decide the surviving set and remove the rest from the
   `modules` map, `CAPABILITIES`, `src/mc/help-text.js` and
   `docs/mc-command-matrix.md`. **Nothing is deleted from `src/` in this step** —
   it is the step that makes step 4 mechanical and each cut reversible by one
   revert. Re-run `reach.mjs`; its output is the work-list for step 4.
4. **Delete what step 3 orphaned**, one directory per PR, re-measuring after
   each: `src/cli/`, `src/runtime/`, `src/adapters/`, `src/capabilities/`,
   `src/commands/`, then the `src/mc/` half — `session-*`, `registry.js`,
   `session-home.js`, `owned-resource*`, `managed-*`, `cloud*`,
   `dev-servers.js`, `cloudflare-guard.js`, `release-trust.js`,
   `dependencies.js`.
5. **The tests that only covered the deleted code.** `tests/` is 256 files and
   60 064 lines against a `src/` of 78 606 — a large part of it tests machinery
   step 4 removes. This is where `#410` overlaps; the overlap is resolved by
   doing this step after step 4 and letting `#410` rebase onto it, not by
   merging `#410` in.
6. **`docs/plans/`** — 34 files describing the dismantled world. Read before
   deleting: some are the only record of why something was built.
7. **Close-out** — `docs/technical/mc-cut.md`, the `project_log.md` row, and
   `reach.mjs` either kept as the guard it became or removed with a note.

## What the code taught us

Measured 2026-08-29 against `a8fe2ee`, with `reach.mjs` (static import graph over
`src/`, following `import`, dynamic `import()` and `runModule('./…')`).

| | files | lines |
|---|---|---|
| `src/` | 288 | 78 606 |
| reached by the page and its verbs | 82 | 18 422 |
| …plus `mc vault` | 93 | 22 443 |
| **reached by nothing above** | **195** | **56 163** (71 %) |
| deletable, once vault's own files are held back | 190 | 52 119 |

Where the unreached half sits: `src/mc/` 22 704 · `src/runtime/broker/` 9 386 ·
`src/cli/` 5 913 · `src/vault/credential-domain/` 3 649 *(kept)* ·
`src/adapters/managed-runtime/` 3 390 · `src/runtime/session-host/` 2 076 ·
`src/lib/` 1 704 · `src/capabilities/github/` 1 634 · `src/mc/commands/` 1 300 ·
`src/commands/` 1 098 · `src/runtime/certified-execution/` 1 044 · rest 1 900.

Single largest: `src/vault/credential-domain/local-codex.js` 2 724 *(kept)*,
`src/runtime/broker/runtime.js` 2 398, `src/cli/vault.js` 1 905 *(kept)*,
`src/mc/session-cutover.js` 1 823, `src/cli/cloud-runtime.js` 1 717.

**The handoff is a reader with no writer.** `grep -rn "HANDOFF.md" src/` returns
exactly one line, and it is a *read* instruction in `mc plan`'s first prompt
(`src/mc/commands/plan.js:107`), repeated in `canon/roles/plan.md:19`. Nothing in
mc has ever written one. It entered with `b4a206a` (#414). Five of ~60 workareas
have one, because the prompt told each planning session that the last one might
have left one. `src/mc/work-area.js:48` writes the idea down —
*"`handoff/` is where a conversation leaves its baton for the next one"* — and
`FILING_DIRECTORIES` (`:55`) exists to keep that directory off the page. A filter
against a directory nothing creates.

mc already has the whole chain this was invented to replace: `decisions/` →
`**Beslut:**` → `mc plan` → PLAN.md, which has a section called *What the code
taught us* → `mc run` → close-out → `project_log.md`. A handoff is what gets
written when the plan is not trusted to carry the work, and it dies with the
workarea, which is exactly when someone wants it.

**The inbox is real, and still legacy.** Unlike the handoff it has writers —
`work-send.js:176 inboxPath` and `repo-freshen.js` — and one live path in:
`repo-gate.js`, `commands/suite.js` and `commands/repo.js` call
`tellHolder` (`lease-refusal.js:19`), which drops a line in the suite-lease
holder's `inbox/` and knocks on their tmux. That is the PM-era answer to "another
session is holding the lease". With `mc run` owning both lanes inside one
process, the session to be woken is the one asking.

**Two things wear the same word and must not be swept together.**
`src/mc/handoff.js`, `session-runtime-*.js`, `handoff-controller-capability.js`
and `src/runtime/broker/handoff-switch-journal.js` are the *provider* handoff —
codex↔claude session switching, `mc-session-handoff-v1`. Different feature. It
falls in step 4 with the rest of the broker world, on the reachability evidence,
not on its name.

**Why the first measurement was wrong.** Seeding the graph with the `status`
verb pulls `src/cli/status.js`, and from there the entire v1 world: it reported
244 files and 72 703 lines "live". `mc status <name>` is live but reaches the
page through a v1 shim. Anything measuring this must seed from
`mc/commands/home.js` and the `mc/commands/*` verbs, never from the router's
`modules` map — the map is the thing being cut.

## Documents

- `reach.mjs` — the reachability run, beside this plan. `node reach.mjs .` from
  the repository root.
- Ruling `mc-test-1` — [`../rulings.md`](../rulings.md) §4, for the `#410`
  boundary in the contract.
- `docs/technical/mc-dormant.md` — the previous cut (`mc watch`, 29 files,
  5 864 lines), and the shape this one follows.
