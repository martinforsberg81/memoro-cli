# mc dev-service protocol

`mc` keeps the machine-local inventory of development servers: which one is
running, in which worktree, on which port. The project's own wrapper remains
authoritative for how a server starts, stops, restarts and becomes healthy —
mc never decides that and never signals a process.

**What this document described until 2026-09-05, and no longer does.** It
specified a twelve-verb surface: `mc dev plan`, `mc dev ensure`, `mc deps
status`, `mc deps hydrate`, `mc storage status`, `mc gc`, `mc dev status`,
`mc dev logs`, `mc dev stop`, `mc dev restart`, dependency snapshots, a
resource preflight, a heavy-server concurrency limit and a worktree-scoped PATH
guard. `mc-cut` removed all of it on 2026-09-03 (#561) and this file went on
describing it for two days — a specification for a surface nobody could type.
The paragraphs below are what exists. Everything else is in the history if it
is ever wanted back.

Five verbs:

```sh
mc dev list [--json]                     what is running, and where
mc dev register <manifest> [--json]      take a copy of a wrapper's manifest
mc dev unregister <manifest> [--json]    forget it
mc dev admit <service> [--worktree <path>] [--wait <seconds>] [--json]
                                         may one more server start? (see Admission)
mc dev stop <instance_id>                stop it, through its own stop command
```

`list` is a capability probe as much as a listing: memoro's wrapper runs
`mc dev list --json` before every register to find out whether the installed mc
speaks this protocol at all, so it exits 0 and prints JSON on a machine with no
servers. An empty inventory and a missing verb must not look the same.

`list` also **sweeps as it reads**. A registration whose pid is gone is not a
server; the old inventory never swept and held 33 dead manifests when it was
measured, the oldest six weeks old. Liveness is `pidAlive` and nothing else — a
tmux session name and a `pgrep` pattern both lied on 2026-08-29.

## Who reads the inventory

`mc test dev`. That is the whole answer, and it is why these verbs exist: the
inventory was removed as unread, correctly, and came back when something needed
to ask *which server is serving this worktree*. A URL that answers says
something is serving; it never says it is serving the tree you are about to
judge, and on a machine running four lanes those are different servers with
identical shapes.

## Declarative project definition

A repository may declare its development services in `.mc/dev.json`. Version 1
is intentionally argv-only: mc never evaluates a shell command while reading a
definition. `mc test dev` reads the selected profile's `start.argv` when it has
to bring a server up.

```json
{
  "schema_version": 1,
  "default_service": "web",
  "services": {
    "web": {
      "default_profile": "agent",
      "profiles": {
        "agent": {
          "start": { "argv": ["npm", "run", "dev", "--", "--skip-containers"] },
          "readiness": {
            "kind": "runtime-manifest",
            "path": ".runtime/mc-dev.json",
            "timeout_ms": 90000
          },
          "resource_class": "standard"
        },
        "full": {
          "start": { "argv": ["npm", "run", "dev"] },
          "readiness": {
            "kind": "runtime-manifest",
            "path": ".runtime/mc-dev.json",
            "timeout_ms": 120000
          },
          "resource_class": "heavy"
        }
      },
      "dependencies": {
        "manager": "npm",
        "fingerprint_files": ["package.json", "package-lock.json"],
        "install": { "argv": ["npm", "ci"] }
      },
      "managed_argv_prefixes": [
        ["npm", "run", "dev"],
        ["npx", "wrangler", "dev"]
      ]
    }
  }
}
```

`start` and managed commands are argv arrays, never shell strings. Readiness
and dependency paths must be relative to the worktree and may not escape it.

`dependencies`, `managed_argv_prefixes` and the `readiness` block are read by
nothing today — `mc deps` and `mc dev ensure` went with the cut, and the PATH
guard with them. They are left in the schema because memoro's own wrapper reads
its half of the file, and because a field removed from a schema is harder to
bring back than one that sits unused.

## Runtime integration

The wrapper writes a JSON manifest inside its worktree and registers the file:

```sh
mc dev register /absolute/worktree/.runtime/mc-dev.json
```

On an orderly shutdown, unregister it before removing the source manifest:

```sh
mc dev unregister /absolute/worktree/.runtime/mc-dev.json
```

Registration copies a validated, normalized manifest atomically to
`$MC_HOME/dev-servers/<instance_id>.json` (normally
`~/.memoro/mc/dev-servers/`). A crash leaves that copy behind, and the next
`mc dev list` removes it: the pid is gone, so it is not a server. Until
2026-09-05 the copy stayed and the listing showed it, which is how the
directory came to hold 33 manifests and no running servers.

Schema version 1:

```json
{
  "schema_version": 1,
  "instance_id": "dev-unique-instance-id",
  "service": "project-worker",
  "profile": "agent",
  "definition_fingerprint": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "start_argv": ["npm", "run", "dev", "--", "--skip-containers"],
  "resource_class": "standard",
  "session_name": "feature-session",
  "coding_session_id": "sess_optional",
  "worktree_path": "/absolute/worktree",
  "pid": 1234,
  "process_group_id": 1234,
  "url": "http://127.0.0.1:8787",
  "port": 8787,
  "health_url": "http://127.0.0.1:8787/api/version",
  "log_path": "/absolute/worktree/.runtime/dev.log",
  "started_at": "2026-07-22T10:00:00.000Z",
  "control": {
    "stop": {
      "argv": ["npm", "run", "dev", "--", "--stop"],
      "timeout_ms": 30000
    },
    "restart": {
      "argv": ["npm", "run", "dev", "--", "--restart"],
      "detached": true
    }
  }
}
```

`worktree_path` and `service` are the fields reuse turns on: `mc test dev`
looks for a live server whose worktree is the one it is about to measure *and*
whose service is the one the tier needs, and nothing else counts. Since
2026-09-06 a worktree may have two — the app's service, and the one
`.mc/test.json` names as `environments.dev.static_service`, a file server the
suites marked `server: "static"` are measured against. Both register through
this protocol; a profile's `readiness.timeout_ms` is now the window mc gives
that service to register (the app's never declared one and keeps the long
default).

A manifest may also say what tree the service was built from:

```json
"built_from": { "commit": "<git HEAD at start>" }
```

`mc test dev` compares it with the worktree's HEAD when it finds a live
service to reuse. A mismatch means the service is serving a tree that is no
longer there — the measurement fixture reads `public/` once at start, and a
module that lands afterwards answers 404 until it starts again — so mc stops
it through its own stop command and starts a fresh one, saying so. A manifest
without the field is reused as before. The plan identity fields (`profile`, `definition_fingerprint`,
`start_argv`, `resource_class`) and `coding_session_id` are optional and
carried through as they come — the exact-match reuse they were added for went
with `mc dev ensure`, and a manifest without them is a first-class citizen
again. `resource_class` has one reader since 2026-09-26: admission, where
`light` does not count and anything else, or nothing, does. URLs must target loopback, and the source
manifest and log must stay inside `worktree_path`. Control commands are argv
arrays and are run without a shell.

## Admission

At most two app servers run on this machine at once, and none starts while
memory is already short. Measured 12–26 Sep 2026 on an 8 GB M1: 141 of 571
memoro dev-server starts died unexpectedly, and on 2026-09-26 seven registered
servers sat beside 6.8–8.2 GB of swap. The decision is mc's and is made in one
place:

```sh
mc dev admit <service> --worktree <path> [--wait <seconds>] [--json]
```

`--worktree` defaults to the git worktree the caller stands in. Exit 0 is
admitted; exit 75 is refused after the wait. With `--json` stdout is exactly one
of:

```json
{ "ok": true }
{ "ok": false, "reason": "cap" | "memory",
  "holders": [{ "instance_id", "service", "worktree_path", "started_at", "url" }],
  "free_percent": 31, "cap": 2 }
```

What counts is live registered servers whose `resource_class` is not
`light` — **`light` means "does not count"** — except those whose
`worktree_path` *and* `service` are the asker's: a restart replaces itself. The
cap is `MC_DEV_MAX_SERVERS`, default 2. Memory is asked first:
`sysctl -n kern.memorystatus_level` (percentage free, macOS) below
`MC_DEV_MIN_FREE_PERCENT`, default 15, refuses with reason `memory`, and where
the sysctl is missing the memory check is skipped (`free_percent: null`).

`--wait` polls every ten seconds and says who holds the slots once a minute
(on stderr with `--json`). Nothing already running is stopped to make room. A
refusal that ends a wait is logged as `dev-server-refused`, an admission that
had to wait as `dev-server-admitted` with `waited_s`.

`mc test dev` asks before it starts a server — up to fifteen minutes, printing
the waiting line — and starts the project's command with `MC_DEV_ADMITTED=1`
in its environment, so a wrapper that asks for itself when started by hand
knows it has already been admitted. A profile whose `resource_class` is `light`
does not ask, since it would not count once running.

## When mc stops a server

mc stops a registered server only by running the manifest's own
`control.stop.argv` in its `worktree_path`, without a shell. A manifest with no
stop command is never stopped by mc — the refusal names it, and a person stops
it where it was started. The occasions, each logged to `mc.log` as
`dev-server-stopped` with `instance_id`, `service`, `worktree_path`, `reason`
and `ok` (except the first, which `mc test dev` reports itself):

- **`mc test dev --stop`** — a person stopping the server for this worktree.
- **built from another tree** — `mc test dev` found a live server whose
  `built_from.commit` is not the worktree's HEAD, and replaces it (above).
- **alive but not answering** — `mc test dev` (and `mc shot`, through the same
  reuse) found a live server whose `health_url` did not answer twice in a row,
  five seconds allowed each. A live pid is not an answer: mc logs
  `dev-server-hung` with `instance_id`, `service`, `worktree_path` and `server_pid`,
  stops it, starts a fresh one and says so — `mc: <old> was alive but not
  answering — started a fresh one, <url> (<new>)`.
- **`asked`** — `mc dev stop <instance_id>`, a person naming one live server.
- **`workarea-closed`** — the runner closes a finished workarea: every server
  whose `worktree_path` is the workarea or below it is stopped before `git
  worktree remove`. A failed stop is said in the runner log and does not stop
  the close; `git worktree remove` decides.
- **`worktree-removed`** — `mc work remove`: every server inside the worktree
  is stopped, mc waits up to 5 s for its processes to leave, and then the
  usual in-use check runs. What is still standing there still refuses.

"Inside" is by path segment: a server in `/a/memoro2` is not inside
`/a/memoro`. A live server in a workarea that is not closing is never stopped,
however old.

A server mc finds already gone — its registered pid no longer alive — is not
stopped but swept: the next listing removes the registration and logs
`dev-server-gone` with `instance_id`, `service`, `worktree_path`, `server_pid`,
`started_at` and `age_s` (whole seconds since `started_at`, null when it does
not parse). That line is the only record of a server that died on its own.

## Supervision

A `mc test dev` round asks each suite's tier whether its server still answers
before the suite runs, and again after any suite that went red. A suite that was
running when its server left is reported unmeasured (`GONE`), never red.

The first time in a round a tier is found gone, mc starts it again through the
same door that started it — `ensureDevServer` for the static tier, the app-tier
start for the app — and carries on against the new url. It says `mc: the <tier>
server left mid-round — started a fresh one, <url>; carrying on`, logs
`dev-server-revived` with `tier`, `instance_id` and `worktree_path`, and the
round's report adds `mc: revived mid-round — <tiers>` (`revived_tiers` in
`--json`). The suite that was running stays unmeasured; a suite found gone
before it ran runs against the fresh server. A round whose every measured suite
is green exits 0.

