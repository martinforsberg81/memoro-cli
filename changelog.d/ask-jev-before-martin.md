section: Changed

- **`mc goal martin` asks jev before Martin.** A question for Martin now
  carries 2 to 4 options and the session's recommendation:
  `mc goal martin --reason "<question>" --option "<key>: <text>"… --recommend
  <key> [--evidence …] [--document <repo>/<path>]… [--reserved <act>]`. A call
  without them, and `mc goal log --status Martin`, exit 2 with a return
  instruction and write nothing (Martin, 2026-11-07). A session's question
  goes once to TypeSafe's jev (`jev-1.14.0`, pinned): when jev chooses the
  recommendation at p ≥ 0.90 with fits and settled ≥ 0.70, the status stays
  and mc prints `mc: jev answered <key> … — continue with: <text>`; otherwise,
  and on any jev failure, the goal is `Martin` with jev's reading. Reserved
  acts and a person's call never go to jev. The key is read by mc from the
  `mc keys` source and goes only into the Authorization header; keys-source
  values are redacted from the state and every output. Every call appends a
  line to `<mc home>/jev/decisions.jsonl`. `docs/technical/mc-jev.md` states
  the flow; the canon and `mc goal --help` give the call.
