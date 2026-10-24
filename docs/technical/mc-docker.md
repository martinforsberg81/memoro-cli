# mc docker

mc owns the container runtime the gates need. The module is
[`src/mc/docker.js`](../../src/mc/docker.js): it starts the runtime, waits
until it answers, and keeps track of who is using it, the way
[`src/mc/dev-servers.js`](../../src/mc/dev-servers.js) keeps track of dev
servers.

## The runtime and its leases

**Leases.** Every holder has its own file,
`~/.memoro/mc/docker/leases/<pid>-<id>.json`, where `<id>` is the first eight
characters of a random UUID. The file holds:

| field     | what it is                                     |
|-----------|------------------------------------------------|
| `schema`  | `mc-docker`                                    |
| `version` | `1`                                            |
| `pid`     | the holder's process id, a positive integer    |
| `run`     | what holds it (for example `merge #7`), or null |
| `repo`    | the repository it holds it for, or null        |
| `since`   | when the lease was taken, an ISO time          |

A holder releases by removing its own file (`release`), or every file of its
pid (`releasePid`). A lease whose pid is gone is removed by the next reader
(`liveLeases`), logged as `docker-lease-gone`, and counts as a release: a
holder that died has stopped using the runtime. A file that will not parse is
left alone.

**State.** `~/.memoro/mc/docker/state.json` is written merged, never replaced,
and always carries `schema`, `version` and `at`. Its keys:

- `runtime` — `{ kind, context, up, reason }`, where `kind` is `orbstack`,
  `desktop`, `other` or `none`;
- `leases` — `[{ pid, run, repo, since }]`, the live leases at the last write;
- `started_by_mc` — true once `ensure` started the runtime itself;
- `last_release_at` — the last release, an ISO time or null;
- `inventory` and `idle_stop` — written by later steps.

A state file that cannot be written is not an error: `writeState` returns
null.

**Timeouts.** Every `docker` and `orbctl` call has one:

| name                | value    | for                                      |
|---------------------|----------|------------------------------------------|
| `CALL_TIMEOUT_MS`   | 20 000   | any `docker` or `orbctl` call            |
| `PROBE_TIMEOUT_MS`  | 10 000   | one `docker info`                        |
| `START_TIMEOUT_MS`  | 60 000   | `orbctl start` or `open -a Docker`       |
| `ENSURE_TIMEOUT_MS` | 60 000   | the whole wait for `docker info`         |
| `ENSURE_POLL_MS`    | 1 000    | between two `docker info` probes         |
| `IDLE_GRACE_MS`     | 600 000  | how long a runtime mc started stays idle |

`ensure` reads the runtime, starts a stopped OrbStack (`orbctl start`) or,
on macOS, Docker Desktop (`open -a Docker`), polls
`docker info --format {{.ServerVersion}}` until it answers, and then takes a
lease. If `docker info` does not answer within its timeout, it gives up and
takes no lease. A context other than `orbstack` and `desktop-linux` is not one
mc can start.

