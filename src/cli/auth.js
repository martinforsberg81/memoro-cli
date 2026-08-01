/**
 * `mc auth [status | memoro | github | claude | codex | gemini]` (§11a + §11c).
 *
 * `status` is the single-screen health check (§11a):
 *   1. Memoro keychain — token present?
 *   2. LLM tools — per-adapter getStatus() (Claude deep, Codex shallow,
 *      Gemini surfaced as planned)
 *   3. GitHub — central Memoro GitHub App readiness for this repository
 *   4. Shell wrapper — managed block present in zshrc/bashrc?
 *   5. Workspace — MC_HOME + registry + orphan-daemon counts
 *
 * Per-target helpers (§11c):
 *   - `mc auth memoro`               — alias for `memoro-cli login`
 *   - `mc auth memoro --logout`      — alias for `memoro-cli logout`
 *   - `mc auth memoro --status`      — print just the Memoro section
 *   - `mc auth <tool> [--status]`    — re-run that tool's probe + fix hint
 *
 * GitHub auth is deliberately control-plane-owned: mc reads token-free
 * connection metadata and never probes or imports a host `gh` login.
 * `mc auth` (no sub) defaults to `mc auth status` so the muscle-memory
 * `mc auth` works without ceremony.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSecret } from '../lib/keychain.js';
import { ACCOUNTS } from '../commands/auth.js';
import { DEFAULT_TOOL, readConfig } from '../lib/config.js';
import * as claudeCode from '../adapters/claude-code.js';
import * as codex from '../adapters/codex.js';
import { readRegistry } from '../mc/registry.js';
import { mcHome, mcHomeExists } from '../mc/paths.js';
import { scanDaemons } from '../mc/orphan-daemons.js';
import { inspectCachedVaultKey } from '../vault/engine/key-cache.js';
import { formatPolicySummary, readRepoPolicy, resolveEffectivePolicy } from '../mc/policy.js';
import { readRepoLocalConfig, resolveEffectiveConfig } from '../mc/config-model.js';
import { readGitHubConnectionStatus } from './github.js';
import { repairForGitHubState } from '../capabilities/github/github-contract.js';

const TOOL_ADAPTERS = {
  claude: { adapter: claudeCode, label: 'claude' },
  codex:  { adapter: codex,      label: 'codex'  },
};
// Gemini is surfaced as a planned row in `status`; per-target `mc auth
// gemini` reaches into the same stub probe so the user gets a consistent
// answer regardless of which entry point they hit.
const PLANNED_TOOLS = new Set(['gemini']);

const SHELL_WRAPPER_MARK = '# >>> memoro mc shell wrapper >>>';

export async function run(argv, deps = {}) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === 'status') return runStatus(rest, deps.github || deps);
  if (sub === 'memoro')                          return runAuthMemoro(rest);
  if (sub === 'devices')                         return runAuthDevices(rest);
  if (sub === 'github')                          return runAuthGitHub(rest, deps.github || deps);
  if (Object.prototype.hasOwnProperty.call(TOOL_ADAPTERS, sub)) return runAuthTool(sub, rest);
  if (PLANNED_TOOLS.has(sub))                    return runAuthTool(sub, rest);
  console.error(`mc: unknown auth subcommand "${sub}". Try \`mc auth status\`.`);
  return 2;
}

// ─────────────────────────────────────────────────────────────
// `mc auth devices [list | revoke <target>]` (§14e)
// ─────────────────────────────────────────────────────────────

async function runAuthDevices(argv) {
  // Lazy-import the devices module so the help / status fast paths stay
  // cold. Same idiom as the LIFECYCLE table in bin-mc.js.
  const mod = await import('./auth-devices.js');
  return mod.run(argv);
}

// ─────────────────────────────────────────────────────────────
// `mc auth memoro [--logout|--status] [--json]`
// ─────────────────────────────────────────────────────────────

async function runAuthMemoro(argv) {
  const opts = parseMemoroArgs(argv);
  if (opts.error) { console.error(`mc: ${opts.error}`); return 2; }

  if (opts.status) {
    const memoro = await probeMemoro();
    if (opts.json) {
      console.log(JSON.stringify({ memoro }, null, 2));
    } else {
      printMemoroSection(memoro);
    }
    return memoro.authenticated ? 0 : 1;
  }

  // Thin alias: shell out to `memoro-cli {login,logout} <passthrough>`
  // so we don't duplicate the token-routing logic that lives in
  // commands/auth.js (token via flag/env/stdin/prompt). Spawning via
  // node + bin.js avoids depending on memoro-cli being on PATH.
  // Unknown flags + positional args are forwarded verbatim — that's
  // what "alias" means.
  const action = opts.logout ? 'logout' : 'login';
  const memoroBin = resolveMemoroBin();
  const r = spawnSync(process.execPath, [memoroBin, action, ...opts.passthrough], {
    stdio: 'inherit',
  });
  return r.status ?? 1;
}

function printMemoroSection(memoro) {
  const mark = memoro.authenticated ? '✓' : '✗';
  process.stdout.write(`Memoro account:\n`);
  process.stdout.write(`  ${mark} ${memoro.authenticated ? 'token stored in keychain' : 'no token'}\n`);
  if (memoro.hint) process.stdout.write(`    → ${memoro.hint}\n`);
}

export function resolveMemoroBin() {
  // src/cli/auth.js → ../bin.js
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'bin.js');
}

export function parseMemoroArgs(argv) {
  const opts = { status: false, logout: false, json: false, passthrough: [] };
  for (const a of argv) {
    if (a === '--status') { opts.status = true; continue; }
    if (a === '--logout') { opts.logout = true; continue; }
    if (a === '--json')   { opts.json = true; continue; }
    // Everything else (including --token / MEMORO_TOKEN-equivalents)
    // forwards verbatim to memoro-cli login/logout. Thin alias.
    opts.passthrough.push(a);
  }
  if (opts.logout && opts.status) return { error: '--logout and --status are mutually exclusive' };
  return opts;
}

// ─────────────────────────────────────────────────────────────
// `mc auth github [--status] [--json]`
// ─────────────────────────────────────────────────────────────

async function runAuthGitHub(argv, deps = {}) {
  const mod = await import('./github.js');
  return mod.run(['status', ...argv.filter((arg) => arg !== '--status')], deps);
}

// ─────────────────────────────────────────────────────────────
// `mc auth <tool> [--status] [--json]`
// ─────────────────────────────────────────────────────────────

async function runAuthTool(tool, argv) {
  const opts = parseToolArgs(argv);
  if (opts.error) { console.error(`mc: ${opts.error}`); return 2; }

  const status = await getToolStatus(tool);
  if (opts.json) {
    console.log(JSON.stringify({ tool, ...status }, null, 2));
    return toolExitCode(status);
  }

  printToolSection(tool, status);
  return toolExitCode(status);
}

function toolExitCode(status) {
  if (!status.installed) return 1;
  if (status.authenticated === false) return 1;
  return 0;
}

export async function getToolStatus(tool) {
  if (Object.prototype.hasOwnProperty.call(TOOL_ADAPTERS, tool)) {
    return safeStatus(TOOL_ADAPTERS[tool].adapter);
  }
  if (tool === 'gemini') return plannedGeminiStatus();
  return {
    installed: false, version: null, authenticated: null,
    hint: `Unknown tool "${tool}"`, detailLines: [],
  };
}

function printToolSection(tool, status) {
  const label = TOOL_ADAPTERS[tool]?.label || tool;
  const bits = [];
  bits.push(status.installed ? (status.version || 'installed') : 'not installed');
  if (status.installed) {
    if (status.authenticated === true)  bits.push('authenticated');
    else if (status.authenticated === false) bits.push('NOT authenticated');
    else bits.push('auth: unknown');
  }
  if (PLANNED_TOOLS.has(tool)) bits.push('(planned)');
  const mark = status.installed && status.authenticated !== false ? '✓' : (status.installed ? '·' : '✗');
  process.stdout.write(`${mark} ${label.padEnd(10)}${bits.join(' · ')}\n`);
  if (status.hint) process.stdout.write(`    → ${status.hint}\n`);
  for (const detail of status.detailLines || []) {
    process.stdout.write(`    ${detail}\n`);
  }
}

function parseToolArgs(argv) {
  const opts = { status: false, json: false };
  for (const a of argv) {
    if (a === '--status') { opts.status = true; continue; }
    if (a === '--json')   { opts.json = true; continue; }
    return { error: `unknown flag: ${a}` };
  }
  return opts;
}

async function runStatus(argv, githubDeps = {}) {
  const opts = parseStatusArgs(argv);
  if (opts.error) { console.error(`mc: ${opts.error}`); return 2; }

  const [memoro, claude, codexStatus, gemini, github, shell, workspace, vault, config] = await Promise.all([
    probeMemoro(),
    safeStatus(claudeCode),
    safeStatus(codex),
    plannedGeminiStatus(),
    safeGitHubConnectionStatus(githubDeps),
    probeShellWrapper(),
    probeWorkspace(),
    probeVault(),
    safeReadConfig(),
  ]);
  const repoPolicy = readRepoPolicy();
  const repoLocal = readRepoLocalConfig();
  const policy = buildAuthPolicyReport({
    config,
    repoPolicy,
    repoLocalConfig: repoLocal.config,
    configWarnings: repoLocal.warnings,
  });

  const report = {
    memoro,
    tools: [
      { id: 'claude-code', label: 'claude',  ...claude       },
      { id: 'codex',       label: 'codex',   ...codexStatus  },
      { id: 'gemini-cli',  label: 'gemini',  ...gemini, planned: true },
    ],
    github,
    shell_wrapper: shell,
    workspace,
    vault,
    policy,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return overallExitCode(report);
  }

  printHuman(report);
  return overallExitCode(report);
}

function overallExitCode(report) {
  // 0 if Memoro authed AND at least one tool is usable. Some adapters
  // (Codex) cannot verify auth headlessly, so auth:null is a soft pass.
  if (!report.memoro.authenticated) return 1;
  const someUsableTool = report.tools.some((t) => t.installed && t.authenticated !== false);
  return someUsableTool ? 0 : 1;
}

function printHuman(r) {
  const tick = (v) => v === true ? '✓' : v === false ? '✗' : '·';
  process.stdout.write(`Memoro account:\n`);
  process.stdout.write(`  ${tick(r.memoro.authenticated)} ${r.memoro.authenticated ? 'token stored in keychain' : 'no token'}\n`);
  if (r.memoro.hint) process.stdout.write(`    → ${r.memoro.hint}\n`);
  process.stdout.write(`\nLLM tools on this machine:\n`);
  for (const t of r.tools) {
    const statusBits = [];
    statusBits.push(t.installed ? (t.version || 'installed') : 'not installed');
    if (t.installed) {
      if (t.authenticated === true)  statusBits.push('authenticated');
      else if (t.authenticated === false) statusBits.push('NOT authenticated');
      else statusBits.push('auth: unknown');
    }
    if (t.planned) statusBits.push('(planned)');
    const mark = t.installed && t.authenticated !== false ? '✓' : (t.installed ? '·' : '✗');
    process.stdout.write(`  ${mark} ${t.label.padEnd(10)}${statusBits.join(' · ')}\n`);
    if (t.hint) process.stdout.write(`    → ${t.hint}\n`);
  }
  process.stdout.write(`\nGitHub (Memoro App):\n`);
  printGitHubConnectionStatus(r.github, '  ');
  process.stdout.write(`\nShell wrapper:\n`);
  process.stdout.write(`  ${tick(r.shell_wrapper.installed)} ${r.shell_wrapper.installed ? `installed in ${r.shell_wrapper.rc}` : 'not installed'}\n`);
  if (r.shell_wrapper.hint) process.stdout.write(`    → ${r.shell_wrapper.hint}\n`);
  if (r.vault) {
    process.stdout.write(`\nVault:\n`);
    if (r.vault.cache_present) {
      const mins = Math.max(1, Math.round((r.vault.cache_expires_in_ms || 0) / 60_000));
      process.stdout.write(`  ✓ unlocked — ${mins} min${mins === 1 ? '' : 's'} until lock\n`);
    } else {
      process.stdout.write(`  · locked\n`);
      process.stdout.write(`    → Run \`mc vault unlock\` to cache the key for 15 min\n`);
    }
  }
  if (r.policy) {
    process.stdout.write(`\nPolicy:\n`);
    process.stdout.write(`  default tool ${r.policy.default_tool || DEFAULT_TOOL}\n`);
    for (const row of r.policy.tools || []) {
      process.stdout.write(`  ${formatPolicySummary(row.effective_policy)}\n`);
    }
  }
  process.stdout.write(`\nWorkspace:\n`);
  process.stdout.write(`  ${tick(r.workspace.mc_home_exists)} MC_HOME = ${r.workspace.mc_home}\n`);
  process.stdout.write(`  ${tick(true)} Registry: ${r.workspace.session_count} session${r.workspace.session_count === 1 ? '' : 's'}\n`);
  if (r.workspace.orphan_daemon_count > 0 || r.workspace.stale_pidfile_count > 0) {
    const bits = [];
    if (r.workspace.orphan_daemon_count > 0) bits.push(`${r.workspace.orphan_daemon_count} orphan-daemon${r.workspace.orphan_daemon_count === 1 ? '' : 's'}`);
    if (r.workspace.stale_pidfile_count > 0) bits.push(`${r.workspace.stale_pidfile_count} stale pidfile${r.workspace.stale_pidfile_count === 1 ? '' : 's'}`);
    process.stdout.write(`  ⚠ ${bits.join(', ')} — run \`mc gc --reap-orphans\`\n`);
  }
}

async function safeReadConfig() {
  try {
    return await readConfig();
  } catch {
    return {};
  }
}

export function buildAuthPolicyReport({
  config = {},
  repoPolicy = null,
  repoLocalConfig = null,
  configWarnings = [],
} = {}) {
  return {
    default_tool: config.defaultTool || DEFAULT_TOOL,
    effective_config: resolveEffectiveConfig({
      globalConfig: config,
      repoPolicy,
      localConfig: repoLocalConfig,
      warnings: configWarnings,
    }),
    tools: ['claude', 'codex', 'gemini'].map((tool) => ({
      tool,
      effective_policy: resolveEffectivePolicy({ tool, repoPolicy, config }),
    })),
  };
}

export async function probeMemoro() {
  try {
    const token = await getSecret(ACCOUNTS.TOKEN);
    if (token) {
      return { authenticated: true, hint: null };
    }
    return { authenticated: false, hint: 'Run `memoro-cli login` to store a token' };
  } catch (err) {
    return { authenticated: null, hint: `Keychain probe failed: ${err.message}` };
  }
}

async function safeStatus(adapter) {
  try {
    const s = await adapter.getStatus();
    return s;
  } catch (err) {
    return {
      installed: false,
      version: null,
      authenticated: null,
      hint: `Probe failed: ${err.message}`,
      detailLines: [],
    };
  }
}

/**
 * Gemini CLI doesn't have a full adapter yet (tracked in adapters/index.js
 * as planned). Produce a minimal status row so the auth-status output
 * is consistent with the plan §11a layout: row exists, surface says
 * "not installed (planned)" with an install hint.
 */
