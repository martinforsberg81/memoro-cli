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

Three verbs:

```sh
mc dev list [--json]                     what is running, and where
mc dev register <manifest> [--json]      take a copy of a wrapper's manifest
mc dev unregister <manifest> [--json]    forget it
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
default). The plan identity fields (`profile`, `definition_fingerprint`,
`start_argv`, `resource_class`) and `coding_session_id` are optional and
carried through as they come — the exact-match reuse they were added for went
with `mc dev ensure`, and a manifest without them is a first-class citizen
again. URLs must target loopback, and the source
manifest and log must stay inside `worktree_path`. Control commands are argv
arrays and are run without a shell.

## Safety contract

mc does not stop or restart anything. It holds an index and answers questions
about it; the project's wrapper owns the process, and `npm run dev -- --stop`
is how a server ends. This is narrower than the contract this document carried
until 2026-09-05, which specified four identity checks before mc would signal a
process — pid alive, manifests matching, live working directory, live process
group. Nothing signals a process now, so nothing needs them.

What remains is the refusal at the door. A manifest is refused, not repaired,
when it fails any of: the schema version, an `instance_id` that is a name
rather than a path, an absolute `worktree_path`, a loopback `url` and
`health_url`, a `log_path` and a source manifest inside the worktree they
claim, and `control` commands that are argv arrays. A PID or an occupied port
is never authority for anything.
