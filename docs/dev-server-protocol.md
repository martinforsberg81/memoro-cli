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

## Dependency snapshots

`mc deps status [service] [--profile <name>] [--json]` calculates a dependency
fingerprint and reports both the current worktree copy and the machine-local
snapshot. The fingerprint includes every declared fingerprint file (normally
`package.json` and `package-lock.json`), the exact install argv, Node ABI,
operating system, architecture, and npm version.

`mc deps hydrate [service] [--profile <name>] [--json]` is the explicit
mutation boundary. It behaves according to the user's dependency mode:

- `auto` reuses a matching immutable snapshot, or runs the declared `npm ci`
  recipe on a cache miss and then publishes a snapshot.
- `isolated` runs the recipe in the current worktree and never reads or writes
  snapshots.
- `off` refuses to install dependencies.

Choose the global default with
`mc setup --dependency-mode <auto|isolated|off>`. A repository-local
`.mc/local.json` may override it under `dev.dependencies.mode`. The default is
`auto`, but neither `mc new` nor session launch hydrates automatically. A later
`mc dev ensure` invocation is the intended automatic consumer.

Snapshot publication and worktree hydration use exclusive, crash-recoverable
lock files and atomic directory renames. On APFS, mc asks `cp` for clone-on-write
copies; other filesystems get an ordinary recursive copy. mc never symlinks a
live `node_modules` directory between worktrees. Existing unmarked
`node_modules` is left untouched unless `--replace` is explicit.

On a cache miss, npm receives `npm_config_prefer_offline=true`: cached packages
are preferred and npm retains its normal network fallback for missing content.
`npm ci` may execute package lifecycle scripts, which is why hydrate is an
explicit command and never part of `mc new`.

## Ensuring a worktree server

`mc dev ensure [service] [--profile <name>]` is the agent-facing entry point.
It serializes callers per worktree and service, then:

1. Reuses a healthy server only when its worktree, service, profile,
   definition fingerprint, start argv, and resource class exactly match.
2. Otherwise refuses a live mismatched or unhealthy server. Replacing one
   requires the explicit `--restart` flag and a successful identity-verified
   project stop command.
3. Prepares dependencies according to the selected dependency mode. A running
   reused server is never hydrated underneath.
4. Applies the user's local resource preflight to `heavy` profiles and respects
   the configured heavy-server concurrency limit.
5. Starts the declared argv directly with `shell: false`, registers the
   worktree runtime manifest, and waits for both verified process identity and
   the declared HTTP health check.

Servers in another worktree are never reuse candidates. A PID, port, process
name, or merely compatible URL is not enough. Session grounding tells coding
agents to use `mc dev ensure` instead of invoking a repository start command
directly.

For repositories with a valid definition, mc also places a worktree-scoped
PATH guard in launched Codex and Claude sessions. Commands matching
`managed_argv_prefixes` (including `npm run dev:*` when `npm run dev` is
declared) are refused inside that worktree with guidance to use
`mc dev ensure`. Other commands and repositories without a definition pass
through unchanged. Only the exact child launched by `mc dev ensure` receives
the internal bypass variable.

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

The plan identity fields (`profile`, `definition_fingerprint`, `start_argv`,
and `resource_class`) are required for `mc dev ensure` reuse; older manifests
without them remain visible but never count as an exact match.
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
mc dev ensure [service] [--profile <name>] [--restart] [--json]
mc deps status [service] [--profile <name>] [--json]
mc deps hydrate [service] [--profile <name>] [--replace] [--json]
mc storage status [--json]
mc gc --dependency-snapshots --dry-run|--apply [--min-age 30d]
mc dev list [--json]
mc dev status <session-or-instance> [--json]
mc dev logs <session-or-instance> [--lines N]
mc dev stop <session-or-instance> [--json]
mc dev restart <session-or-instance> [--json]
```

Session and service selectors must resolve to exactly one server. When they do
not, use the `instance_id` printed by `mc dev list`.
