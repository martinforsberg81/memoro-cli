export const LOCAL_AUTH_MODES = Object.freeze({
  NATIVE: 'native',
  MANAGED_PORTABLE: 'managed-portable',
});

export const LOCAL_AUTH_STATES = Object.freeze({
  NATIVE_UNMANAGED: 'native-unmanaged',
  MANAGED_REQUESTED: 'managed-requested',
  MANAGED_UNAVAILABLE: 'managed-unavailable',
});

export const LOCAL_MANAGED_UNAVAILABLE_REASON = 'managed-portable-topology-unavailable';
const MANAGED_PORTABLE_COMMANDS = new Set(['new', 'open', 'resume']);

/**
 * The portable path is an explicit launch request until its containment
 * topology is certified. Repo config, inherited environment, and stored
 * session state are deliberately not inputs to this resolver.
 */
export function resolveLocalAuthMode({ managedPortable = false } = {}) {
  return managedPortable === true
    ? LOCAL_AUTH_MODES.MANAGED_PORTABLE
    : LOCAL_AUTH_MODES.NATIVE;
}

/**
 * Recognize the opt-in only on the lifecycle surfaces that own it. Bare mc,
 * wrap, and coding-tool argv retain their existing meaning.
 */
export function resolveLocalAuthModeFromArgv(argv = []) {
  if (!Array.isArray(argv) || !MANAGED_PORTABLE_COMMANDS.has(argv[0])) {
    return LOCAL_AUTH_MODES.NATIVE;
  }
  return resolveLocalAuthMode({
    managedPortable: argv.slice(1).includes('--managed-portable'),
  });
}

/**
 * Gate a local launch before it can inspect device identity, custody, native
 * tool auth, or any credential-backed capability.
 *
 * Native mode remains the existing host-owned path. Managed portable mode is
 * only an explicit request here; the launch owner must still verify the exact
 * provider release, OS boundary, hostile canary probe, and custody readiness.
 * No failure in those gates may downgrade to native.
 */
export function evaluateLocalAuthMode(mode = LOCAL_AUTH_MODES.NATIVE) {
  if (mode === LOCAL_AUTH_MODES.NATIVE) {
    return {
      ok: true,
      mode,
      state: LOCAL_AUTH_STATES.NATIVE_UNMANAGED,
      portable: false,
    };
  }

  if (mode === LOCAL_AUTH_MODES.MANAGED_PORTABLE) {
    return {
      ok: true,
      mode,
      state: LOCAL_AUTH_STATES.MANAGED_REQUESTED,
      portable: false,
      certified: false,
    };
  }

  return {
    ok: false,
    mode: null,
    state: LOCAL_AUTH_STATES.MANAGED_UNAVAILABLE,
    portable: false,
    reason: 'invalid-local-auth-mode',
    error: 'invalid local auth mode',
  };
}

export function requireLocalAuthMode(mode = LOCAL_AUTH_MODES.NATIVE) {
  return evaluateLocalAuthMode(mode);
}
