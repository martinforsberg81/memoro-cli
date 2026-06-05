/**
 * Tool-neutral policy visibility.
 *
 * Phase 1 is intentionally descriptive: it explains what mc would do for a
 * session without writing tool config, changing vault matching, or mutating
 * native auth. Later phases can render this policy into adapters.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POLICY_SUPPORT as CLAUDE_POLICY_SUPPORT } from '../adapters/claude-code.js';
import { POLICY_SUPPORT as CODEX_POLICY_SUPPORT } from '../adapters/codex.js';

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
  const selectedPermissions = selected.policy?.permissions && typeof selected.policy.permissions === 'object'
    ? selected.policy.permissions
    : {};
  const permissions = {
    ...DEFAULT_PERMISSIONS,
    ...selectedPermissions,
    source: selected.source,
    rendered_for: selectedTool,
  };
  const explicit_permissions = PERMISSION_FIELDS.filter((field) => (
    Object.prototype.hasOwnProperty.call(selectedPermissions, field)
  ));

  const legacyTargets = LEGACY_PROVIDER_TARGETS[selectedTool] || [];
  const materialisationTargets = legacyTargets.map((target) => ({
    tool: selectedTool,
    ...target,
  }));

  return {
    permissions,
    explicit_permissions,
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

export function formatPolicySummary(policy) {
  const tool = policy?.permissions?.rendered_for || 'claude';
  const targets = policy?.secrets?.materialisation_targets || [];
  const unsupported = unsupportedPermissionFields(policy);
  const supportSuffix = unsupported.length ? `; permissions unsupported: ${unsupported.join(', ')}` : '';
  if (!targets.length) return `${tool}: native auth owned by tool; no vault target${supportSuffix}`;
  const labels = targets.map((t) => `${t.provider || t.tool}/${t.source || 'target'}`).join(', ');
  return `${tool}: vault targets ${labels}${supportSuffix}`;
}

export function unsupportedPermissionFields(policy) {
  const permissions = policy?.adapter_support?.permissions;
  if (!permissions || typeof permissions !== 'object') return [];
  return Object.entries(permissions)
    .filter(([, support]) => support === 'unsupported')
    .map(([field]) => field);
}

function selectPolicySource({ entryPolicy, repoPolicy, globalPolicy }) {
  if (entryPolicy && typeof entryPolicy === 'object') return { source: 'session', policy: entryPolicy };
  if (repoPolicy && typeof repoPolicy === 'object') return { source: 'repo', policy: repoPolicy };
  if (globalPolicy && typeof globalPolicy === 'object') return { source: 'global', policy: globalPolicy };
  return { source: 'default', policy: null };
}

function permissionSupportForTool(_tool) {
  const support = {
    claude: CLAUDE_POLICY_SUPPORT,
    codex: CODEX_POLICY_SUPPORT,
  }[_tool];
  return {
    ...Object.fromEntries(PERMISSION_FIELDS.map((field) => [field, 'unsupported'])),
    ...(support?.permissions || {}),
  };
}

function normaliseTool(tool) {
  if (tool === 'claude-code') return 'claude';
  if (tool === 'gemini-cli') return 'gemini';
  if (tool === 'codex' || tool === 'claude' || tool === 'gemini') return tool;
  return String(tool || 'claude');
}
