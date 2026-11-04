# Script credentials: `mc keys`

`mc keys run <script> [args…]` runs a trusted Node `.js`, `.mjs` or `.cjs`
script. `mc keys list` prints the names in the shared dotenv source and never
prints values. The default source is `~/mc/self/memoro/.dev.vars`, resolved
from the host's `HOME`, not the working directory. Set `MC_KEYS_FILE` to use
an alternate source (for example, an isolated test fixture). There is no
implicit search or fallback to other dotenv files.

`mc keys serve <command> [args…]` supervises a trusted server command through
the same runner. It launches argv directly with `shell: false`, using the
same dotenv parsing, environment scrubbing, audit, output filtering, exit
status and signal forwarding as `run`. Every dev server mc starts, including
the static tier, goes through `serve`; measuring and taking screenshots are
activities against that dev server. Server commands and their dependencies
are trusted with all delivered entries, just as Node scripts are.

The runner also supplies `MC_KEYS_NAMES`, a JSON array of delivered names,
never values. A server adapter can use those names to map its inherited
values into Worker bindings without discovering, parsing or copying a dotenv
file. The source cannot set this runtime control. Existing servers retain
their startup environment; restart them to receive source changes.

The runner reads and parses the source as data; it never sources or evaluates
shell text. Blank lines, comments, `export NAME=value`, quoted values,
backslash escapes (including `\n` in double quotes), and unquoted inline
comments are supported. Duplicate names, malformed assignments, reserved
runtime names, and missing or unreadable files fail before the script starts.
Errors do not include values. All valid entries are delivered in the child
environment on each invocation, including nonsecret identifiers and
configuration such as paths. Referenced private-key files are not opened.

This is deliberately a trusted-script interface, not a per-script permission
system. Any script and any dependency it loads can read every delivered entry
through `process.env`. There are no manifests, allowlists, source-closure
checks, origin/main requirements, or preload restrictions. Modified,
untracked and ordinary local or npm imports work. Missing names have normal
Node behavior (`process.env.NAME` is `undefined`); scripts must diagnose their
own required names. `run` supports Node scripts; `serve` accepts the trusted
server's executable and arguments, without evaluating shell text.

The child's inherited environment is copied after mc's runtime-secret
scrubbing; source values are added to that fresh copy. Runtime and executor
control names (including `PATH`, `HOME`, `NODE_*`, `MC_*`, and the other
reserved names) cannot be supplied by the dotenv file. Values are never put
in the parent/session environment, argv, or audit records. Names, never
values, are registered for future session environment scrubbing. The source
is reread on every invocation, so additions and changes take effect without
registration or restart. Arguments after the script pass through unchanged,
including `--help`; stdin remains closed. Child exit codes are preserved and
SIGINT/SIGTERM are forwarded to the child.

Both output streams pass through the existing byte-oriented filter. It
redacts nonempty delivered values and supported base64 representations,
including matches split across chunks. This is accidental-output protection,
not a sandbox: transformations, files, network traffic and other exfiltration
are not covered. Scripts and their dependencies are trusted with all source
entries. Same-user processes are not isolated and may inspect child process
environments. Stronger isolation requires a separate principal or sandbox.

`<mc home>/keys/runs.jsonl` records value-free start and exit events: script,
source names, timestamps and exit status. `content_hash` is always `null`
because source verification does not occur. Script arguments and output are
not recorded. Failure to write the start event prevents launch; an interrupted
mc process may leave a start without an exit. The ordinary mc invocation log
also omits script arguments and flags.

`mc keys` is separate from Memoro vault custody: it does not login, unlock,
read a keychain, contact the vault service, import credentials, or create an
encrypted store. Production/admin restrictions for headless sessions are
unchanged.
