/**
 * `mc spawn <name> "<brief>" [--scope <label>] [--tool ...] [--from <ref>]`
 *
 * Creates a durable project session under the current coordinator session.
 * This is not an agent runner: it creates the same worktree/branch/registry
 * substrate as `mc new`, writes the brief to `.mc/brief.md`, and leaves the
 * session idle for `mc open <name>` or `mc sessions send <name> ...`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findEntry, upsertEntry } from '../registry.js';
import { worktreePath } from '../paths.js';
import { git, isInsideRepo, primaryWorktree, branchExists } from '../git.js';
import { checkAndPrintFreshInstall, ensureSentinel } from '../first-run.js';
import { resolveToolForNew, TOOL_SUGAR } from './new.js';
import { launchWithPreflight } from './launch-preflight.js';

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printUsage();
    return 0;
  }
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    printUsage();
    return 2;
  }
  if (!opts.name || !opts.brief) {
    console.error('mc: usage — `mc spawn <name> "<brief>" [--scope <label>]`');
    return 2;
  }
  if (!NAME_RE.test(opts.name)) {
    console.error(`mc: invalid name "${opts.name}" — must match ${NAME_RE}`);
    return 2;
  }

  if (await checkAndPrintFreshInstall()) return 1;

  const cwd = process.cwd();
  if (!isInsideRepo(cwd)) {
    console.error('mc: not inside a git repository. `mc spawn` requires a repo.');
    return 1;
  }
  const primary = primaryWorktree(cwd);
  if (!primary) {
    console.error('mc: could not resolve primary worktree path');
    return 1;
  }

  if (findEntry(opts.name)) {
    console.error(`mc: a session named "${opts.name}" already exists`);
    return 1;
  }

  const branch = `sess/${opts.name}`;
  if (branchExists(primary, branch)) {
    console.error(`mc: branch "${branch}" already exists`);
    return 1;
  }

  const toolResolution = await resolveToolForNew({ flagValue: opts.tool });
  if (toolResolution.error) {
    console.error(`mc: ${toolResolution.error}`);
    return 2;
  }

  const fromRef = opts.from || 'HEAD';
  const wt = worktreePath(primary, opts.name);
  try {
    git(primary, ['branch', branch, fromRef]);
  } catch (err) {
    console.error(`mc: failed to create branch ${branch}: ${err.message}`);
    return 1;
  }
  try {
    mkdirSync(dirname(wt), { recursive: true });
    git(primary, ['worktree', 'add', wt, branch]);
  } catch (err) {
    try { git(primary, ['branch', '-D', branch]); } catch {}
    console.error(`mc: failed to add worktree: ${err.message}`);
    return 1;
  }

  const parent = opts.parent ?? process.env.MC_SESSION_NAME ?? null;
  const focus = opts.focus ?? opts.scope ?? opts.name;
  const brief = buildSpawnBrief({
    name: opts.name,
    parent,
    focus,
    scope: opts.scope,
    brief: opts.brief,
  });
  const briefPath = writeBrief(wt, brief);

  const entry = upsertEntry({
    name: opts.name,
    branch,
    worktree_path: wt,
    repo_slug: wt.split('/worktrees/')[1]?.split('/')[0] || null,
    primary_worktree: primary,
    kind: 'project',
    role: 'project',
    parent,
    focus,
    scope: opts.scope ?? null,
    brief_path: briefPath,
    tool: toolResolution.tool,
    model_chain: [],
    session_state: 'no-session-yet',
    safety_verdict: 'SAFE_TO_END',
  });

  ensureSentinel();

  const payload = {
    ok: true,
    name: opts.name,
    parent,
    kind: entry.kind,
    role: entry.role,
    branch,
    worktree_path: wt,
    tool: entry.tool,
    focus,
    scope: entry.scope ?? null,
    brief_path: briefPath,
    launched: opts.launch,
  };

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    process.stdout.write(`mc: spawned project session ${opts.name} at ${wt}\n`);
    if (parent) process.stdout.write(`parent: ${parent}\n`);
    if (opts.scope) process.stdout.write(`scope: ${opts.scope}\n`);
    process.stdout.write(`brief: ${briefPath}\n`);
    process.stdout.write(`next:  mc open ${opts.name}\n`);
  }

  if (!opts.launch || process.env.MC_TEST_MODE === '1') return 0;
  return launchWithPreflight({
    sessionName: entry.name,
    worktreePath: wt,
    tool: entry.tool,
    focus,
  });
}

export function buildSpawnBrief({ name, parent, focus, scope, brief }) {
  const lines = [
    `# Project session brief — ${name}`,
    '',
  ];
  if (parent) lines.push(`Parent coordinator: ${parent}`);
  lines.push(`Focus: ${focus || name}`);
  if (scope && scope !== focus) lines.push(`Scope: ${scope}`);
  lines.push(
    '',
    'You are a durable mc project session. Stay inside this worktree/branch, use the brief as your task boundary, and report status back to the coordinator.',
    '',
    '## Brief',
    '',
    String(brief).trim(),
    '',
  );
  return lines.join('\n');
}

function writeBrief(worktreeDir, brief) {
  const dir = join(worktreeDir, '.mc');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'brief.md');
  writeFileSync(path, brief, { mode: 0o600 });
  return path;
}

function parseArgs(argv) {
  const opts = {
    name: null,
    brief: null,
    scope: null,
    focus: null,
    parent: undefined,
    from: null,
    tool: null,
    json: false,
    launch: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') { opts.scope = argv[++i]; continue; }
    if (a === '--focus') { opts.focus = argv[++i]; continue; }
    if (a === '--parent') { opts.parent = argv[++i] || null; continue; }
    if (a === '--from') { opts.from = argv[++i]; continue; }
    if (a === '--tool') { opts.tool = argv[++i]; continue; }
    if (Object.prototype.hasOwnProperty.call(TOOL_SUGAR, a)) {
      if (opts.tool && opts.tool !== TOOL_SUGAR[a]) {
        return { error: `conflicting tool flags: --tool ${opts.tool} and ${a}` };
      }
      opts.tool = TOOL_SUGAR[a];
      continue;
    }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--launch') { opts.launch = true; continue; }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a.startsWith('--')) return { error: `unknown flag: ${a}` };
    positionals.push(a);
  }
  opts.name = positionals.shift() || null;
  opts.brief = positionals.join(' ').trim() || null;
  return opts;
}

function printUsage() {
  console.error('Usage: mc spawn <name> "<brief>" [--scope <label>] [--tool <tool>] [--from <ref>] [--json]');
  console.error('  Creates an idle, durable project session tracked under the current coordinator.');
}