export async function plannedGeminiStatus() {
  // Best-effort `which gemini`: if the user already has it on PATH we
  // surface that fact even though we don't yet integrate with it. Same
  // friendly hint contract as Codex (auth: unknown).
  try {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('which', ['gemini'], { encoding: 'utf8' });
    const path = r.status === 0 ? (r.stdout || '').trim() : null;
    if (path) {
      return {
        installed: true,
        version: null,
        authenticated: null,
        hint: 'Gemini CLI adapter is planned; run `gemini` to verify',
        detailLines: [`bin: ${path}`],
      };
    }
  } catch { /* fall through */ }
  return {
    installed: false,
    version: null,
    authenticated: null,
    hint: 'Install with: npm install -g @google/gemini-cli (adapter is planned)',
    detailLines: [],
  };
}

/**
 * §12f surface: surface the vault-key cache state so users can debug
 * "why aren't my tokens materialising?". Reads the keychain entry
 * via inspectCachedVaultKey, which never imports the key itself.
 */
export async function probeVault() {
  try {
    const info = await inspectCachedVaultKey();
    return {
      cache_present: !!info.present,
      cache_expires_at: info.expiresAt || null,
      cache_expires_in_ms: info.expiresInMs || 0,
    };
  } catch (err) {
    return {
      cache_present: false,
      cache_expires_at: null,
      cache_expires_in_ms: 0,
      hint: `vault probe failed: ${err.message}`,
    };
  }
}

