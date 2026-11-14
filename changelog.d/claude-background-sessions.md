section: Changed

- Linux SSH Claude entrances now start provider-owned background sessions and
  reattach without tmux. Several sessions can share a desk; the entrance offers
  join/new, avoids resuming held conversations twice, and preserves per-session
  identity, billing and page registration across disconnects. Codex keeps its
  existing tmux transport; macOS and headless launches are unchanged.
