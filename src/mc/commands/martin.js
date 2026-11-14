/** Martin's interactive decision desk and its read-only queue command. */
import { mkdirSync } from 'node:fs';
import { commandUsage } from '../command-help.js';
import { martinDir, programsHome } from '../paths.js';
import { readCanonRole, roleSourceOf } from '../roles.js';
import { openInWorkArea } from '../work-open.js';
import { interactive } from '../prompt.js';
import { scanArgs } from './flags.js';
import { collectMartinQueue, renderMartinQueue } from '../martin-collect.js';

export function usage() { return commandUsage('martin'); }

export const ROUTES = {
  '': { booleans: ['--local', '--new', '--resume'], strictValues: ['--model'], toolSugar: true, check: ({ flags, positional }) => {
    if (positional.length > (flags.resume ? 1 : 0)) return `unknown argument ${positional[flags.resume ? 1 : 0]}`;
    if (flags.resume && flags.new) return '--resume and --new cannot be combined';
    if (flags.resume && positional[0] === 'new') return '--resume expects a conversation ID or prefix';
    return null;
  } },
  get: { booleans: ['--all', '--json'], strictValues: ['--programme', '--goal'], check: ({ flags, positional }) => {
    if (positional.length) return `unknown argument ${positional[0]}`;
    const selectors = Number(flags.all) + Number(flags.programme !== null) + Number(flags.goal !== null);
    return selectors > 1 ? 'choose exactly one of --all, --programme or --goal' : null;
  } },
};

export async function run(argv, deps = {}) {
  if (argv[0] === 'get') return get(argv.slice(1), deps);
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const scanned = scanArgs(argv, ROUTES['']);
  const error = scanned.error || ROUTES[''].check(scanned);
  if (error) { stderr.write(`mc: ${error}\n${usage()}`); return 2; }
  const { flags, positional } = scanned;
  const env = deps.env || process.env;
  if (env.MC_HEADLESS === '1' || !(deps.interactive || interactive)(env)) {
    stderr.write('mc: martin is an interactive-only desk; unattended launch refused\n');
    return 2;
  }
  const role = (deps.role || (() => readCanonRole('martin')))();
  if (!role?.overlay) { stderr.write('mc: the martin role is missing from this install — expected canon/roles/martin.md with an overlay body\n'); return 1; }
  const root = (deps.desk || martinDir)(env);
  (deps.mkdir || mkdirSync)(root, { recursive: true });
  const queue = (deps.collect || collectMartinQueue)({ home: deps.home || programsHome(env) });
  const context = renderMartinQueue(queue);
  const launch = { overlay: role.overlay, prompt: `Current decision queue (read from live records):\n\n${context}`, model: role.model || null };
  const opened = await (deps.open || openInWorkArea)({
    env, areaRoot: root, conversationRoots: [root],
    worktree: { repo: null, path: root, is_git: false }, tool: flags.tool || role.tools?.[0] || 'claude',
    pick: flags.new ? 'new' : flags.resume ? positional[0] || true : null,
    resumeTool: flags.tool, stdout, stderr, verb: 'martin', areaName: 'martin',
    roleName: role.name || 'martin', roleSource: roleSourceOf(role), cache: role.cache,
    model: flags.model, overlay: launch.overlay, prompt: launch.prompt, resumePrompt: `Refresh from the live decision queue now; remembered goals are not current evidence.\n\n${context}`,
    defaultModel: role.model, defaultModelTool: role.tools?.[0] || null,
  });
  if (!opened.ok) { stderr.write(`mc: ${opened.reason}${opened.hint ? ` — ${opened.hint}` : ''}\n`); return 1; }
  return opened.code ?? 0;
}

export function get(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const selectorFlags = argv.filter((arg) => ['--all', '--programme', '--goal'].includes(arg));
  if (selectorFlags.length > 1) { stderr.write('mc: choose exactly one of --all, --programme or --goal\n'); return 2; }
  const scanned = scanArgs(argv, ROUTES.get);
  const error = scanned.error || ROUTES.get.check(scanned);
  if (error) { stderr.write(`mc: ${error}\n${usage()}`); return 2; }
  const { flags } = scanned;
  const selector = flags.programme !== null ? { kind: 'programme', value: flags.programme }
    : flags.goal !== null ? { kind: 'goal', value: flags.goal }
      : { kind: 'all' };
  const result = (deps.collect || collectMartinQueue)({ selector, home: deps.home || programsHome(deps.env || process.env) });
  if (result.error) { stderr.write(`mc: ${result.error}\n`); return 2; }
  stdout.write(renderMartinQueue(result, { json: flags.json }));
  return 0;
}
