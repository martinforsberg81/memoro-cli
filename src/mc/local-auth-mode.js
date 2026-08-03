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
 * Named lifecycle launches default to the managed credential boundary.
 * Repo config, inherited environment, and stored session state are
 * deliberately not inputs to this resolver.
 *
 * There is no argument, configuration, or environment input that can select a
 * different lifecycle execution path.
 */
export function resolveLocalAuthMode() {
  return LOCAL_AUTH_MODES.MANAGED_PORTABLE;
}

/**
 * Named lifecycle surfaces use managed custody without a special flag. Bare
 * mc, wrap, and coding-tool argv retain their existing meaning until their
 * separate lifecycle cutover is complete.
 */
export function resolveLocalAuthModeFromArgv(argv = []) {
  if (!Array.isArray(argv) || !MANAGED_PORTABLE_COMMANDS.has(argv[0])) {
    return LOCAL_AUTH_MODES.NATIVE;
  }
  return LOCAL_AUTH_MODES.MANAGED_PORTABLE;
}

/**
 * Gate a local launch before it can inspect device identity, custody, native
 * tool auth, or any credential-backed capability.
 *
 * Native mode remains the internal host-owned compatibility path. The managed
 * launch owner must still verify the exact provider release, OS boundary,
 * hostile canary probe, and custody readiness. No failure in those gates may
 * downgrade to native.
 */
export function evaluateLocalAuthMode(mode = LOCAL_AUTH_MODES.MANAGED_PORTABLE) {
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

export function requireLocalAuthMode(mode = LOCAL_AUTH_MODES.MANAGED_PORTABLE) {
  return evaluateLocalAuthMode(mode);
}
