# Vault Import

**Status:** design · 2026-06-05 · serves G3

Users often already have working local secrets in `.env`, `.env.local`,
`.dev.vars`, shell profiles, or tool-specific config files. mc vault must not
force manual copy-paste. The migration path should discover local secrets,
import selected values into the encrypted vault, and keep the repo runnable by
materialising only what the session needs.

## Principle

```text
scan = find candidates, never values
import = move selected values into vault
binding = repo-local pointer from key -> vault label, never values
materialise = recreate runtime files/env for a session, then shred
```

## Sources

Phase 1 supports dotenv-shaped files only:

- `.env`
- `.env.local`
- `.env.development`
- `.env.production.local`
- `.dev.vars` (Wrangler / Cloudflare)

Later sources can include `.envrc`, `docker-compose.yml`, shell profile exports,
`.npmrc`, AWS credentials, and other tool auth files. Those should be separate
source adapters, not ad-hoc regexes scattered through the vault command.

## Commands

### `mc vault scan [path...] [--json]`

Read candidate files and classify keys. Output key names, source file, format,
and confidence only. Never print values.

Examples:

```text
.env
  OPENAI_API_KEY        likely secret
  DATABASE_URL          likely secret
  PUBLIC_API_URL        likely config

.dev.vars
  CLOUDFLARE_API_TOKEN  likely secret
```

### `mc vault import <file> [--dry-run] [--json]`

Parse the file, show classified keys, and let the user select what to import.
Default selection should include high-confidence secrets and exclude likely
public config (`PUBLIC_`, `NEXT_PUBLIC_`, `VITE_`, URLs without credentials,
feature flags, ports).

Imported labels should be deterministic and readable:

```text
env:<repo>:OPENAI_API_KEY
env:<repo>:DATABASE_URL
wrangler:<repo>:CLOUDFLARE_API_TOKEN
```

### `mc vault import <file> --move`

After import succeeds, rewrite the source file so secrets are no longer stored
there in cleartext. This must require confirmation and should preserve ordinary
config keys.

Preferred placeholder shape for files that can tolerate placeholders:

```dotenv
OPENAI_API_KEY=${MC_VAULT:env:memoro:OPENAI_API_KEY}
PUBLIC_API_URL=http://localhost:8787
```

For files/tools that cannot tolerate placeholders, `--move` should either leave
the file untouched with a clear explanation or create a companion template. Never
silently break the app.

### `mc vault materialise [--dry-run]`

Use repo-local bindings to recreate runtime secret surfaces for the current
session/worktree. Materialised files are manifest-tracked and shredded by
`mc end`.

## Binding File

Store bindings in repo-local `.mc/secrets.json`. It is safe to commit because it
contains labels and source metadata only, never values.

```json
{
  "version": 1,
  "sources": [
    {
      "file": ".dev.vars",
      "format": "dotenv",
      "materialise": "file",
      "keys": {
        "OPENAI_API_KEY": "env:memoro:OPENAI_API_KEY",
        "CLOUDFLARE_API_TOKEN": "wrangler:memoro:CLOUDFLARE_API_TOKEN"
      }
    }
  ]
}
```

The binding is the durable bridge: a developer can clone the repo, unlock mc
vault, and materialise the local runtime secrets without receiving the secret
values through git.

## Dotenv Parser Rules

Use a real parser for dotenv syntax. Preserve comments and ordering when
rewriting. Support:

- `KEY=value`
- `KEY="quoted value"`
- `KEY='quoted value'`
- `export KEY=value`
- blank lines and comments

Do not expand variables during import. Store the literal value present in the
file.

## Classification Heuristics

Likely secret:

- key contains `TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE`, `API_KEY`, `ACCESS_KEY`
- value looks like a provider token prefix
- URL includes credentials (`postgres://user:pass@...`)

Likely config:

- key starts with `PUBLIC_`, `NEXT_PUBLIC_`, `VITE_`
- value is a boolean, integer port, hostname, or URL without credentials
- key contains `URL`, `HOST`, `PORT`, `MODE`, `ENV`, `DEBUG`

Classification is advisory. User choice wins.

## Safety Invariants

- Scans never print values.
- Dry-runs never write vault entries or files.
- Imports never delete or rewrite the source file unless `--move` is explicit
  and import succeeded.
- Rewrites are atomic: write temp file, fsync where practical, rename.
- Materialised files are listed in the existing per-session manifest and
  shredded on `mc end`.
- LLM sessions must not be able to read materialised secret files. Enforce this
  as an mc invariant across adapters; reuse the existing PreToolUse hook path
  where supported and fall back to not materialising into LLM-readable paths
  where no equivalent guard exists.

## First Build Slice

1. Pure dotenv parser and classifier.
2. `mc vault scan <file> --json` for `.env` and `.dev.vars`, no values.
3. Tests that secret bytes never appear in scan output.
4. No import/write path yet.

This gives us a safe read-only inventory before building mutation.
