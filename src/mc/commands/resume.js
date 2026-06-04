/**
 * `mc resume <name> [--tool …|--codex|--claude] [--no-launch] [--json]
 *                  [--emit-shell-directives]`
 *
 * §2 + §2b: emit `cd <worktree>` on fd 3 *before* the tool launches, so
 * the launched tool's cwd is the worktree. In `--no-launch` mode (tests
 * + when the user just wants to cd), we emit the directive and exit.
 *
 * Grounding (Phase 2 — entry parity): resume re-execs into wrap mode the
 * same way `mc new` does, so it grounds through the SAME `groundSession`
 * seam in `runWrap` — no forked grounding logic here. The session's label
 * (if any) is threaded across the re-exec as the soft `focus` pointer via
 * `MC_GROUNDING_FOCUS`, matching `mc new`'s `<task>` plumbing.
 */
import { findEntry, readRegistry, upsertEntry } from '../registry.js';
import { emitCd, parseDirectiveFlag } from '../shell-directives.js';
import { launchWithPreflight } from './launch-preflight.js';
import { resolveToolInput } from '../../adapters/index.js';

export const TOOL_SUGAR = {
  '--claude': 'claude',
  '--codex': 'codex',
  '--gemini': 'gemini',
};

export async function run(rawArgv) {
  const { args: argv, enabled: emitDirectives } = parseDirectiveFlag(rawArgv);
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }
  if (!opts.name) {
    printResumeList({ opts });
    return 0;
  }
  let entry = findEntry(opts.name);
  if (!entry) {
    console.error(`mc: no such session "${opts.name}"`);
    return 1;
  }

  if (opts.tool) {
    const resolved = resolveToolInput(opts.tool);
    if (!resolved) {
      console.error(`mc: unknown tool: ${opts.tool}. Try: claude | codex | gemini`);
      return 2;
    }
    entry = upsertEntry({ name: entry.name, tool: resolved.shortName });
  }

  if (entry.worktree_path) {
    emitCd(entry.worktree_path, { enabled: emitDirectives || undefined });
  }

  if (opts.json) {
    console.log(JSON.stringify({
      name: entry.name,
      tool: entry.tool || 'claude',
      worktree_path: entry.worktree_path || null,
    }, null, 2));
    return 0;
  }

  if (opts.noLaunch || process.env.MC_TEST_MODE === '1') {
    return 0;
  }

  // Re-exec mc in wrap mode with --resume so claude opens its resume
  // picker. Same approach as `mc new`: same binary, cwd=worktree,
  // inherited stdio. Adapter routing for non-claude tools follows §5.
  //
  // Thread the session label as the soft grounding focus across the
  // re-exec (argv is dropped by the wrap path), so the resumed session
  // grounds with the same standing-context pointer through the ONE
  // groundSession seam in runWrap.
  return launchResumeSession({ entry });
}

export async function launchResumeSession({
  entry,
  env,
  execPath,
  mcBin,
  stderr,
  deps = {},
} = {}) {
  return launchWithPreflight({
    sessionName: entry.name,
    worktreePath: entry.worktree_path,
    tool: entry.tool,
    focus: entry.label,
    resume: true,
    env,
    execPath,
    mcBin,
    stderr,
    deps,
  });
}

export function parseArgs(argv) {
  const opts = { name: null, tool: null, noLaunch: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-launch') { opts.noLaunch = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--tool') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { error: '--tool requires a value' };
      opts.tool = next;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(TOOL_SUGAR, a)) {
      if (opts.tool && opts.tool !== TOOL_SUGAR[a]) {
        return { error: `conflicting tool flags: --tool ${opts.tool} and ${a}` };
      }
      opts.tool = TOOL_SUGAR[a];
      continue;
    }
    if (a.startsWith('--')) return { error: `unknown flag: ${a}` };
    if (opts.name) return { error: `unexpected arg: ${a}` };
    opts.name = a;
  }
  return opts;
}

export function resumableEntries(reg = readRegistry()) {
  const entries = Array.isArray(reg?.entries) ? reg.entries : [];
  return entries
    .filter((e) => e && typeof e.name === 'string' && e.name)
    .map((e) => ({
      name: e.name,
      branch: e.branch || '',
      tool: e.tool || 'claude',
      session_state: e.session_state || 'no-session-yet',
      worktree_path: e.worktree_path || null,
      kind: e.kind || 'work',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function printResumeList({ opts }) {
  const entries = resumableEntries();

  if (opts.json) {
    console.log(JSON.stringify({
      entries,
      hint: 'Run `mc resume <name>` to re-enter a session, or `mc resume <name> --codex/--claude` to relaunch it under another tool.',
    }, null, 2));
    return;
  }

  if (entries.length === 0) {
    process.stdout.write('(no mc sessions)\n');
    process.stdout.write('Create one with `mc new <name> [focus] --codex`.\n');
    return;
  }

  process.stdout.write('mc sessions available to resume:\n');
  for (const e of entries) {
    const parts = [
      `  ${e.name.padEnd(20)}`,
      e.tool.padEnd(8),
      (e.branch || '').padEnd(24),
      e.session_state,
    ];
    process.stdout.write(parts.join('  ') + '\n');
  }
  const toolHint = opts.tool
    ? `mc resume <name> --${opts.tool === 'claude' ? 'claude' : opts.tool}`
    : 'mc resume <name>';
  process.stdout.write(`\nRun \`${toolHint}\` to re-enter one of these sessions.\n`);
}