export async function safeGitHubConnectionStatus(deps = {}) {
  try {
    return (await readGitHubConnectionStatus(deps)).github;
  } catch {
    return {
      schema: 1,
      state: 'unavailable',
      repair_action: 'retry',
      actor: { type: 'installation', login: 'memoro[bot]' },
      accounts: [],
      repository: null,
      repositories: [],
      operations: [],
    };
  }
}

function printGitHubConnectionStatus(status, indent = '') {
  if (status.state === 'ready') {
    const target = status.repository ? ` for ${status.repository.full_name}` : '';
    process.stdout.write(`${indent}✓ connected${target}\n`);
    return;
  }
  process.stdout.write(`${indent}✗ ${status.state.replaceAll('_', ' ')}\n`);
  const repair = repairForGitHubState(status.state);
  if (repair) process.stdout.write(`${indent}  → ${repair.message} Run \`${repair.command}\`.\n`);
}

export function probeShellWrapper() {
  // Check both zsh and bash rc files for the managed block marker.
  const home = homedir();
  const candidates = [join(home, '.zshrc'), join(home, '.bashrc')];
  for (const rc of candidates) {
    try {
      if (!existsSync(rc)) continue;
      const body = readFileSync(rc, 'utf8');
      if (body.includes(SHELL_WRAPPER_MARK)) {
        return { installed: true, rc, hint: null };
      }
    } catch { /* permissions etc. — skip */ }
  }
  return {
    installed: false,
    rc: null,
    hint: 'Run `mc install-shell` so `mc cd <name>` can change your shell cwd',
  };
}

export function probeWorkspace() {
  const home = mcHome();
  const exists = mcHomeExists();
  let sessionCount = 0;
  try { sessionCount = readRegistry().entries.length; } catch { /* empty */ }
  let orphanCount = 0;
  let staleCount = 0;
  try {
    const scan = scanDaemons();
    orphanCount = scan.orphan.length;
    staleCount = scan.stale.length;
  } catch { /* best effort */ }
  return {
    mc_home: home,
    mc_home_exists: exists,
    session_count: sessionCount,
    orphan_daemon_count: orphanCount,
    stale_pidfile_count: staleCount,
  };
}

function parseStatusArgs(argv) {
  const opts = { json: false };
  for (const a of argv) {
    if (a === '--json') { opts.json = true; continue; }
    return { error: `unknown flag: ${a}` };
  }
  return opts;
}
