# mc Configuration Model

**Status:** active planning - 2026-06-07 - serves G2, G3

mc must be customizable without becoming the owner of a user's repository
instructions. Configuration controls **mc behavior**: launch choices,
grounding, policy rendering, vault materialisation, data-access guards, and
session lifecycle. It does not replace project coding standards, architecture
rules, or tool-native instruction files.

## Product Boundary

mc owns:

- runtime grounding: roadmap, coordinator role, lens, focus, session/worktree
  context
- session continuity: registry, worktrees, selected tool, resume state
- behavior policy: permissions, approvals, data-access guards, vault
  materialisation, safety defaults
- package-canon for the coordinator role, shipped with mc and injected at
  session start

The repo owner owns:

- `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, and similar project instruction
  files
- coding style, architecture rules, review rules, domain conventions
- source code, scripts, tests, docs, and team process

The key rule:

```text
mc config changes what mc does.
Repo instructions change what coding agents know about the project.
```

Do not put project instructions in mc config. Do not silently replace project
instructions with mc's own canon.

## Configuration Layers

Configuration is layered, but not every field uses simple last-writer-wins
merging. Preferences can be overridden freely. Safety policy has floors that
can be tightened locally but not silently weakened.

### 1. Package Defaults

Built into the installed mc package. These are conservative and repo-neutral.

Examples:

```json
{
  "grounding": {
    "includeRoadmap": true,
    "includeCoordinatorRole": true,
    "includeLens": true
  },
  "permissions": {
    "workspace": "worktree",
    "approval": "tool-default",
    "secrets": "mc-vault-explicit"
  },
  "dataAccess": {
    "cloudflare": {
      "guard": "block-sensitive",
      "approvedScripts": []
    }
  },
  "instructions": {
    "mode": "preserve"
  }
}
```

### 2. Global User Config

Path: `~/.memoro/config.json`  
Scope: personal, machine/account-level, non-secret, mode `0600`.

Existing file. It can continue to hold:

- `apiUrl`
- update-check timestamps
- installed hook metadata
- `defaultTool`
- global personal preferences

Future fields should stay non-secret:

```json
{
  "defaultTool": "codex",
  "language": "Swedish",
  "worktreeRoot": "~/.memoro/mc/worktrees",
  "permissions": {
    "approval": "on-request"
  }
}
```

### 3. Repo Policy

Path: `.mc/policy.json`  
Scope: committed team/repo behavior, safe to review in git.

This is where a repo declares how mc may behave in that repo:

```json
{
  "permissions": {
    "workspace": "worktree",
    "approval": "on-request"
  },
  "dataAccess": {
    "cloudflare": {
      "guard": "block-sensitive",
      "approvedScripts": [
        {
          "command": "node",
          "args": ["scripts/admin/my-*.mjs"]
        },
        {
          "command": "node",
          "args": ["scripts/admin/aggregate-*.mjs"]
        },
        {
          "command": "node",
          "args": ["scripts/admin/inspect-*.mjs"]
        }
      ],
      "allowLocalWeakening": false
    }
  },
  "instructions": {
    "mode": "preserve"
  }
}
```

Repo policy must never contain secret values. It may reference vault labels or
binding labels, but actual secret bytes stay in the encrypted vault.

### 4. Repo-Local User Config

Path: `.mc/local.json`  
Scope: local, gitignored, per-user overrides for one repo.

Examples:

```json
{
  "defaultTool": "codex",
  "language": "Swedish",
  "permissions": {
    "approval": "never"
  }
}
```

`local.json` can override preferences. For safety-sensitive settings, it can
tighten policy but cannot weaken a repo safety floor unless the repo policy
explicitly allows it. If a local file attempts to weaken a repo floor, mc should
ignore that field and surface a status warning.

### 5. Session Policy

Path: mc registry entry  
Scope: one tracked session.

Used for durable work-session choices:

- selected tool
- role/kind/focus
- parent/child session fabric metadata
- session-specific permission override

Session policy should survive resume and tool relaunch.

### 6. Environment and CLI Flags

Highest-precedence operational overrides:

- CLI flags are explicit for one invocation.
- env vars are operational escape hatches and CI integration points.

They should be visible in effective-policy output when they affect behavior.

## Precedence

For ordinary preferences:

```text
CLI flag > env > session > .mc/local.json > .mc/policy.json > ~/.memoro/config.json > package defaults
```

For safety policy:

```text
effective safety = strictest(package defaults, repo policy, global/local/session/CLI intent)
```

A local/session/CLI setting may tighten. It may weaken only when the relevant
lower layer explicitly says that weakening is allowed.

Examples:

- A repo sets `dataAccess.cloudflare.guard = "block-sensitive"`.
  `.mc/local.json` cannot set it to `"off"` unless repo policy has
  `allowLocalWeakening: true`.
- A global user config prefers `approval = "never"`. A repo can require
  `approval = "on-request"` if that is the safer/team-required floor.
- A CLI flag can choose `--codex` for launch, because tool selection is a
  preference, not a safety weakening.

## Effective Config Contract

mc should expose the resolved configuration with source metadata:

```json
{
  "defaultTool": {
    "value": "codex",
    "source": ".mc/local.json"
  },
  "dataAccess": {
    "cloudflare": {
      "guard": {
        "value": "block-sensitive",
        "source": ".mc/policy.json"
      },
      "approvedScripts": {
        "value": [
          "node scripts/admin/my-*.mjs"
        ],
        "source": ".mc/policy.json"
      }
    }
  },
  "warnings": []
}
```

Initial surfaces:

- `mc status <name> --json` includes effective config/policy for that session.
- `mc auth status --json` includes effective config/policy for the current repo.
- Human `mc status` shows a short source-aware summary.

Do not add a broad config command family until a repeated live workflow needs
it. If needed, prefer `mc config show --effective --json` over many small CRUD
verbs.

## Instruction Ownership

Normal session launch must not dirty repo instruction files.

Rules:

- Codex grounding is delivered as the startup prompt, not by writing runtime
  state into `AGENTS.md`.
- Claude grounding is delivered via launch args/startup message, not by writing
  runtime state into `CLAUDE.md`.
- Existing user-authored `AGENTS.md` / `CLAUDE.md` is preserved.
- `mc adapter materialise` remains explicit opt-in for repos that want mc's
  coordinator canon files on disk.
- `mc adapter sync` should sync only files that are already mc-managed, or
  refuse with a clear message when user-owned content would be overwritten.

Adapter write modes:

| Mode | Meaning |
| --- | --- |
| `preserve` | Default. Do not create/replace repo instruction files. Launch still grounds via runtime delivery. |
| `managed-wrapper` | User explicitly opts in to thin mc-managed wrappers pointing at repo/project instructions. |
| `materialised-canon` | User explicitly asks mc to copy package canon into the repo for portability/debugging. |

The default for ordinary repos is `preserve`.

## Cloudflare/Data-Access Guard

The recent Codex incident proved the need for a tool-neutral data-access policy
surface. Codex has no Claude-style PreToolUse hook, so mc uses a guarded PATH at
launch. The guard itself should be generic; repo-specific allowlists belong in
`.mc/policy.json`.

Generic default deny set:

- `wrangler d1 execute`
- `wrangler d1 export`
- `wrangler d1 backup`
- `wrangler d1 time-travel`
- `wrangler d1 migrations apply --remote`
- `wrangler d1 migrations apply --env production`
- `wrangler kv key get|list|put|delete`
- `wrangler kv bulk`
- `wrangler r2 object get|put|delete|list`
- `wrangler tail`
- `wrangler dev --remote`
- `wrangler secret list|get|put|delete`
- `wrangler queues consumer`
- `wrangler vectorize query`

Allowed by default:

- `wrangler whoami`
- `wrangler types`
- `wrangler deploy`
- `wrangler dev` without `--remote`
- `wrangler d1 info`
- `wrangler d1 migrations list`
- `wrangler d1 migrations apply --local`

Repo policy can approve scripts by command shape. The runtime guard should
check parent command ancestry against those approved script specs before
blocking the internal `wrangler` subprocess.

This makes `memoro-cli` fit many repos:

- the package ships the protection engine
- each repo declares its sanctioned operational scripts
- no `my-*` assumption is hardcoded globally

## Implementation Plan

### Phase 1 - Config Resolver, No Behavior Change

Add an effective config resolver:

- read package defaults
- read global config
- read `.mc/policy.json`
- read `.mc/local.json` when present
- merge by field category: preference vs safety floor
- return source metadata and warnings

Tests:

- preference precedence
- safety floor cannot be weakened locally by default
- local can tighten safety
- repo can explicitly allow local weakening
- malformed optional files soft-degrade with warnings, not crashes

Acceptance:

- `mc status --json` can explain source per effective policy field.
- existing `resolveEffectivePolicy` behavior remains compatible.
- no launch behavior changes yet.

### Phase 2 - Policy-Driven Cloudflare Guard

Replace hardcoded approved admin-script prefixes with effective repo policy.

Status: shipped in `memoro-cli` after 0.7.6.

Changes:

- keep generic Wrangler deny/allow matrix in package defaults
- generate guard script with approved script specs from effective config
- support `node scripts/admin/foo-*.mjs` style specs without accepting spoofed
  `node -e` invocations
- follow-up: expose warning when a repo has Cloudflare files but no approved
  scripts

Tests:

- direct `wrangler d1 execute` blocked
- `npx wrangler r2 object get` blocked
- allowed admin script from repo policy can run internal Wrangler
- memoro-specific `my-*` is not allowed in a repo unless policy declares it
- malformed approved script specs are ignored with warning

Acceptance:

- the Codex guard remains secure in `~/memoro`
- ordinary users can declare their own sanctioned admin scripts
- no repo-specific convention is hardcoded in `memoro-cli`

### Phase 3 - Instruction Ownership Hardening

Make "preserve user instructions" the default contract.

Changes:

- audit `mc adapter sync` and `mc adapter materialise` wording and behavior
- ensure ordinary launch never writes runtime grounding into tracked instruction
  files
- ensure sync refuses, rather than replaces, user-owned `AGENTS.md` /
  `CLAUDE.md`
- document opt-in modes clearly

Tests:

- repo with existing user `AGENTS.md`: `mc new --codex --no-launch` and launch
  prep do not edit it
- `mc adapter sync` refuses user-owned file without `--force` or explicit
  managed-wrapper opt-in
- mc-managed wrapper remains idempotently syncable
- `mc adapter materialise` stays explicit and drift-aware

Acceptance:

- mc no longer presents package-canon materialisation as a normal requirement
  for ordinary repos
- project instructions remain project-owned

### Phase 4 - User Ergonomics

Add only the minimum surfaces needed to make the model understandable:

- `mc status` source-aware policy summary
- optional `mc config show --effective --json` if status is not enough
- docs/examples for `.mc/policy.json` and `.mc/local.json`
- a setup hint to add `.mc/local.json` to `.gitignore` when generated

Do not add a large `mc config set/get` family for repo-local config until live
usage proves it is necessary.

### Phase 5 - Migration and Release Gate

Before publish:

- convert the current Cloudflare guard to policy-driven behavior
- add `.mc/policy.json` to the `memoro` app repo with its approved admin
  scripts
- verify the guard in `memoro` still blocks direct D1/R2 access from Codex
- verify an ordinary non-memoro repo has no `my-*` allowlist
- run full `npm test`
- install globally and smoke `mc new/resume` with Codex

## Non-Goals

- No project-instruction DSL inside mc config.
- No automatic rewriting of `AGENTS.md` / `CLAUDE.md`.
- No silent creation of repo policy files.
- No secret values in JSON config.
- No attempt to make mc enforce every tool policy field when the tool has no
  real enforcement surface.

## Open Decisions

1. Should `dataAccess.cloudflare.guard` default to `block-sensitive` for every
   Codex session, or only when a repo contains `wrangler.toml` / Cloudflare
   config? Safer default is every Codex session; the shim is inert unless
   `wrangler`/`npx wrangler` is invoked.
2. Should `mc adapter sync` eventually be renamed to make "managed wrapper only"
   clearer? The current name can imply ownership of user instructions.
3. Should `mc config show --effective` be added now, or should `mc status --json`
   carry the model until live usage asks for a standalone config view?
