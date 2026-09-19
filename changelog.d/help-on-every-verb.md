section: Fixed

- **`mc <verb> --help` and `-h` answer on every verb.** They were
  `unknown flag: --help` and the usage on stderr, exit 2, on every verb but
  `deploy` — a step session hit it twice on `mc test dev --help` (2026-09-11)
  and it was logged as a failed mc call. The dispatcher answers once, before
  the verb's own scanner sees the argument: the verb's `usage()` on stdout,
  exit 0, whatever sub-verb came before. Every verb in the table now exports
  `usage()`; `deploy`'s private `--help` flag is gone.
