# Unified Permissions and Secrets Policy

**Status:** active planning · 2026-06-05 · serves G2, G3

Users should not have to recreate their preferred freedom and safety posture for
each coding tool. mc should own the tool-neutral policy intent; adapters translate
that intent to Claude, Codex, Gemini, and future tools.

## Principle

```text
mc policy = user intent
adapter = tool-specific rendering
tool = enforcement surface
```

## Permissions

The first useful layer is visibility:

- show the selected tool and effective policy at session start/status
- separate repo/worktree permissions from tool-native auth
- keep policy stable across `mc resume <name> --codex/--claude`

Rendering into each tool can come later and must respect each tool's real
security model.

## Secrets

Vault materialisation must stay explicit:

- no provider-name guessing into native auth files
- no generic `provider=openai` → Codex auth write
- future secret payloads need explicit targets such as `target_tool` and
  `target_auth_mode`

Native tool auth belongs to the tool unless the user explicitly opts into an mc
vault target.

## Current code facts

- `src/mc/vault/lifecycle.js` still has a narrow legacy
  `ADAPTER_PROVIDERS` map: Claude accepts `provider=anthropic`; Codex accepts no
  generic provider mapping so ChatGPT/Pro auth is protected.
- `src/mc/vault/types.js` already preserves unknown encrypted payload fields in
  `extra`, so adding `target_tool` / `target_auth_mode` can be backward
  compatible.
- `mc status <name>` already reports selected tool and relaunch command, but not
  effective policy or secret materialisation plan.

## Phase 1 — Effective policy visibility

Status: landed in dev. No behavior change. A small policy resolver explains what
mc thinks will happen before launch.

Shape:

```json
{
  "permissions": {
    "profile": "default",
    "source": "default",
    "rendered_for": "codex"
  },
  "secrets": {
    "vault_required": false,
    "native_auth_owned_by_tool": true,
    "materialisation_targets": []
  }
}
```

Surfaces:

- `mc status <name> --json` includes `effective_policy`.
- human `mc status <name>` shows a short `policy` line.
- `mc auth status --json` includes a per-tool policy/secrets report for the
  current repo/global default context.
- launch intro may show only a terse summary later; start with status to avoid
  noisy TUI launches.

Acceptance:

- Codex session status says vault is not required when no explicit Codex target
  exists.
- Claude session status can say Anthropic vault materialisation is available
  through the legacy mapping.
- `mc resume <name> --codex/--claude` preserves the session policy source; only
  adapter rendering changes.

## Phase 2 — Explicit vault targets

Status: landed in dev.

Extend the encrypted mc secret payload with target fields:

```json
{
  "kind": "api_token",
  "provider": "openai",
  "target_tool": "codex",
  "target_auth_mode": "api_key"
}
```

Rules:

- `target_tool` is required for native auth materialisation in new entries.
- `provider` alone never implies native tool auth.
- legacy `provider=anthropic` → Claude may continue as a compatibility path, but
  status must label it as legacy/provider-derived.
- Codex remains protected: no generic OpenAI secret writes to `~/.codex/auth.json`.

Acceptance:

- `normaliseSecretPayload` exposes `target_tool`, `target_auth_mode`, and
  `target_location` as first-class fields. Landed.
- vault lifecycle matches explicit target fields before provider-derived legacy
  mappings. Landed.
- tests prove `provider=openai` without `target_tool=codex` is skipped. Landed.
- tests prove an explicit Codex target is the only path that reaches Codex
  materialisation. Landed.

## Phase 3 — Permission profiles

Status: landed in dev for visibility only.

Add a minimal mc-owned permission profile model, still mostly informational:

```json
{
  "profile": "default",
  "workspace": "worktree",
  "network": "tool-default",
  "approval": "tool-default",
  "secrets": "mc-vault-explicit"
}
```

Sources, in order:

1. per-session registry override
2. repo config
3. global mc config
4. default

Adapters can expose whether they can render a field. Unsupported fields remain
visible but not enforced; mc must not pretend enforcement exists.

Acceptance:

- policy resolver reports source precedence. Landed.
- unsupported adapter fields are shown as `unsupported`, not silently applied. Landed.
- switching a session from Claude to Codex keeps the mc permission intent stable.
  Landed.

## Phase 4 — Adapter rendering

Only after visibility and explicit targets are solid: render policy into concrete
tool surfaces where safe and reversible.

Rules:

- rendering must be idempotent and managed-marker based
- runtime/session policy must not dirty tracked project wrappers
- native auth files are never overwritten except through explicit target secrets
- every rendered artefact is listed in a manifest for cleanup/audit

