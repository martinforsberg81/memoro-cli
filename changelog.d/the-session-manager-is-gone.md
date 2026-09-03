section: Removed

- **The session manager under `mc` is gone.** A registry, a broker, a PTY
  host, managed providers, cloud runtimes and a capability dispatcher were the
  product before this one, and on 2026-08-29 71 % of `src/` was unreachable
  from the page and the verbs `mc --help` describes. `src/` is now 153 files
  and 40 945 lines where it was 281 and 80 345; `tests/` went from 263 files
  to 155 and `docs/plans/` from 34 to 2, and the reachability run reports 0 %
  unreached. The order was the method rather than a grep: the verb left a
  router first, and only what nothing else reached was then deleted, so every
  cut is one revert. Fourteen verbs went off the two tables — `setup`,
  `install-shell`, `auth`, `tool-auth`, `connections`, `github`,
  `coding-profile`, `dev`, `deps`, `cloud-session`, `cloud-runtime`,
  `security`, `doctor`, `migrate` — with `pm` and `pm-helper`, the workarea
  `handoff` concept and the workarea `inbox` channel. What is left is
  `src/mc-cli.js` with the page and twelve verbs, and `src/bin-mc.js` with
  `mc vault`. Three things survive that no verb reaches and each is named
  rather than left to be found: vault's carcass (9 451 lines the two
  `credential-domain` files import at module top level, kept so those two can
  load), `memoro` / `memoro-cli` (20 files behind `package.json`'s other two
  `bin` entries, which no step earned the right to delete), and four files
  spawned by a path literal that no import graph can see. The measurement is
  kept as `npm run reach`; what mc is made of afterwards is
  `docs/technical/mc-cut.md`.
