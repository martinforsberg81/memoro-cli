section: Changed

- **The runner no longer writes `runner/UPDATE` itself.** A landing under
  `src/mc/` or `canon/` used to order a handover, which drained every lane
  after nearly every memoro-cli merge. `mc run --update` is now the only
  writer; `askForUpdate`, `mcOwnFiles` and `MC_OWN_TREES` are gone.