This phase likely differs per tool and should be built adapter by adapter.

### Phase 4 design checkpoint

Status: first Codex launch-arg slice landed in dev.

The first render target should be **Codex launch args**, not config files. Local
CLI help confirms the interactive Codex surface has explicit runtime flags for
the two permission fields mc can safely translate today:

- `--sandbox <read-only|workspace-write>`
- `--ask-for-approval <untrusted|on-request|never>`

This is the right first surface because it is per launch, leaves no tracked
project file dirty, and needs no cleanup manifest: no artefact is written. It
also keeps ChatGPT/Pro auth untouched because auth remains separate from policy.

Claude Code is not the first render target. It has `--permission-mode` plus
tool allow/deny flags, but it does not expose the same sandbox model as Codex.
Rendering the same mc intent into Claude too early would create false parity.
For Claude, keep fields visible as unsupported or partial until a smaller,
defensible mapping is designed.

#### Adapter rendering contract

Adapters should expose a pure function shaped like:

```js
renderPolicy(policy) -> {
  launchArgs: [],
  env: {},
  artefacts: [],
  support: { permissions: { ... } },
  warnings: []
}
```

Rules:

- `launchArgs` are appended by the mc launcher after user-supplied args, unless
  the adapter explicitly needs another position.
- `env` is limited to non-secret policy state. Secrets still go through the
  vault materialisation lifecycle.
- `artefacts` is empty for the first Codex slice. If a future adapter writes
  files, every file must be managed-marker based and recorded for cleanup/audit.
- `support` must distinguish `supported`, `partial`, and `unsupported`.
- unsupported fields are never silently dropped from status; they remain visible.

#### Codex mapping

Only render explicit fields, never the default placeholders:

| mc permission | Codex render | Notes |
| --- | --- | --- |
| `workspace: "read-only"` | `--sandbox read-only` | Strictest useful mode. |
| `workspace: "worktree"` | `--sandbox workspace-write` | Default mc worktree workflow. |
| `workspace: "full"` | never rendered as full access | Capped to `workspace-write` with a warning. |
| `approval: "untrusted"` | `--ask-for-approval untrusted` | Conservative. |
| `approval: "on-request"` | `--ask-for-approval on-request` | Normal interactive autonomy. |
| `approval: "never"` | `--ask-for-approval never` | Requires explicit config. |
| `network` | no render yet | Codex `--search` is web-search, not shell network. |
| `secrets` | no render here | Handled by vault targets/materialisation. |
| `profile` | no direct render | Profile is intent metadata unless expanded first. |

`tool-default` and `default` must render no flags. This preserves native tool
behavior unless the user has configured a real mc policy.

`danger-full-access` is not part of mc's policy model. mc should never hand an
LLM full host access; if a future user needs that kind of execution it belongs
outside mc in an external sandbox boundary, not as a normal policy profile.

#### First implementation slice

1. Add pure adapter capability/render helpers for Codex. Landed.
2. Thread `effective_policy` into launch resolution/preflight so launch args can
   be appended without changing adapter-sync wrappers. Landed.
3. Update `mc status` / `mc auth status` support labels for Codex fields from
   `unsupported` to `supported` only for fields that actually render. Landed.
4. Add tests proving explicit Codex policy yields the expected launch args, while
   default policy yields no args. Landed.
5. Add tests proving Claude remains visibility-only for these fields. Landed.

No new CLI verbs. No `mc map` family. No writing policy into `AGENTS.md`,
`CLAUDE.md`, or native auth files.

## Acceptance

- `mc auth status` / `mc status` can explain what policy/secrets would apply.
  Landed for visibility.
- Codex ChatGPT/Pro auth survives mc launches unchanged.
- Claude/Anthropic vault materialisation still works when explicitly configured.
- Future adapters can add policy rendering without changing the user-facing
  intent model.

## First build slice

Phase 1 has now landed:

1. Added pure `resolveEffectivePolicy({ entry, tool, config })`.
2. Added tests for Codex, Claude legacy Anthropic, session-policy precedence,
   and adapter-id normalisation.
3. Surfaced `effective_policy` in `mc status <name> --json` and a terse policy
   line in human output.
4. Did not write tool config files.
5. Did not change vault matching behavior.

This gives the user a trustworthy answer to "what will mc touch?" before we make
mc touch anything new.

## Next build slice

Live-test Codex launch rendering with `.mc/policy.json`, then decide whether the
next slice is policy-config ergonomics or a separate Claude-specific mapping
design. Keep Claude visibility-only until that mapping is defensible.
