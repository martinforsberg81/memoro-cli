/**
 * Loaded before the tests of every batch the gate runs (`--import`, in
 * `runTestBatch`), in the batch's own process and in each test file's. On macOS
 * a write to a pipe is asynchronous, and a test file's process that ends with
 * `--test-force-exit` exits as its tests end, dropping the report still queued
 * on that pipe: the batch then reads fewer tests than exist and exits 0 (an
 * "output cut"). Blocking writes put each report on the pipe before the exit.
 * A stream with no handle that can block is left as it is.
 */
for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true);
