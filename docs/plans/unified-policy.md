# Unified Permissions and Secrets Policy

**Status:** next · 2026-06-04 · serves G2, G3

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

## Acceptance

- `mc auth status` / `mc status` can explain what policy/secrets would apply.
- Codex ChatGPT/Pro auth survives mc launches unchanged.
- Claude/Anthropic vault materialisation still works when explicitly configured.
- Future adapters can add policy rendering without changing the user-facing
  intent model.
