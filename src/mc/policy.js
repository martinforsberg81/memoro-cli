/**
 * Tool-neutral policy visibility.
 *
 * Phase 1 is intentionally descriptive: it explains what mc would do for a
 * session without writing tool config, changing vault matching, or mutating
 * native auth. Later phases can render this policy into adapters.
 */

const LEGACY_PROVIDER_TARGETS = Object.freeze({
  claude: [{ provider: 'anthropic', source: 'legacy-provider-mapping', target_auth_mode: 'api_key' }],
  codex: [],
  gemini: [],
});

const DEFAULT_PERMISSIONS = Object.freeze({
  profile: 'default',
  workspace: 'worktree',
  network: 'tool-default',
  approval: 'tool-default',
  secrets: 'mc-vault-explicit',
});

export function resolveEffectivePolicy({ entry = {}, tool = null, config = {} } = {}) {
  const selectedTool = normaliseTool(tool || entry.tool || config.defaultTool || 'claude');
  const policy = entry.policy || config.policy || null;
  const source = entry.policy ? 'session' : config.policy ? 'config' : 'default';
  const permissions = {
    ...DEFAULT_PERMISSIONS,
    ...(policy?.permissions && typeof policy.permissions === 'object' ? policy.permissions : {}),
    source,
    rendered_for: selectedTool,
  };

  const legacyTargets = LEGACY_PROVIDER_TARGETS[selectedTool] || [];
  const materialisationTargets = legacyTargets.map((target) => ({
    tool: selectedTool,
    ...target,
  }));

  return {
    permissions,
    secrets: {
      vault_required: materialisationTargets.length > 0,
      native_auth_owned_by_tool: materialisationTargets.length === 0,
      materialisation_targets: materialisationTargets,
    },
  };
}

function normaliseTool(tool) {
  if (tool === 'claude-code') return 'claude';
  if (tool === 'gemini-cli') return 'gemini';
  if (tool === 'codex' || tool === 'claude' || tool === 'gemini') return tool;
  return String(tool || 'claude');
}
