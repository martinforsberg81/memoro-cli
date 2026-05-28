/**
 * `mc auth status [--json]` (§11a).
 *
 * Single-screen health check: is mc ready to use on this machine?
 * Composes four probes:
 *   1. Memoro keychain — token present? (no network call in the hot path)
 *   2. LLM tools — per-adapter getStatus() (Claude deep, Codex shallow,
 *      Gemini surfaced as planned)
 *   3. Shell wrapper — managed block present in zshrc/bashrc?
 *   4. Workspace — MC_HOME exists? registry has entries?
 *
 * `mc auth` (no sub) defaults to `mc auth status` so the muscle-memory
 * `mc auth` works without ceremony. Other subcommands (`memoro`, `<tool>`)
 * are added in §11c.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getSecret } from '../../lib/keychain.js';
import { ACCOUNTS } from '../../commands/auth.js';
import * as claudeCode from '../../adapters/claude-code.js';
import * as codex from '../../adapters/codex.js';
import { readRegistry } from '../registry.js';
import { mcHome, mcHomeExists } from '../paths.js';

const SHELL_WRAPPER_MARK = '# >>> memoro mc shell wrapper >>>';

export async function run(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === 'status') return runStatus(rest);
  console.error(`mc: unknown auth subcommand "${sub}". Try \`mc auth status\`.`);
  return 2;
}

async function runStatus(argv) {
  const opts = parseStatusArgs(argv);
  if (opts.error) { console.error(`mc: ${opts.error}`); return 2; }

  const [memoro, claude, codexStatus, gemini, shell, workspace] = await Promise.all([
    probeMemoro(),
    safeStatus(claudeCode),
    safeStatus(codex),
    plannedGeminiStatus(),
    probeShellWrapper(),
    probeWorkspace(),
  ]);

  const report = {
    memoro,
    tools: [
      { id: 'claude-code', label: 'claude',  ...claude       },
      { id: 'codex',       label: 'codex',   ...codexStatus  },
      { id: 'gemini-cli',  label: 'gemini',  ...gemini, planned: true },
    ],
    shell_wrapper: shell,
    workspace,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return overallExitCode(report);
  }

  printHuman(report);
  return overallExitCode(report);
}

function overallExitCode(report) {
  // 0 if Memoro authed AND at least one tool installed-and-authed.
  if (!report.memoro.authenticated) return 1;
  const someAuthedTool = report.tools.some((t) => t.installed && t.authenticated === true);
  return someAuthedTool ? 0 : 1;
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
  process.stdout.write(`\nShell wrapper:\n`);
  process.stdout.write(`  ${tick(r.shell_wrapper.installed)} ${r.shell_wrapper.installed ? `installed in ${r.shell_wrapper.rc}` : 'not installed'}\n`);
  if (r.shell_wrapper.hint) process.stdout.write(`    → ${r.shell_wrapper.hint}\n`);
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

async function probeMemoro() {
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
async function plannedGeminiStatus() {
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

function probeShellWrapper() {
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

function probeWorkspace() {
  const home = mcHome();
  const exists = mcHomeExists();
  let sessionCount = 0;
  try { sessionCount = readRegistry().entries.length; } catch { /* empty */ }
  // Orphan/stale counts are surfaced once the §9j helper lands (PR #32).
  // Until then auth status omits the workspace warning row.
  return {
    mc_home: home,
    mc_home_exists: exists,
    session_count: sessionCount,
    orphan_daemon_count: 0,
    stale_pidfile_count: 0,
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
