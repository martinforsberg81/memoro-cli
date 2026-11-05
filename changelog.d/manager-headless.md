section: Added

- **Run a Manager task headless on demand.** `mc manager --headless --prompt "…"`
  starts a fresh conversation with a configurable time limit and a result receipt.
  No automatic trigger is installed. Interactive Manager now opens in
  `~/mc/manager/`, while older `brief/` conversations remain resumable and
  `mc brief` remains an alias.
