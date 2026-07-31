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
  let settleDelivery;
  const delivery = new Promise((resolve) => {
    settleDelivery = resolve;
  });

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
    try {
      if (typeof deliver === 'function') deliver(message);
      settleDelivery({ ok: true });
    } catch {
      settleDelivery({ ok: false, reason: 'pty-message-delivery-failed' });
    }
    return true;
  };

  const schedule = () => {
    if (!hasMessage || sent || cancelled) return false;
    clearPending();
    pendingTimer = setTimeoutFn(sendNow, delayMs);
    return true;
  };

  const pause = () => {
    if (!hasMessage || sent || cancelled || pendingTimer === null) return false;
    clearPending();
    return true;
  };

  const cancel = (reason = 'pty-message-delivery-cancelled') => {
    if (cancelled || sent) return;
    cancelled = true;
    clearPending();
    settleDelivery({ ok: false, reason });
  };

  if (!hasMessage) settleDelivery({ ok: true, skipped: true });

  return {
    cancel,
    pause,
    schedule,
    sendNow,
    waitForDelivery: () => delivery,
  };
}
