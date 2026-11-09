section: Added

- **`mc shot` pictures declared public pages.** A public page such as the
  landing at `/sv`, `/en` or `/da` is pictured signed out and in the locale
  its URL carries — no `/dev/login`, no token, no session, no locale or theme
  injected — but only when memoro's `.mc/shot.json` declares it as a target
  with `"public": true` and that exact `path`. `mc shot dev /sv` and
  `mc shot dev landing-sv` are the same picture. An undeclared public path is
  refused naming `.mc/shot.json` before a server starts, and `--account`,
  `--onboarding`, `--locale`, `--shell`, `--me`, `--keep` and `--compare` are
  refused with a public target. The request carries `sign_in: { kind: "none" }`,
  no `account` and `locale: null`.
