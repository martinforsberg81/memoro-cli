section: Fixed

- **Disk cleanup no longer blocks session starts.** Disk cleanup below 30 GB no longer holds up session starts when at least 20 GB is
  available. Cleanup and allocation use separate leases; starts still recheck
  the 20 GB floor immediately before spawning.
