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
  `target_location` as first-class fields.
- vault lifecycle matches explicit target fields before provider-derived legacy
  mappings.
- tests prove `provider=openai` without `target_tool=codex` is skipped.
- tests prove an explicit Codex target is the only path that reaches Codex
  materialisation.

## Phase 3 — Permission profiles

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

- policy resolver reports source precedence.
- unsupported adapter fields are shown as `unsupported`, not silently applied.
- switching a session from Claude to Codex keeps the mc policy object stable.

## Phase 4 — Adapter rendering

Only after visibility and explicit targets are solid: render policy into concrete
tool surfaces where safe and reversible.

Rules:

- rendering must be idempotent and managed-marker based
- runtime/session policy must not dirty tracked project wrappers
- native auth files are never overwritten except through explicit target secrets
- every rendered artefact is listed in a manifest for cleanup/audit

This phase likely differs per tool and should be built adapter by adapter.

## Acceptance

- `mc auth status` / `mc status` can explain what policy/secrets would apply.
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

Build Phase 2 only: explicit vault target metadata in encrypted payloads and
matching logic, while preserving the current Codex no-mutation invariant.
