# Dynamic build dispatch

`createRunner({ autonomous: capability })` is not a configuration or CLI switch.
`runLoop` builds the capability once, when it merges, with `productionAutonomy`
(`src/mc/autonomous-capability.js`): the awake clock, the control profile
(`runner/control-profile.json`, or the default), the checkpoint verifier and
conflict integration. It fails closed: a clock that cannot be read or an invalid
profile means no capability, the reason is logged once and goals are skipped.
`AUTONOMOUS_EXECUTION_ENABLED` and the state's `execution_enabled` stay false; no
dispatch reads them.
V1 projects retain their fixed-step picker, statuses, prompts and publication.

## Admission and shared resources

The runner dispatches explicit `mc-plan` v2/autonomous assignments before legacy
step selection and its open-PR refusal. The sent assignment must match the
locked authoritative state, project/programme/repository identity and approved
programme snapshot. Only `ready` projects without an owner can start. An existing
PR is allowed only when its number and head branch match durable ownership.

The autonomous flavor uses the **step** role, not a repair role. It routes through
the existing `fast` model class and capacity snapshot (including provider
refusals and interactive reserve). It currently requires subscription billing;
manual credits are not launched through this seam. Both execution modes
use the runner's project claims, repository lanes, predecessor current files and
machine-wide `waitForSlot`/`dropSlot` accounting. Gate selection and resource
reservations remain those of `mc gate`; there is no new direct test runner.
The runner's own `gh` is `(cwd, args)`; the review, routing and merge doors it
hands work to ask `(args, { cwd })`, so `runStepClaimed` passes them an adapter
that defaults the cwd to the repository's primary checkout.

A strict atomic state mutation reserves a new UUID-based build run, its branch
and fresh session control together. Competing runners cannot reserve the same
project. The lane current file identifies `kind: step`, `flavor: autonomous` and
the stable run ID. A process result never releases that durable owner by itself.

## Fresh build preparation

A new worktree uses current `origin/main` and the project's one branch; it never
rotates branches after a landing or adopts an existing unowned branch. Existing
owned worktrees retain their local commits. Previous session/process-group and
gate reconciliation must permit reuse before any main integration. Dirty or
unfinished trees require deliberate recovery, not WIP commits, resets or aborts.
An already owned/interrupted context is not relaunched or synced by the picker:
its index, files and branch remain intact until recovery explicitly allows a
fresh session. This dispatcher does not replay an old conversation.

Fresh starts fetch/merge main using the runner's `syncMain`, without v1's theirs-only `.gitignore` shortcut. If conflicts remain,
the capability must provide `integrateConflicts`, an integration-only step
operation on the same reserved run (not a repair agent). The production one
(`src/mc/autonomous-capability.js`) is one supervised headless session on the
build's launch path, with the bounded assignment, the conflict list and the
autonomous step instructions; a non-normal exit stops the attempt. The dispatcher verifies
conflict resolution, merge completion, branch identity and main ancestry before
checking the starting gate and launching implementation. Missing/unfinished
integration preserves the merge and records an incomplete attempt for plan.

The default starting check calls the existing gate command with **no named test
files**. Tests may replace its command adapter. Red, unknown/no-checks failure
or RUNNING exit codes prevent implementation. A clean no-change start may return
without running tests; that is not publication evidence. Integration, dependency
attachment and gate time are observed as tool/gate activity, not model work.

## Context and stop boundary

The full bounded JSON payload comes from `buildSessionStart`: the exact approved
programme, complete assignment and at most the declared verified continuing
handoff. Oversize or stale input fails closed. No arbitrary prior conversation,
stream tail or accumulated history is appended. `_step-autonomous.md` replaces
the fixed-step overlay while retaining the shared instructions.

Both transports use the delivered session-supervision/control boundary and
`MC_AUTONOMOUS_RUN`/`MC_AUTONOMOUS_ROLE=step`, not `MC_STEP`. Artifacts are outside
the checkout in a unique immutable run directory. A plain exit 0 cannot assert
normal handoff, start another builder, confirm completion or queue merge.
Incomplete preparation/process results record `plan_pending` with the owner
retained and existing handoff reference preserved. A normally closed process
also retains its owner pending the verified publication/reconciliation boundary.
When finish prepared a publication, the runner calls the
[settled handoff boundary](mc-autonomous-publish.md) and then the
[continuation/recovery door](mc-autonomous-recovery.md). Remaining premerge
criteria yield a fresh build; all reported done yield review-ready without
starting review. A process exit without publication is plan-pending, never a
normal handoff. No automatic v2 archive or legacy failed-to-person routing is
introduced.

`tests/mc/autonomous-run.test.js` uses real temporary git repositories/worktrees
and controlled gate/transport adapters. It measures mixed v1/v2 concurrency,
shared total caps and capacity refusals, competing durable owners, current-main
integration/conflicts, gate refusals, preserved interrupted work and stable run
identity without model calls or touching live programmes.
