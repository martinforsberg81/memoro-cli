# Script keys: `mc keys`

`mc keys run <script> [args…]` works from any worktree, including a second
worktree with no local configuration. `mc keys list` prints only declared names
and whether their envelope records are held. It never prints a value or a
vault label. A locked or unavailable vault reports **unknown**, not missing.
Plaintext export (`mc vault get`) remains disabled.

## Commit the declaration, then land it

A repository commits `.mc-keys.json` and a root `package.json`. For example:

```json
{
  "version": 1,
  "scripts": {
    "scripts/query.mjs": {
      "keys": { "SERVICE_TOKEN": "dotenv:example:SERVICE_TOKEN" },
      "sources": ["scripts/query.mjs", "scripts/query-client.mjs"]
    }
  }
}
```

Key names are uppercase environment identifiers; runtime-control names such as
`NODE_OPTIONS`, `PATH`, `HOME` and `MC_*` are refused. The keys map binds environment names to existing encrypted vault labels.
`mc vault import` already uses labels of the form `dotenv:<repo>:<name>`;
this command does not read or import a local development-vars file. Import is
Martin's act. Records must use the existing custody envelope and `api_token`
payload. Legacy records are not a fallback. Unlock with `mc vault unlock`.

`sources` is the fixed, complete Node source closure: the script and every
repository module it can import or require, including transitive and dynamic
imports, re-exports, and imported JSON. The closure is explicit, not inferred
by a regular expression and not discovered by executing project code.
Only `.js`, `.mjs`, `.cjs` and `.json` sources are supported. Node builtins
need no declaration. Third-party code must also be committed and declared;
an untracked `node_modules` cache, native addon, external file, data URL or
network module cannot receive keys through the module loader. Shell scripts
and arbitrary interpreter selection are deliberately unsupported.

The manifest, every source, the root package metadata, and each intervening
`package.json` must match the bytes on the locally fetched `origin/main`.
The runner reuses C1's SHA-256 fixed-source verifier, including its symlink,
file ownership and writable-directory checks. Package metadata participates
because Node reads it during module resolution. A new or edited script,
helper, package file or declaration is refused until it has landed and
`origin/main` has been fetched. Unrelated worktree edits are not checked.
Neither `HEAD`, the index, nor a local commit substitutes for `origin/main`.

All declared files are checked before vault decryption and again after vault
I/O, before child launch. A trusted preload restricts both `import` and
CommonJS `require` to those exact files and rechecks their hashes on load.
An unlisted static dependency is refused before the script body executes;
an unlisted dynamic dependency is refused when requested, before that module
executes. Do not use subprocesses, `eval`, custom loaders or filesystem reads
to load executable source outside this declaration.

## Custody, output and records

The command requires Node 22.15+ (synchronous module hooks). Key bytes are
unwrapped only inside mc's own process, using the existing cached unlock and
custody envelope; no passphrase prompt, dotenv fallback or caller-supplied
plaintext value is accepted. A missing or ambiguous name, locked vault,
unreadable record, unavailable source or incomplete declaration fails closed.
The child receives exactly the declared key names. Arguments after the script
are passed unchanged, even `--help`; do not supply secrets as arguments.

Values go only into the child's environment, never argv or a temporary file.
The parent/session environment is not modified to contain them. Names, not
values, are registered globally under mc's home directory; `runtime-secrets.js`
removes those names from environments passed to later sessions. Vault import
registers selected names before storing values. Every keys run/list registers
all manifest names, including names with no conventional `_TOKEN` suffix.
The child also drops inherited runtime credentials and Node/loader injection
environment variables before receiving its declared keys.

The child's stdin is closed. Both output streams are piped through byte-level
filters; plain UTF-8 values, standard base64 and unpadded base64 become
`[key:NAME]`, including matches split between chunks. Nonmatching bytes pass
through unchanged. The filter retains at most the longest match minus one
byte between input chunks. Other encodings, substrings, transformations and
secret-derived files or network traffic are not covered.

`<mc home>/keys/runs.jsonl` records a start and an exit for each launched run,
with script, closure content hash, key names, timestamps and exit status.
A preflight refusal records an exit without a start. Unknown hashes remain
null on refusal; an interrupted mc process may leave only a start, never an
invented successful exit. Script arguments, output and values are not stored.
Failure to open/write the start record prevents launch. The ordinary mc
invocation log also omits every script argument and flag. Child exit codes
are preserved; SIGINT and SIGTERM are forwarded only to the child mc started.

## The boundary

This protects against exposure by accident and by honest sessions. A process
running as the **same OS user is not a security boundary**. Such a process can
inspect a child's environment, replace mc, rewrite local remote refs, race
source checks or deliberately change executable behavior after launch. A
landed script is trusted to use keys honestly: it must not write them to files,
spawn an unrestricted executor with them, or send them to an unintended
endpoint. Output filtering is defence against accidental printing, not an
exfiltration sandbox. Stronger protection requires a separate principal or
sandbox and is outside this command's contract. Production secrets and
Cloudflare bindings are not part of this feature.

## Verification

`tests/mc/keys-run.test.js` uses real Node children and disposable git
repositories/worktrees, encrypted fixture envelopes and fake vault transport.
No test reads a real keychain or contacts a vault. It covers declared-only
delivery, parent/argv/worktree/audit absence, changed source and manifest
refusal, locked/missing custody, streaming output, CommonJS loader restrictions,
package metadata and operation from a second worktree.