Once per tier per round. A start that fails, or the same tier leaving a second
time, ends that tier as before: `mc: <url> (<tier>) stopped answering`, its
remaining suites listed as never ran, exit 1. `mc test prod` revives nothing —
there is nothing mc can start there.

## Safety contract

mc does not signal a registered server — admission included: a server that is refused
waits or gives up, and nothing running is stopped to make room. It holds an
index and answers questions about it; the project's wrapper owns the process,
and its stop command — the manifest's `control.stop.argv`, `npm run dev --
--stop` in memoro — is how a server ends, whether a person or mc runs it. mc
runs it on exactly the occasions *When mc stops a server* lists: `mc test dev
--stop`, `mc dev stop`, a checkout that moved from `built_from`, a live server
that does not answer its health URL twice in a row within five seconds each,
and a workarea or worktree being closed. Every stop mc decides on its own is in
`mc.log` (`dev-server-stopped`, `dev-server-hung`), and so is every server it
finds gone (`dev-server-gone`). This is narrower than the contract this document
carried until 2026-09-05, which specified four identity checks before mc would
signal a process — pid alive, manifests matching, live working directory, live
process group. Nothing signals a process now, so nothing needs them.

The one exception is the reaper, `mc dev reap`, which the runner's chore
pass runs every pass. It is the only time mc signals a process itself, and it
signals only what one of exactly three rules proves orphaned:

1. **An unregistered server whose parent is gone.** Parent pid 1, at least
   `--min-age-seconds` old (600 by default), a command matching
   `node … scripts/testing/static-server.mjs`, `scripts/testing/measure-server.mjs`
   or `scripts/dev.mjs`, and no registration with that pid. The age floor is
   there because mc itself starts servers detached — parent pid 1 from their
   first second — and they have up to 180 s to register.
2. **A runtime helper whose parent is gone.** Parent pid 1, at least 120 s
   old whatever `--min-age-seconds` says, and an esbuild `--service` or a
   `workerd serve`. Both only ever run under a node parent (wrangler or
   Miniflare); with pid 1 as parent, nothing will talk to them again.
3. **A registration whose worktree is gone.** Its stop command lived in the
   removed worktree, so mc sends SIGTERM to its pid if it is alive and then
   removes the registration.

Each process gets SIGTERM, up to 5 s to go, then SIGKILL, and each entry is
logged as `dev-server-reaped` (`kind`, `pid`, `instance_id`, `age_s`, and the
command's first 80 characters with the home directory as `~`). A process with
a live parent other than pid 1 is never reaped, and neither is a registered
server whose worktree still exists, however old. `--dry-run` says what it
would do and signals nothing.

What remains is the refusal at the door. A manifest is refused, not repaired,
when it fails any of: the schema version, an `instance_id` that is a name
rather than a path, an absolute `worktree_path`, a loopback `url` and
`health_url`, a `log_path` and a source manifest inside the worktree they
claim, and `control` commands that are argv arrays. A PID or an occupied port
is never authority for anything.
