import { DEFAULT_TOOL } from '../lib/config.js';
import { resolveEffectivePolicy } from './policy.js';

export const MC_SESSION_LAUNCH_MODES = Object.freeze({
  NEW: 'new',
  RESUME: 'resume',
  CLOUD: 'cloud',
});

export const DEFAULT_CLOUD_SOURCE_NAME = 'Memoro Cloud';
const DEFAULT_POLICY = 'workspace-write';

export function buildNewSessionLaunchIntent({
  entry,
  worktreePath,
  focus = null,
  launchTool = null,
  apiArgv = [],
  env = process.env,
} = {}) {
  return {
    mode: MC_SESSION_LAUNCH_MODES.NEW,
    cwd: worktreePath,
    sessionName: entry?.name || null,
    label: null,
    focus: focus || null,
    tool: launchTool?.id || entry?.tool || DEFAULT_TOOL,
    argv: [],
    apiArgv,
    sendStartupMessage: true,
    attachAfterLaunch: true,
    env,
  };
}

export function buildResumeSessionLaunchIntent({
  entry,
  launchTool = null,
  resumeArgv = ['--resume'],
  apiArgv = [],
  env = process.env,
} = {}) {
  return {
    mode: MC_SESSION_LAUNCH_MODES.RESUME,
    cwd: entry?.worktree_path || null,
    sessionName: entry?.name || null,
    label: entry?.label || null,
    focus: entry?.label || null,
    tool: launchTool?.id || entry?.tool || DEFAULT_TOOL,
    argv: Array.isArray(resumeArgv) ? resumeArgv : ['--resume'],
    apiArgv,
    sendStartupMessage: false,
    attachAfterLaunch: true,
    env,
  };
}

export function buildCloudSessionLaunchIntent({
  cloud,
  cwd,
  env = process.env,
} = {}) {
  const sourceName = cloud?.sourceName || DEFAULT_CLOUD_SOURCE_NAME;
  const sourceId = cloud?.sourceId || `cloud:${cloud?.cloudSessionId || 'unknown'}`;
  const cloudSessionId = cloud?.cloudSessionId || null;
  return {
    mode: MC_SESSION_LAUNCH_MODES.CLOUD,
    cwd,
    sessionName: cloud?.name || null,
    label: null,
    focus: cloud?.task || null,
    tool: cloud?.launchTool || cloud?.tool || DEFAULT_TOOL,
    argv: [],
    apiArgv: [],
    sendStartupMessage: true,
    attachAfterLaunch: false,
    cloudBroker: {
      sourceId,
      sourceKind: 'cloud',
      sourceName,
      cloudSessionId,
    },
    env: buildCloudSessionEnv(env, {
      ...cloud,
      sourceId,
      sourceName,
      cloudSessionId,
    }),
    deps: {
      resolvePolicyForWrap: ({ tool }) => cloudPolicyForLaunch(cloud?.policy, tool || cloud?.tool),
    },
  };
}

export function buildCloudSessionEnv(baseEnv = process.env, cloud = {}) {
  return {
    ...(baseEnv || {}),
    MC_SOURCE_ID: cloud.sourceId,
    MC_SOURCE_KIND: 'cloud',
    MC_SOURCE_NAME: cloud.sourceName || DEFAULT_CLOUD_SOURCE_NAME,
    MC_CLOUD_SESSION_ID: cloud.cloudSessionId,
    MC_CLOUD_SESSION_POLICY: cloud.policy || DEFAULT_POLICY,
  };
}

export function cloudPolicyForLaunch(policy, tool) {
  const workspace = policy === 'read-only' ? 'read-only' : 'worktree';
  return resolveEffectivePolicy({
    tool,
    entry: {
      policy: {
        permissions: { workspace },
      },
    },
  });
}
