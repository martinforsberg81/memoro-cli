section: Fixed

- **Thrown test hooks are red, not red under load.** Merge rounds retain the
  hook's message and diagnostic for the author; only node's hook-timeout line
  qualifies for cancellation under load. Session gates never print GREEN for
  cancelled tests, including after settlement, and keep a non-green receipt.
