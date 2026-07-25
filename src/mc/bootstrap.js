/**
 * Tool bootstrap (mc-contract §7, V1).
 *
 * On a fresh device: `mc setup --bootstrap` installs the missing coding
 * tools and signs them in from custody (S3 tool-auth), so the sign-in loop
 * ends with a working environment — no manual setup.
 *
 * Supply-chain posture: installs run npm against the OFFICIAL package names
 * pinned below — never a name derived from server data or hints. npm's own
 * registry TLS + integrity checks are the v1 boundary; signature
 * verification beyond that is future hardening (tracked in the contract).
 */

import { spawn } from 'node:child_process';

export const TOOL_PACKAGES = Object.freeze({
  claude: Object.freeze({
    tool: 'claude',
    label: 'Claude Code',
    packageName: '@anthropic-ai/claude-code',
    bin: 'claude',
  }),
  codex: Object.freeze({
    tool: 'codex',
    label: 'Codex CLI',
    packageName: '@openai/codex',
    bin: 'codex',
  }),
  // gemini: no official install target wired yet (adapter is a stub).
});

/**
 * Pure: which tools need installing, given the setup report's tool
 * statuses ({ claude: {installed,...}, codex: {...} }).
 */
export function installPlanFor(toolStatuses = {}) {
  const plan = [];
  for (const spec of Object.values(TOOL_PACKAGES)) {
    const status = toolStatuses[spec.tool];
    if (status && status.installed === false) {
      plan.push({
        ...spec,
        command: `npm install -g ${spec.packageName}`,
      });
    }
  }
  return plan;
}

/**
 * Pure: which installed tools can be signed in from custody. `authenticated
 * === false` is the only actionable state; null (can't verify headlessly)
 * is left alone — hydrating over an unknown state risks clobbering a live
 * login, and hydrate itself refuses overwrite without --force anyway.
 */
export function hydratePlanFor(toolStatuses = {}) {
  const plan = [];
  for (const spec of Object.values(TOOL_PACKAGES)) {
    const status = toolStatuses[spec.tool];
    if (status && status.installed === true && status.authenticated === false) {
      plan.push({ ...spec, command: `mc vault hydrate ${spec.tool}` });
    }
  }
  return plan;
}

/**
 * Run one install. Streams npm's output to the user's terminal — an
 * install is a loud, consented act, not a hidden one.
 */
export function installTool(item, { spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl('npm', ['install', '-g', item.packageName], {
      stdio: 'inherit',
    });
    child.on('error', (err) => resolve({ ok: false, tool: item.tool, error: err.message }));
    child.on('close', (code) => resolve({
      ok: code === 0,
      tool: item.tool,
      ...(code === 0 ? {} : { error: `npm exited with code ${code}` }),
    }));
  });
}
