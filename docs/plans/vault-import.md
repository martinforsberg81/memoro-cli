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

Non-dry-run import creates new vault entries for selected keys after explicit
confirmation. Existing vault labels are skipped by default; overwrite/rotate is
not part of the first import mutation slice.

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
- Existing vault labels are never overwritten silently. Real import must resolve
  collisions per key with an explicit choice: skip, overwrite, or rotate to a
  `-prev` copy before replacement. Default is skip.
- Imports never delete or rewrite the source file unless `--move` is explicit
  and import succeeded.
- Rewrites are atomic: write temp file, fsync where practical, rename.
- Materialised files are listed in the existing per-session manifest and
  shredded on `mc end`.
- LLM sessions must not be able to read materialised secret files. Enforce this
  as an mc invariant across adapters; reuse the existing PreToolUse hook path
  where supported and fall back to not materialising into LLM-readable paths
  where no equivalent guard exists.

## Landed: Read-Only Scan + Import + Bindings

Shipped:

1. Pure dotenv parser and classifier.
2. `mc vault scan [file...] [--json]` for dotenv-shaped files, including
   `.env` and `.dev.vars`.
3. `mc vault import <file> --dry-run [--json]` previews selected secrets,
   deterministic vault labels, and the proposed `.mc/secrets.json` binding.
4. `mc vault import <file>` creates selected new vault entries after explicit
   confirmation; existing labels are detected and skipped by default.
5. Human dry-run output is the primary UX: compact summary, warnings, import
   list, skipped list, and value-free binding preview. `--json` is for machines.
6. Duplicate keys are warnings and are not auto-bound; the user must fix the
   source file before real import.
7. JSON and human output include key metadata only, never values.
8. Tests assert sentinel secret bytes never appear in scan/import output.
9. Successful import persists repo-local `.mc/secrets.json` bindings. Existing
   vault labels are still skipped for value writes, but the repo gets the
   value-free pointer so future materialisation is repo-scoped.
10. Binding helpers filter materialisation candidates to labels explicitly bound
    by the current repo. Account-wide vault storage remains available for
    `mc vault list/get`, but runtime reconstruction has a repo-local contract.

No source-file rewrite path exists yet.

## Next Build Slice

1. Preflight existing vault labels and mark each candidate as create / exists
   in the dry-run plan too, when the vault is unlocked.
2. Default existing labels to skip; support explicit per-key overwrite/rotate
   only after the user confirms.
3. Add `mc vault materialise [--dry-run]` for repo-bound dotenv surfaces and
   manifest-track the files so `mc end` can shred them.
4. Add `mc vault import --move` source-file rewrite once materialisation is
   reliable.
5. Preserve the no-value-output invariant across success and every error path.
