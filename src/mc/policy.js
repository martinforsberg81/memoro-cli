/**
 * Tool-neutral policy visibility.
 *
 * Phase 1 is intentionally descriptive: it explains what mc would do for a
 * session without writing tool config, changing vault matching, or mutating
 * native auth. Later phases can render this policy into adapters.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const PERMISSION_FIELDS = Object.freeze(Object.keys(DEFAULT_PERMISSIONS));

export function resolveEffectivePolicy({ entry = {}, tool = null, repoPolicy = null, config = {} } = {}) {
  const selectedTool = normaliseTool(tool || entry.tool || config.defaultTool || 'claude');
  const selected = selectPolicySource({ entryPolicy: entry.policy, repoPolicy, globalPolicy: config.policy });
  const permissions = {
    ...DEFAULT_PERMISSIONS,
    ...(selected.policy?.permissions && typeof selected.policy.permissions === 'object' ? selected.policy.permissions : {}),
    source: selected.source,
    rendered_for: selectedTool,
  };

  const legacyTargets = LEGACY_PROVIDER_TARGETS[selectedTool] || [];
  const materialisationTargets = legacyTargets.map((target) => ({
    tool: selectedTool,
    ...target,
  }));

  return {
    permissions,
    adapter_support: {
      tool: selectedTool,
      permissions: permissionSupportForTool(selectedTool),
    },
    secrets: {
      vault_required: materialisationTargets.length > 0,
      native_auth_owned_by_tool: materialisationTargets.length === 0,
      materialisation_targets: materialisationTargets,
    },
  };
}

export function readRepoPolicy({ worktreePath = null, cwd = process.cwd(), exists = existsSync, readFile = readFileSync } = {}) {
  const root = worktreePath || cwd;
  if (!root) return null;
  const path = join(root, '.mc', 'policy.json');
  if (!exists(path)) return null;
  try {
    const parsed = JSON.parse(readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function selectPolicySource({ entryPolicy, repoPolicy, globalPolicy }) {
  if (entryPolicy && typeof entryPolicy === 'object') return { source: 'session', policy: entryPolicy };
  if (repoPolicy && typeof repoPolicy === 'object') return { source: 'repo', policy: repoPolicy };
  if (globalPolicy && typeof globalPolicy === 'object') return { source: 'global', policy: globalPolicy };
  return { source: 'default', policy: null };
}

function permissionSupportForTool(_tool) {
  return Object.fromEntries(PERMISSION_FIELDS.map((field) => [field, 'unsupported']));
}

function normaliseTool(tool) {
  if (tool === 'claude-code') return 'claude';
  if (tool === 'gemini-cli') return 'gemini';
  if (tool === 'codex' || tool === 'claude' || tool === 'gemini') return tool;
  return String(tool || 'claude');
}
