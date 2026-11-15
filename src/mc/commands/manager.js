/**
 * `mc manager --headless --prompt …` — one manual manager task, run once with nobody present. The interactive manager is
 * gone (Martin, 2026-11-14): the pulse is the runner's two automatic turns (mc-manager.md), and Martin's own entrance is
 * `mc martin`. Every other form of the verb, and `mc brief`, is refused before anything starts.
 */
import { scanArgs } from './flags.js';
import { commandUsage } from '../command-help.js';

/** The one line every interactive form is refused with, here and in `runModule`, which refuses before server routing. */
export const MANAGER_GONE = 'mc: the interactive manager is gone — talk to the desk with `mc martin`, or give the manager one task with `mc manager --headless --prompt "<task>"`';

export function usage() {
  return commandUsage('manager');
}

/** Each subcommand and the scan it is read with; '' is the bare verb, '*' a first word that names something. help-routes.test.js walks the help with it. */
/** `check`: what the scanned arguments may not be — null, or what is wrong; the verb runs it, and help-routes.test.js walks the help with it. */
export const ROUTES = { '': { booleans: ['--local', '--new', '--headless', '--resume', '--bg'], strictValues: ['--model', '--prompt', '--minutes'], toolSugar: true, check: managerArguments } };

function managerArguments({ flags, positional }) {
  if (positional.length > (flags.resume ? 1 : 0)) return `unknown argument ${positional[flags.resume ? 1 : 0]}`;
  if (flags.resume && flags.new) return '--resume and --new cannot be combined';
  if (flags.resume && positional[0] === 'new') return '--resume expects a conversation ID or prefix';
  if (flags.resume && flags.headless) return '--resume requires an interactive session';
  if (flags.bg && flags.headless) return '--bg needs an interactive session';
  if (flags.headless && !flags.prompt?.trim()) return '--headless requires --prompt';
  if (flags.minutes !== null && (!Number.isFinite(Number(flags.minutes)) || Number(flags.minutes) <= 0 || Number(flags.minutes) > 1440)) return '--minutes must be greater than 0 and at most 1440';
  return null;
}

export async function run(argv, deps = {}) {
  const stderr = deps.stderr || process.stderr;
  if (!argv.includes('--headless')) { stderr.write(`${MANAGER_GONE}\n`); return 2; }
  const scanned = scanArgs(argv, ROUTES['']);
  const refused = scanned.error || ROUTES[''].check(scanned);
  if (refused) {
    stderr.write(`mc: ${refused}\n`);
    stderr.write(usage());
    return 2;
  }
  const { flags } = scanned;

  const { runManagerTurn } = await import('../manager-turn.js');
  const result = await (deps.turn || runManagerTurn)({ prompt: flags.prompt, tool: flags.tool, model: flags.model, minutes: flags.minutes === null ? 30 : Number(flags.minutes) });
  (deps.stdout || process.stdout).write(`${result.answer ? `${result.answer}\n` : ''}manager: ${result.note || result.reason}\n${result.log ? `log: ${result.log}\n` : ''}`);
  return result.ok ? 0 : (Number.isInteger(result.status) && result.status > 0 ? result.status : 1);
}
