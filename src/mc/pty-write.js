/**
 * Send a dispatched/startup message into a wrapped tool session. Appends a
 * carriage return so the TUI submits the prompt. Some TUIs need a second Enter
 * after the text has landed, so the adapter launch spec can request delayed
 * extra carriage returns.
 */
export function writeToPty(ptyProcess, message, {
  submitEnterCount = 1,
  submitEnterDelayMs = 150,
  setTimeoutFn = globalThis.setTimeout,
} = {}) {
  ptyProcess.write(message + '\r');
  for (let i = 1; i < submitEnterCount; i += 1) {
    setTimeoutFn(() => ptyProcess.write('\r'), submitEnterDelayMs * i);
  }
}
