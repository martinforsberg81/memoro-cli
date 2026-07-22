export const DEPENDENCY_MODES = Object.freeze(['auto', 'isolated', 'off']);
export const DEFAULT_DEPENDENCY_MODE = 'auto';

export function normalizeDependencyMode(value) {
  const mode = String(value || DEFAULT_DEPENDENCY_MODE).toLowerCase();
  return DEPENDENCY_MODES.includes(mode) ? mode : DEFAULT_DEPENDENCY_MODE;
}

export function resolveDependencyMode(config = {}) {
  return normalizeDependencyMode(config?.dev?.dependencies?.mode);
}

export function withDependencyMode(config = {}, mode = DEFAULT_DEPENDENCY_MODE) {
  const normalized = String(mode || '').toLowerCase();
  if (!DEPENDENCY_MODES.includes(normalized)) {
    throw new Error(`unknown dependency mode: ${mode}`);
  }
  return {
    ...config,
    dev: {
      ...(config.dev && typeof config.dev === 'object' ? config.dev : {}),
      dependencies: {
        ...(config.dev?.dependencies && typeof config.dev.dependencies === 'object'
          ? config.dev.dependencies
          : {}),
        mode: normalized,
      },
    },
  };
}

export function describeDependencyMode(mode) {
  if (mode === 'isolated') return 'isolated (install only in the current worktree)';
  if (mode === 'off') return 'off (mc never installs project dependencies)';
  return 'auto (reuse immutable local snapshots when available)';
}
