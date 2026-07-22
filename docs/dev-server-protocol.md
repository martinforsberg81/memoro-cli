# mc dev-service protocol

`mc` is the machine-local inventory and control plane for development servers.
The project-specific wrapper remains authoritative for how a server starts,
stops, restarts, and becomes healthy.

## Project integration

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
`~/.memoro/mc/dev-servers/`). A crash may leave that copy behind; this is
intentional, because `mc dev list` then exposes the server as an orphan.

Schema version 1:

```json
{
  "schema_version": 1,
  "instance_id": "dev-unique-instance-id",
  "service": "project-worker",
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

`coding_session_id` is optional. URLs must target loopback, and the source
manifest and log must stay inside `worktree_path`. Control commands are argv
arrays and are run without a shell.

## Safety contract

Before `stop` or `restart`, mc verifies all of the following again:

1. The registered PID is alive.
2. The source and registered manifests match, including the unique instance,
   process group, paths, endpoints, and control argv.
3. The live process working directory is the registered worktree.
4. The live process group is the registered process group.

If any check fails, mc refuses the action. A PID or occupied port alone is
never authority to signal or control a process. mc invokes the project's
declared command; it does not signal the process group itself.

## User commands

```sh
mc dev list [--json]
mc dev status <session-or-instance> [--json]
mc dev logs <session-or-instance> [--lines N]
mc dev stop <session-or-instance> [--json]
mc dev restart <session-or-instance> [--json]
```

Session and service selectors must resolve to exactly one server. When they do
not, use the `instance_id` printed by `mc dev list`.
