section: Fixed

- **Dev servers start through mc keys.** App and static server commands now
  use `mc keys serve`, sharing the script runner's dotenv delivery, filtering
  and audit. Servers receive a names-only `MC_KEYS_NAMES` list for mapping
  values to Worker bindings. Measurements use the regular dev service.