**Who takes a lease.** A merge round takes one for itself before a selected
command gate whose selector entry says `needs: ["docker"]`, with the round's
pid as the holder and `merge #<pr>` as the run, and releases it when the gate
ends (the paragraph on command gates that need Docker in
[`mc-merge.md`](mc-merge.md#what-the-round-measures)). Anything else that needs
the runtime takes its lease with `mc docker ensure`, and gives it back with
`mc docker release`.

`mc gate` takes no lease: since ruling 52 it runs named test files only, and
no command gate, so nothing it runs needs the runtime. The command gates that
do are the merge round's.

**No `docker` call while OrbStack is down.** On OrbStack a `docker` call starts
the VM, so asking the CLI whether the runtime is up would make it so. The
context comes from `DOCKER_CONTEXT`, `DOCKER_HOST` or `currentContext` in
`~/.docker/config.json`, read without running anything. For the `orbstack`
context only `orbctl status` is asked. Only `ensure` runs `docker` against a
runtime that may be down.

## The verb

`mc docker` is the one door to the runtime; `src/mc/commands/docker.js` answers
it and `src/mc/docker.js` does the work.

- `mc docker [--json]` reads the state: up or stopped and why, the live leases,
  disk by `docker system df`, and the containers and volumes labelled
  `mc.holder` and the ones that carry no label. With the runtime down it runs
  no `docker` command, because a `docker` call would start OrbStack.
- `mc docker ensure [--pid <n>] [--run <label>] [--repo <name>] [--timeout <s>]`
  starts OrbStack or Docker Desktop if it is down, waits for `docker info` (60 s
  by default), and takes a lease for the pid, the calling shell by default. It
  exits 69 (`EX_UNAVAILABLE`) when the runtime cannot be started.
- `mc docker release [--pid <n>]` drops the leases of that pid. It stops
  nothing; the runner stops a runtime mc started once it has been idle for
  10 minutes.
- `mc docker prune [--dry-run]` removes the containers and volumes labelled
  `mc.holder` whose pid is gone. It never removes an unlabelled object: those
  are counted and reported. With the runtime down it does nothing.

## The idle stop

The runner's chore pass (`chores()`, `run.js`) calls `sweepDocker` on every
`--idle-sleep`, after the dev-process reaper. The merger cannot: `serve` exits
when its queue is empty. One sweep:

- **Reads the leases**, which removes those whose pid is gone. A gate that was
  killed has released by dying, and nothing else reads the leases on a timer.
- **Asks `orbctl status`, and nothing more while OrbStack is down.** A `docker`
  call would start the VM the sweep is trying to keep off. The state file gets
  the runtime and the live leases, `started_by_mc: false` and no `idle_stop`.
- **Removes labelled leftovers** (`removeDeadHolders`): containers and volumes
  labelled `mc.holder` whose pid is gone. `--rm` plus a forced remove does not
  survive SIGKILL, which is how 113 volumes piled up.
- **Stops OrbStack with `orbctl stop`** once `IDLE_GRACE_MS` (10 minutes) have
  passed since `last_release_at`, and only when every condition holds:
  - `started_by_mc` is true: `ensure` started it. A runtime Martin started is
    his, and stays up.
  - No lease is alive: a gate is using it.
  - No dev server `listServers` reports is alive: dev servers use Docker too
    (wrangler's `cloudflare-dev/*sandbox` containers, `workerd-memoro-*-proxy`).
  - No unlabelled container is running: mc does not know whose it is, so it
    does not take the VM from under it.

  Only OrbStack is stopped; Docker Desktop is started, never stopped. Inside
  the grace the state file's `idle_stop` says when the stop is due.

Every call has a timeout (`CALL_TIMEOUT_MS`): the chore pass runs one thing
after another, and a hung `docker` call would stall the archives and the
nightly behind it. The runner says one `docker: …` line when the sweep did
something, and a sweep that throws is one `docker: sweep failed — <reason>`
line; the pass goes on.

## On the page

The page's docker line (`dockerLine`, `page-render.js`) is drawn from
`~/.memoro/mc/docker/state.json` alone, never from a command: a `docker` call
would start OrbStack. It sits directly above the MC line, and it is absent when
the file is. Its parts, in order:

    docker · orbstack up · 1 lease (merge #13803) · 10 images · idle stop in 8 min

- `docker · <kind> up|stopped` — `orbstack`, `docker desktop` or `not installed`.
  A stopped runtime is that one short line, and the leases are left out.
- `N lease(s) (<run, or pid N>, …)` — live leases only: a lease whose pid is gone
  is not counted, whatever the file says (`dockerSection` filters by `pidAlive`).
- `N images` — the count from `docker system df`, as of the last write.
- `idle stop in N min`, or `idle stop due` once the grace has passed — only while
  mc started the runtime and nothing holds it.
- `as of 2 h` — once the file is more than an hour old.

## Why

On 2026-10-18 memoro's gate `sql:reference:postgres` exited 69 ('no Docker
daemon') in 2.7 s, in two merge rounds, on #13803 and #13805. OrbStack was
installed (`/opt/homebrew/bin/orbctl`, Docker context `orbstack`, version
2.2.4), but it was `Stopped` with `app.start_at_login: false`. memoro's probe
(`docker info --format {{.ServerVersion}}`, 20 s timeout) fails at once against
a stopped VM, while other `docker` calls start OrbStack themselves. Since #951
the merger reads exit 69 as `unavailable`, so the Postgres reference check had
never run on the merger host, and nothing in mc started the runtime or knew
who was using it.
