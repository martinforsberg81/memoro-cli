# mc dev-service protocol

`mc` is the machine-local inventory and control plane for development servers.
The project-specific wrapper remains authoritative for how a server starts,
stops, restarts, and becomes healthy.

## Declarative project definition

A repository may declare its development services in `.mc/dev.json`. Version 1
is intentionally argv-only: mc never evaluates a shell command while reading or
planning a definition.

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

`start`, `install`, and managed commands are argv arrays, never shell strings.
Readiness and dependency paths must be relative to the worktree and may not
escape it. Unknown fields are rejected so misspelled safety settings cannot be
silently ignored.

Use `mc dev plan [service] [--profile <name>] [--json]` to validate the file and
inspect the selected plan. The profile preference order is command line,
`.mc/local.json`, `~/.memoro/config.json`, then the service's `default_profile`.
Planning is read-only: it does not install dependencies or start a service.

Launched coding sessions receive `MC_SESSION_NAME`, `MC_CODING_SESSION_ID`, and,
when the definition is valid, `MC_DEV_SERVICE`, `MC_DEV_PROFILE`, and
`MC_DEV_DEFINITION_FINGERPRINT`. Repositories without `.mc/dev.json` continue to
launch normally.

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
mc dev plan [service] [--profile <name>] [--json]
mc dev list [--json]
mc dev status <session-or-instance> [--json]
mc dev logs <session-or-instance> [--lines N]
mc dev stop <session-or-instance> [--json]
mc dev restart <session-or-instance> [--json]
```

Session and service selectors must resolve to exactly one server. When they do
not, use the `instance_id` printed by `mc dev list`.
