/**
 * `mc hook` — the answers mc gives a coding agent's hooks.
 *
 *   mc hook session-start   the worktrees' state, the warnings, the mc toolbox
 *   mc hook pre-tool        run the PreToolUse hooks of every worktree the session
 *                           did not start in, then turn a shell command that has
 *                           an mc verb to the verb
 *   mc hook install [--check]
 *                           write mc's two entries into ~/.claude/settings.json,
 *                           changing no other entry; --check only says whether
 *                           they are there (exit 1 when not)
 *
 * The first two read the hook's JSON on stdin and write at most one JSON object
 * on stdout, in the shape Claude Code's hooks read (`hookSpecificOutput`). Both
 * exit 0 whatever happens: a hook that fails must never stop the session, so a
 * parse error, a missing git or a directory outside mc's ground is silence.
 * `install` is run by a person, so it says what it did and exits 1 when it
 * could not write or check. The logic is `../hooks.js`; this file is the door.
 */
import { readFileSync } from 'node:fs';

import { writeJsonAtomic } from '../atomic-write.js';
import { listServers } from '../dev-servers.js';
import {
  MC_HOOKS, claudeSettingsPath, hookDrift, hookRegistration, inMcTerritory, installHooks, pathInKnownRepo, preToolDecision,
  repoHookDecision, sessionStartContext, worktreeState, worktreesAt,
} from '../hooks.js';
import { programsHome } from '../paths.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const [which, ...extra] = argv;
  if (which === 'install') return install(extra, { stdout, stderr, deps });
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
    // The repository's denial comes first: a safety block outranks a turn to an mc verb.
    const borrowed = (deps.repoHookDecision || repoHookDecision)(input, { cwd, projectDir: (deps.env || process.env).CLAUDE_PROJECT_DIR || null });
    const decision = borrowed || preToolDecision(input, {
      inRepo: (path) => (deps.pathInKnownRepo || pathInKnownRepo)(path, deps),
      programs: programsHome(deps.env || process.env),
    });
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

/*
 * The file is read here, not through `readClaudeSettings`: install must tell a
 * missing file (start from `{}`) from one it cannot parse (refuse), and the
 * refusal names neither the error nor the file's text, which can hold secrets.
 */
function install(extra, { stdout, stderr, deps }) {
  if (!(extra.length === 0 || (extra.length === 1 && extra[0] === '--check'))) {
    stderr.write(`mc: mc hook install takes only --check\n${usage()}`);
    return 2;
  }
  const path = (deps.claudeSettingsPath || claudeSettingsPath)(deps.home);
  const { code, line, failed } = installSettings(path, { check: extra.length === 1, readFile: deps.readFile, writeJson: deps.writeJson });
  (failed ? stderr : stdout).write(`mc: ${line}\n`);
  return code;
}

/**
 * `mc hook install` on one settings file, as a function (`mc layout migrate
 * --apply` runs it too): `{ code, line, failed }`, `failed` when the file
 * could not be read as JSON and nothing was written.
 */
export function installSettings(path, { check = false, readFile = (file) => readFileSync(file, 'utf8'), writeJson = writeJsonAtomic } = {}) {
  const unreadable = { code: 1, line: `${path} could not be read as JSON — nothing written`, failed: true };
  let settings;
  try {
    settings = JSON.parse(readFile(path));
  } catch (error) {
    if (error?.code !== 'ENOENT') return unreadable;
    settings = {};
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return unreadable;
  const before = hookRegistration(settings);
  if (check) {
    if (before.ok) return { code: 0, line: `hooks registered in ${path}`, failed: false };
    return { code: 1, line: `${hookDrift(before)} — mc hook install writes them`, failed: false };
  }
  if (before.ok) return { code: 0, line: `hooks already registered in ${path}`, failed: false };
  writeJson(path, installHooks(settings));
  return { code: 0, line: `hooks registered in ${path} (${hookDrift(before)} before)`, failed: false };
}

export function usage() {
  return [
    'usage — mc hook session-start   for a SessionStart hook: the worktrees\' branch, how far behind\n',
    '                                origin/main, changed files, dev server, the warnings, the mc toolbox\n',
    '        mc hook pre-tool        for a PreToolUse hook (Bash|Write|Read|Edit|MultiEdit): first the PreToolUse hooks of\n',
    '                                every worktree the session did not start in (their deny wins), then\n',
    '                                gh pr create, gh pr edit / git push →\n',
    '                                mc publish, gh pr merge → mc merge, npm run ci → mc gate,\n',
    '                                npm run dev* → mc test dev --here --url, a scratch Playwright\n',
    '                                script → mc shot. MC_HOOK_ALLOW=1 in the command lets it through.\n',
    '        mc hook install [--check]  writes those two entries, or says whether they are there (exit 1 when not)\n',
    '\n',
    'Both read the hook JSON on stdin, print at most one JSON object, and always exit 0.\n',
    'In ~/.claude/settings.json:\n',
    ...MC_HOOKS.map((want) => `  "${want.event}": [{ ${want.matcher ? `"matcher": "${want.matcher}", ` : ''}"hooks": [{ "type": "command", "command": "${want.command}" }] }]\n`),
    'Read lets memoro\'s block-sqlite-state.sh answer the Read tool too.\n',
  ].join('');
}
