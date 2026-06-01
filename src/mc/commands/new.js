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
import { spawnSync } from 'node:child_process';
import { findEntry, upsertEntry } from '../registry.js';
import { worktreePath, mcHome } from '../paths.js';
import { git, isInsideRepo, primaryWorktree, branchExists } from '../git.js';
import { emitCd, parseDirectiveFlag } from '../shell-directives.js';
import { checkAndPrintFreshInstall, ensureSentinel } from '../first-run.js';

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

  // §11d: friendly first-run hint when both sentinel AND keychain
  // token miss. Runs after arg validation so `mc new --json` and
  // `--help` semantics aren't changed for fresh installs in a
  // way that would surprise scripts.
  if (await checkAndPrintFreshInstall()) {
    return 1;
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

  // §11d: on a successful `mc new`, ensure the sentinel exists. For
  // migrants (token in keychain from `memoro-cli login` before mc
  // setup existed) this is the silent upgrade path — next call to
  // any first-run-aware command skips the hint without ever having
  // shown one.
  ensureSentinel();

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

  console.log(`mc: created worktree ${opts.name} at ${wt}`);

  if (opts.noLaunch || process.env.MC_TEST_MODE === '1') {
    return 0;
  }

  // §12d: materialise vault tokens for the session BEFORE re-exec.
  // The materialised files must exist by the time the spawned tool
  // reads its credentials path. Soft-degrade: if the vault is locked
  // or unreachable, print a one-line hint to stderr and continue —
  // the session just starts without materialised tokens.
  try {
    const { materialiseForSession } = await import('../vault/lifecycle.js');
    const res = await materialiseForSession({ sessionId: opts.name, worktreePath: wt });
    if (!res.ok && res.hint) {
      process.stderr.write(`mc: ${res.hint}\n`);
    }
  } catch (err) {
    // Materialisation must never block the session — surface but continue.
    process.stderr.write(`mc: vault materialise failed (${err.message}); continuing without tokens\n`);
  }

  // Re-exec the same mc binary in wrap mode with cwd=worktree. This
  // re-uses the existing wrap-mode plumbing (pty.spawn of claude,
  // heartbeat-loop, ws-client, registry tick) without duplicating it
  // here. stdio inherits so the user's terminal becomes claude's TUI;
  // when claude exits, we exit too and the shell wrapper's auto-cd
  // (already emitted above) keeps the user in the worktree.
  //
  // Adapter routing per --tool (codex, gemini, …) is deferred — for
  // claude this is just the plain wrap path. When the adapter layer
  // lands (§5), this re-exec becomes a per-tool launcher call.
  const result = spawnSync(process.execPath, [process.argv[1]], {
    stdio: 'inherit',
    cwd: wt,
  });
  return result.status ?? 0;
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
