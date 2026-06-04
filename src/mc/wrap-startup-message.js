export function createStartupMessageController({
  message = null,
  delayMs,
  deliver,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  const hasMessage = typeof message === 'string' && message.length > 0;
  let sent = false;
  let cancelled = false;
  let pendingTimer = null;

  const clearPending = () => {
    if (pendingTimer !== null) {
      clearTimeoutFn(pendingTimer);
      pendingTimer = null;
    }
  };

  const sendNow = () => {
    if (!hasMessage || sent || cancelled) return false;
    sent = true;
    clearPending();
    if (typeof deliver === 'function') deliver(message);
    return true;
  };

  const schedule = () => {
    if (!hasMessage || sent || cancelled) return false;
    clearPending();
    pendingTimer = setTimeoutFn(sendNow, delayMs);
    return true;
  };

  const cancel = () => {
    cancelled = true;
    clearPending();
  };

  return {
    cancel,
    schedule,
    sendNow,
  };
}
