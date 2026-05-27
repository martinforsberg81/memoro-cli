/**
 * `mc new <name> [--from <ref>] [--tool …] [--no-launch] [--json]
 *               [--emit-shell-directives]`
 *
 * §2: create worktree at ${MC_HOME}/worktrees/<repo-slug>/<name> with
 * branch `sess/<name>`, register it, launch the chosen tool (unless
 * --no-launch). §2b: emit `cd <worktree>` on fd 3 when the wrapper is
 * attached.
 *
 * The label-tagging Claude wrap that used to live under `mc new <label>`
 * moved to `mc wrap` — see commands/wrap.js.
 */
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { findEntry, upsertEntry } from '../registry.js';
import { worktreePath, mcHome } from '../paths.js';
import { git, isInsideRepo, primaryWorktree, branchExists } from '../git.js';
import { emitCd, parseDirectiveFlag } from '../shell-directives.js';

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export async function run(rawArgv) {
  const { args: argv, enabled: emitDirectives } = parseDirectiveFlag(rawArgv);

  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    printUsage();
    return 2;
  }
  if (!opts.name) {
    console.error('mc: usage — `mc new <name> [--from <ref>] [--tool <tool>]`');
    return 2;
  }

  if (!NAME_RE.test(opts.name)) {
    console.error(`mc: invalid name "${opts.name}" — must match ${NAME_RE}`);
    return 2;
  }

  const cwd = process.cwd();
  if (!isInsideRepo(cwd)) {
    console.error('mc: not inside a git repository. `mc new` requires a repo.');
    return 1;
  }

  const primary = primaryWorktree(cwd);
  if (!primary) {
    console.error('mc: could not resolve primary worktree path');
    return 1;
  }

  if (findEntry(opts.name)) {
    console.error(`mc: a worktree named "${opts.name}" already exists`);
    return 1;
  }

  const branch = `sess/${opts.name}`;
  if (branchExists(primary, branch)) {
    console.error(`mc: branch "${branch}" already exists`);
    return 1;
  }

  // Create the branch off --from (or HEAD).
  const fromRef = opts.from || 'HEAD';
  try {
    git(primary, ['branch', branch, fromRef]);
  } catch (err) {
    console.error(`mc: failed to create branch ${branch}: ${err.message}`);
    return 1;
  }

  const wt = worktreePath(primary, opts.name);
  mkdirSync(dirname(wt), { recursive: true });
  try {
    git(primary, ['worktree', 'add', wt, branch]);
  } catch (err) {
    // Best-effort branch rollback so we don't leave dead refs.
    try { git(primary, ['branch', '-D', branch]); } catch {}
    console.error(`mc: failed to add worktree: ${err.message}`);
    return 1;
  }

  const entry = upsertEntry({
    name: opts.name,
    branch,
    worktree_path: wt,
    repo_slug: wt.split('/worktrees/')[1]?.split('/')[0] || null,
    primary_worktree: primary,
    kind: 'work',
    tool: opts.tool || 'claude',
    model_chain: [],
    session_state: 'no-session-yet',
    safety_verdict: 'SAFE_TO_END',
  });

  emitCd(wt, { enabled: emitDirectives || undefined });

  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      name: opts.name,
      branch,
      worktree_path: wt,
      tool: entry.tool,
      from: opts.from || null,
    }, null, 2));
    return 0;
  }

  if (opts.noLaunch || process.env.MC_TEST_MODE === '1') {
    console.log(`mc: created worktree ${opts.name} at ${wt}`);
    return 0;
  }

  // Real launch is wired in when the tool-launch glue lands — for now
  // the test path covers `--no-launch`. Production fallback: print the
  // worktree path and let the user `mc resume <name>` to launch.
  console.log(`mc: created worktree ${opts.name} at ${wt}`);
  console.log(`mc: run \`mc resume ${opts.name}\` to launch ${entry.tool}.`);
  return 0;
}

function parseArgs(argv) {
  const opts = { name: null, from: null, tool: null, noLaunch: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') { opts.from = argv[++i]; continue; }
    if (a === '--tool') { opts.tool = argv[++i]; continue; }
    if (a === '--no-launch') { opts.noLaunch = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a.startsWith('--')) { return { error: `unknown flag: ${a}` }; }
    if (opts.name) { return { error: `unexpected positional arg: ${a}` }; }
    opts.name = a;
  }
  return opts;
}

function printUsage() {
  console.error('Usage: mc new <name> [--from <ref>] [--tool claude|codex|gemini] [--no-launch] [--json]');
}
