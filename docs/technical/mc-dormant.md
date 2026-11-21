# mc dormant — one world on the surface

Work is a goal: GOAL.json and LOG.md under a programme, with repository
worktrees on its branch. `mc run` starts headless build and review
sessions; `mc martin` is the person's
interactive entrance. `mc` is the page. No resident model keeps sessions
moving or invents work for them.

## What replaced the resident PM

The resident PM, its research assistant and session watch programme were
removed after ruling mc-1 (2026-08-26). The page replaced competing boards.
Goal phases now order work, and stages choose its next kind of session.
A blocked goal waits on a person, with its question in LOG.md; the desk
takes that question to Martin. There is no
file of answered decisions for the runner to turn into work.

Projects went on 2026-11-03; [mc-goals.md § From a project](mc-goals.md#from-a-project)
describes the migration. Free-standing workarea and worker entrances also
went on that date ([mc-work.md](mc-work.md)). Every current session belongs
to a programme or a desk. `roles.js` reserves `helper` (the eye) and `martin`; old PM names no longer reserve a workspace.

## What is still a watcher

`mc repo watch` refreshes repository status snapshots. It watches neither
coding conversations nor a PM, and is explicit: no status read starts it.
The runner, merger and watcher are ordinary long-lived processes, not a
resident model role. Their state and handover are described in
[mc-run.md](mc-run.md), [mc-merge.md](mc-merge.md) and
[the command matrix](../mc-command-matrix.md).

Routing and retired entrances are in `src/mc-verbs.js`; role lookup is in
`src/mc/roles.js`. The page and `mc goal show` are the ways to inspect work,
not a dormant session-manager command.
