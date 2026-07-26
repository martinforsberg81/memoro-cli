# mc V1 hardening — test, fix, dev loop, performance

**Status:** proposed · 2026-07-26 · the gate before V2
([`mc-v2-cloud.md`](mc-v2-cloud.md)). V1 custody (S1–S4) is code-complete;
this plan takes V1 from code-complete to *trusted daily driver*, then V2
starts.

Related: [`session-runtime-hardening.md`](session-runtime-hardening.md)
(resume contract), [`mc-hardening.md`](mc-hardening.md) (launch seams),
`TODO.md` (broker/recovery items — folded into H1/H2 below).

## Why now

Live use keeps hitting the same class of failure: the architecture is right,
but the seams (registry ↔ broker ↔ PTY ↔ tool session ↔ worktree) drift out
of sync after crashes, shutdowns, and tool switches. Each phase below is
test-first: reproduce live, fix, lock with a regression test.

## H1 — Session lifecycle: `open` / `new` / `tool-switch` (+ resume)

The core loop must be boring. Test matrix, run live on this machine:

| Scenario | Expected |
|---|---|
| `mc new <name>` per tool (claude, codex) | worktree + branch + registry + broker PTY + grounding, one command |
| `mc open <name>` with live PTY | attach to the exact PTY, no relaunch |
| `mc open` / tool-switch past a *stale same-machine heartbeat* | proceed (shipped ea84805/a084ef9) — verify live |
| tool-switch claude↔codex with live prior session | fresh grounded launch on same coding session, prior continuity rendered |
| `mc resume` when provider-native session id is missing | announced fallback to fresh grounded launch on the *same* coding session (3b47d75) — never silent, never contextless |
| broker down / stale socket / missing node-pty | recover or print the exact fix; never a confusing half-start |
| machine rebooted, registry says "live" | reconcile: `list`/`status`/`resume` must not present dead PTYs as attachable |
| worktree path deleted out-of-band | detect + offer repair/relink, not "resumable" |

Note: the old TODO bullet "never let resume become a contextless fresh
start" is superseded in its letter by the contract — continuity is
server-owned, so the fallback is *grounded* and *announced*; the spirit
(no silent context loss) is kept and now enforced by test.

Deliverable: every row above passes live; every fix lands with a
regression test; TODO.md broker/recovery bullets closed or re-homed here.

### H1 live results (2026-07-26)

Verified live on this machine with a probe session (`mc new h1-probe`):

- ✅ `mc new` (claude): worktree + branch + registry + host-daemon PTY +
  grounding, one command; broker-confirmed live.
- ✅ client death ≠ session death: SIGHUP on the mc client leaves the
  detached session host and the tool process running; session stays
  attachable.
- ✅ resume fallback: with no provider-native id (child-session marker
  disables transcripts), `mc open` announces and starts a fresh grounded
  session on the SAME coding session.
- ✅ re-`open` attaches to the live PTY (screen replay, no new prompt).
- ✅ provider switch on a running session refuses with an actionable
  message (exit it or `mc end` first), exit 1; `mc tool-switch --dry-run`
  clean.
- ✅ stale-registry truth: 19 of 23 "live" entries had no live local
  session after the last reboot; list/status/picker now render them
  `stale` with escalate-only verdicts (fixed in this branch);
  `mc storage repair --apply` reconciled them to idle.

Found live; first two FIXED on this branch (H2 head start):

- ✅ `mc end --force` on a session with no provider transcript
  (`missing-tool-session-source`) failed closed on the ENTIRE teardown —
  the session could never be ended. Now: after fresh discovery confirms
  there is nothing to name provider-side, teardown proceeds with the
  provider surface untouched. Verified live: h1-probe ended with zero
  residue (worktree, branch, host dir, sidecars, daemon, registry).
- ✅ removing the last session on a dedicated host left the empty daemon
  running, which sidecar cleanup then refused (broker-host-still-running)
  — teardown failed. Now the host is retired after its last session and
  the teardown waits for the pid to exit. Also: tool-artifact scan budget
  raised 250ms → 2s (wall-clock; blew the deadline under load ~50,
  failing teardown closed).
- ❌ still open for H2 — zombie session hosts: daemon pid alive but
  socket not enumerable. `mc list` correctly shows `stale`, but
  `mc storage repair`'s pid-alive fallback counts them as live (no
  repair), and nothing reaps them. Repair should probe the socket;
  `mc gc --runtime` should reap. Three live specimens on this machine.

## H2 — `mc end`: complete, residue-free teardown

`mc end` claims teardown but leaves residue. Known/suspected leaks to
verify and fix (an `mc end` audit checklist, asserted by test):

- registry entry removed; no stale `sess_*.json`/`sess_*.sock` in `~/.memoro/mc`
- broker session stopped; PTY reaped; heartbeat daemon gone
- worktree removed, bootstrap branch deleted only if merged (existing policy)
- dev-server manifests for the session unregistered, owned processes stopped
- guard-bin entries and hosts entries for the session pruned
  (today: 107 guard-bin dirs, 75 hosts entries, registry.json at ~130 KB —
  much of it likely dead)
- bulk `end`/`gc`: resolve the *primary worktree per repo* live, recompute
  disk/broker safety signals — never trust stale registry fields
- `mc gc` (or `doctor`) detects and offers to clean legacy residue from
  before this fix, with dry-run counts first

Recent PRs #172–174 (artifact ownership / confirmed teardown / final
artifacts) cover part of this; H2 verifies the whole checklist end-to-end
and closes the gaps.

## H3 — `mc dev`: effective daily dev loop

`mc dev plan/ensure/register/list/log` exists (dev-definition, dev-ensure,
dev-servers). Make it *effective*:

- `mc dev ensure` is the one command a session needs: fast when already
  running, correct ownership across restarts, clear failure output
- session teardown (`mc end`) and `mc dev` agree about ownership (no
  orphaned dev servers, no killing another session's server)
- guard/dev-command-guard behaviour is predictable inside coding sessions
- document the intended loop in `docs/onboarding.md` (one screenful)

Acceptance: a fresh session can go `mc new` → `mc dev ensure` → work →
`mc end` and leave the machine exactly as found.

## H4 — Performance round

Measure first, then fix the top offenders. Candidate hot spots (to be
confirmed by measurement, not assumed):

- CLI startup latency for `mc list` / `mc status` / `mc open` (perceived
  snappiness of the daily loop)
- registry.json read/parse/rewrite (~130 KB today; compaction likely wins
  from H2's residue cleanup alone)
- broker round-trips: batch/parallelise probes instead of serial awaits
- context/grounding fetches on launch: cache what is stable per session
- test suite wall-clock (resume.test.js alone ≈ 85 s — likely real sleeps;
  inject timers so CI and local runs stay fast)
- test suite flakes under parallelism: `tool-artifact-ownership.test.js`
  ("returns exact Claude project and global session directories…") fails in
  a full run but passes in isolation — likely shared fixture/HOME
  interference between concurrent test files; fix the isolation

Deliverable: a small before/after table in this doc; no optimisation
without a number.

## Order and gate

H1 → H2 → H3 → H4, merge after each slice (standing instruction). H3/H4
may interleave where independent. When H1–H4 acceptance holds in daily
use, V1 is *done* and [`mc-v2-cloud.md`](mc-v2-cloud.md) C1 starts.
