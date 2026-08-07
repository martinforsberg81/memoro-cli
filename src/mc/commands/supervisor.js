/**
 * `mc supervisor` — open the session that watches the others.
 *
 * There is one, it is called supervisor, and it has no worktree. Beyond that
 * it is an ordinary piece of work: it appears on the status board, it can be
 * stopped, and it resumes where it left off.
 */
import { spawnSync } from 'node:child_process';

import { resolveLaunch } from '../../adapters/index.js';
import { listConversations } from '../conversations.js';
import { log } from '../logger.js';
import { workAreaPath } from '../paths.js';
import { SUPERVISOR_AREA, supervisorLaunchArgs } from '../supervisor.js';
import { attachBackground, backgroundTarget } from '../work-open.js';
import { createWorkArea, inspectWorkArea } from '../work-area.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc supervisor [--codex|--claude] [--tmux]\n');
    return 2;
  }

  const path = workAreaPath(SUPERVISOR_AREA);
  const area = inspectWorkArea(SUPERVISOR_AREA);
  if (!area.exists) {
    createWorkArea(SUPERVISOR_AREA);
    stderr.write(`mc: ${path} — no worktree, and never one\n`);
  }

  // Already running? Then this is where it is, not a second one. There is one
  // supervisor; two would each hold half the overview and neither would know.
  const running = backgroundTarget(SUPERVISOR_AREA);
  if (running) {
    stderr.write('mc: joining the supervisor — it is already running\n');
    stderr.write('mc: ctrl-b d leaves it running\n');
    const joined = attachBackground(running);
    return joined.ok ? (joined.code || 0) : 1;
  }

  const existing = listConversations(path).find((item) => (
    !opts.tool || item.tool === (opts.tool === 'claude' ? 'claude-code' : opts.tool)
  ));
  const launch = resolveLaunch(opts.tool || existing?.tool || 'claude');
  if (!launch?.ok) {
    stderr.write(`mc: ${launch?.hint || launch?.reason || 'that tool is not available'}\n`);
    return 1;
  }

  // Resuming carries the role in its own history already; only a new one needs
  // to be told what it is.
  const args = existing && typeof launch.adapter?.resumeArgs === 'function'
    ? launch.adapter.resumeArgs({ sessionId: existing.id }) || []
    : await supervisorLaunchArgs(launch.id);

  log('supervisor.open', { tool: launch.id, resuming: existing?.id || null });
  stderr.write(existing
    ? `mc: supervisor — resuming ${existing.id.slice(0, 8)}\n`
    : 'mc: supervisor — a new conversation, told what it is\n');

  const spawn = deps.spawn || spawnSync;
  const result = spawn(launch.spec.bin, args, { cwd: path, stdio: 'inherit', env: process.env });
  if (result?.error) {
    stderr.write(`mc: could not open the supervisor (${result.error.message})\n`);
    return 1;
  }
  return result?.status ?? 0;
}

export function parseArgs(argv) {
  const opts = { tool: null, tmux: false };
  for (const arg of argv) {
    if (arg === '--claude') { opts.tool = 'claude'; continue; }
    if (arg === '--codex') { opts.tool = 'codex'; continue; }
    if (arg === '--tmux') { opts.tmux = true; continue; }
    return { ...opts, error: `unknown argument: ${arg}` };
  }
  return opts;
}
