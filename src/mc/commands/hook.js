/**
 * `mc hook` — the answers mc gives a coding agent's hooks.
 *
 *   mc hook session-start   the worktrees' state, the warnings, the mc toolbox
 *   mc hook pre-tool        turn a shell command that has an mc verb to the verb
 *
 * Both read the hook's JSON on stdin and write at most one JSON object on
 * stdout, in the shape Claude Code's hooks read (`hookSpecificOutput`). Both
 * exit 0 whatever happens: a hook that fails must never stop the session, so a
 * parse error, a missing git or a directory outside mc's ground is silence.
 * The logic is `../hooks.js`; this file is the door.
 */
import { listServers } from '../dev-servers.js';
import {
  inMcTerritory, pathInKnownRepo, preToolDecision, sessionStartContext, worktreeState, worktreesAt,
} from '../hooks.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const [which, ...extra] = argv;
  if (!['session-start', 'pre-tool'].includes(which) || extra.length) {
    stderr.write(`mc: mc hook takes session-start or pre-tool\n${usage()}`);
    return 2;
  }
  let input = {};
  try {
    const raw = await (deps.readStdin || readStdin)();
    input = raw && raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return 0;
  }
  const cwd = input.cwd || deps.cwd || process.cwd();
  try {
    if (which === 'session-start') {
      const found = (deps.worktreesAt || worktreesAt)(cwd, deps);
      if (!found.worktrees.length) return 0;
      let servers = [];
      try { servers = (deps.listServers || listServers)({ reap: false }).servers || []; } catch { servers = []; }
      const states = found.worktrees.map((entry) => (deps.worktreeState || worktreeState)(entry.worktree, { servers }));
      const context = sessionStartContext({ cwd, inside: found.inside, states });
      if (context) {
        stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })}\n`);
      }
      return 0;
    }
    if (!(deps.inMcTerritory || inMcTerritory)(cwd, deps)) return 0;
    const decision = preToolDecision(input, { inRepo: (path) => (deps.pathInKnownRepo || pathInKnownRepo)(path, deps) });
    if (decision) {
      stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `mc: ${decision.reason}`,
        },
      })}\n`);
    }
  } catch {
    // A hook that throws must not stand between a session and its work.
  }
  return 0;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function usage() {
  return [
    'usage — mc hook session-start   for a SessionStart hook: the worktrees\' branch, how far behind\n',
    '                                origin/main, changed files, dev server, the warnings, the mc toolbox\n',
    '        mc hook pre-tool        for a PreToolUse hook (Bash|Write): gh pr create / git push →\n',
    '                                mc publish, gh pr merge → mc merge, npm run ci → mc gate,\n',
    '                                npm run dev* → mc test dev --here --url, a scratch Playwright\n',
    '                                script → mc shot. MC_HOOK_ALLOW=1 in the command lets it through.\n',
    '\n',
    'Both read the hook JSON on stdin, print at most one JSON object, and always exit 0.\n',
    'In ~/.claude/settings.json:\n',
    '  "SessionStart": [{ "hooks": [{ "type": "command", "command": "mc hook session-start 2>/dev/null || true" }] }]\n',
    '  "PreToolUse": [{ "matcher": "Bash|Write", "hooks": [{ "type": "command", "command": "mc hook pre-tool 2>/dev/null || true" }] }]\n',
  ].join('');
}
