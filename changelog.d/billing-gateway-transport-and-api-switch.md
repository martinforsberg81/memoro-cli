section: Fixed

- **The API reserve now carries long Codex sessions and no longer stops the
  runner, and each provider's reserve can be switched off.** A resumed
  legal-readiness thread sent 8.3 MB per request, right under the gateway's
  8 MiB limit: the next turn would have been refused, and a refusal arrived
  mid-upload. The limit is 64 MiB, an oversized body is read to its end
  before the 413, and Codex's `responses/compact` has a route. A headless
  Codex step on the reserve panicked writing to the stdout it shared with the
  wrapper (`os error 35`); off a terminal the wrapper now gives the tool pipes
  of its own. That crash read as a quota because its stream quoted a plan
  that said "quota", and every lane slept 30 minutes: a Codex quota is now
  read only from its `error` and `turn.failed` events and stderr.
  `mc run --billing <claude|codex> <on|off>` switches a provider's API
  reserve; off, a spent plan stays the plan and the wrapper never opens the
  key.
