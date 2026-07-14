export const CLOUD_RUNTIME_CONTRACT_VERSION = 'mc-cloud-runtime-v1';

export const CLOUD_LIFECYCLE = Object.freeze({
  REQUESTED: 'requested',
  RUNTIME_TOKEN_MINTED: 'runtime_token_minted',
  WAKING: 'waking',
  BROKER_CONNECTING: 'broker_connecting',
  READY: 'ready',
  SLEEPING: 'sleeping',
  FAILED: 'failed',
  STOPPED: 'stopped',
});

export function cloudRuntimePhaseSemantics(phase) {
  const normalized = stringOrDefault(phase, CLOUD_LIFECYCLE.READY);
  const stopped = normalized === CLOUD_LIFECYCLE.STOPPED;
  const failed = normalized === CLOUD_LIFECYCLE.FAILED;
  const sleeping = normalized === CLOUD_LIFECYCLE.SLEEPING;
  const live = normalized === CLOUD_LIFECYCLE.READY;
  const wakeable = normalized === 'runtime_pending' || sleeping;
  const continueAction = live
    ? 'live'
    : wakeable
      ? 'wake'
      : stopped || failed
        ? null
        : 'wait';
  return {
    phase: normalized,
    live,
    wakeable,
    canContinue: !stopped && !failed,
    continueAction,
    stopped,
    failed,
    sleeping,
  };
}

function stringOrDefault(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
