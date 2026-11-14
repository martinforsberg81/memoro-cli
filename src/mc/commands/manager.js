/** The interactive session for priorities and decisions across all programmes. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { managerDir, workRoot } from '../paths.js';
import { readCanonRole, roleSourceOf } from '../roles.js';
import { openInWorkArea } from '../work-open.js';
import { scanArgs } from './flags.js';
import { commandUsage } from '../command-help.js';

export function usage() {
  return commandUsage('manager');
}

/** Each subcommand and the scan it is read with; '' is the bare verb, '*' a first word that names something. help-routes.test.js walks the help with it. */
/** `check`: what the scanned arguments may not be — null, or what is wrong; the verb runs it, and help-routes.test.js walks the help with it. */
export const ROUTES = { '': { booleans: ['--local', '--new', '--headless', '--resume'], strictValues: ['--model', '--prompt', '--minutes'], toolSugar: true, check: managerArguments } };

function managerArguments({ flags, positional }) {
  if (positional.length > (flags.resume ? 1 : 0)) return `unknown argument ${positional[flags.resume ? 1 : 0]}`;
  if (flags.resume && flags.new) return '--resume and --new cannot be combined';
  if (flags.resume && positional[0] === 'new') return '--resume expects a conversation ID or prefix';
  if (flags.resume && flags.headless) return '--resume requires an interactive session';
  if (flags.headless && !flags.prompt?.trim()) return '--headless requires --prompt';
  if (!flags.headless && (flags.prompt !== null || flags.minutes !== null)) return '--prompt and --minutes require --headless';
  if (flags.minutes !== null && (!Number.isFinite(Number(flags.minutes)) || Number(flags.minutes) <= 0 || Number(flags.minutes) > 1440)) return '--minutes must be greater than 0 and at most 1440';
  return null;
}

export async function run(argv, deps = {}) {
  const stderr = deps.stderr || process.stderr;
  const scanned = scanArgs(argv, ROUTES['']);
  const refused = scanned.error || ROUTES[''].check(scanned);
  if (refused) {
    stderr.write(`mc: ${refused}\n`);
    stderr.write(usage());
    return 2;
  }
  const { flags, positional } = scanned;

  if (flags.headless) {
    const { runManagerTurn } = await import('../manager-turn.js');
    const result = await (deps.turn || runManagerTurn)({ prompt: flags.prompt, tool: flags.tool, model: flags.model, minutes: flags.minutes === null ? 30 : Number(flags.minutes) });
    (deps.stdout || process.stdout).write(`${result.answer ? `${result.answer}\n` : ''}manager: ${result.note || result.reason}\n${result.log ? `log: ${result.log}\n` : ''}`);
    return result.ok ? 0 : (Number.isInteger(result.status) && result.status > 0 ? result.status : 1);
  }

  const role = readCanonRole('manager');
  if (!role?.overlay) {
    stderr.write('mc: the manager role is missing from this install — expected canon/roles/manager.md with an overlay body\n');
    return 1;
  }
  const launch = managerLaunch({ role });
  const root = managerDir();
  (deps.mkdir || mkdirSync)(root, { recursive: true });
  const opened_ = await (deps.open || openInWorkArea)({
    areaRoot: root,
    conversationRoots: [root, join(workRoot(), 'brief')],
    worktree: { repo: null, path: root, is_git: false },
    tool: flags.tool || role.tools?.[0] || 'claude',
    pick: flags.new ? 'new' : flags.resume ? positional[0] || true : null,
    resumeTool: flags.tool,
    stdout: deps.stdout || process.stdout,
    stderr,
    // NOW says "mc manager" while this is up. Its room is nobody's workarea,
    // so there is no area name to give it.
    verb: 'manager',
    // What it was told it is, kept in the register the session outlives — so
    // `mc roles check manager` can say whether the text it is running on is the
    // one in `canon/roles/manager.md` today.
    roleName: role.name || 'manager',
    roleSource: roleSourceOf(role),
    cache: role.cache,
    model: flags.model,
    overlay: launch.overlay,
    prompt: launch.prompt,
    defaultModel: role.model,
    defaultModelTool: role.tools?.[0] || null,
  });
  if (!opened_.ok) {
    stderr.write(`mc: ${opened_.reason}${opened_.hint ? ` — ${opened_.hint}` : ''}\n`);
    return 1;
  }
  return opened_.code ?? 0;
}

/**
 * What the session is told: the role as written, and no opening words. Martin
 * says what he wants help with; `Start the meeting.` sent it walking the whole
 * page on its own (Martin, 2026-09-28).
 */
export function managerLaunch({ role }) {
  return { overlay: role.overlay, prompt: null, model: role.model || null };
}
