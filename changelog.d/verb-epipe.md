section: Fixed

- **A verb whose stdout reader closes early ends quietly.** `mc project discard x | grep -q 'would remove'` and `mc … | head -1` used to print `Error: write EPIPE` and a stack trace on stderr when the reader exited before the verb finished writing. `runModule` now notes the closed pipe and drops the writes that follow it; the verb's own exit code still stands, and any other error still reaches stderr.
