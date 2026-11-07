section: Changed

- **A gate that reused every file says so in its verdict line.** When `mc gate` resumed every selected file from earlier runs on identical content, the worker wrote no test output, so the headline read `GREEN — <command> — no counts in the output — 2s`, which looked like lost counts; it now reads `reused N files and M commands, 0 run`, and the RESUMED line after it is unchanged. A run that printed counts keeps them, and a run that reused nothing still says `no counts in the output`.
