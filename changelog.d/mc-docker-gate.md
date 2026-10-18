section: Changed

- **`mc gate` starts Docker for a selection that needs it.** The lease names the detached gate's pid, so a gate that answers RUNNING and keeps going still holds the runtime until it ends.
