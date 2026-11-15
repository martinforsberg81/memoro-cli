/**
 * `mc hook` — the answers mc gives a coding agent's hooks.
 *
 *   mc hook session-start   the worktrees' state, the warnings, the mc toolbox;
 *                           first it syncs mc's skills (`../skills.js`)
 *   mc hook pre-tool        run the PreToolUse hooks of every worktree the session
 *                           did not start in, then turn a shell command that has
 *                           an mc verb to the verb
 *   mc hook stop            a goal's review session refused its end while the goal is
 *                           in review or no proposal is written (`reviewStopDecision`)
 *   mc hook install [--check]
 *                           write mc's entries into each hook file of a tool that
 *                           is installed (Claude's ~/.claude/settings.json always),
 *                           changing no other entry; --check only says whether
 *                           they are there (exit 1 when not); without --check
 *                           it syncs mc's skills too (`../skills.js`)
 *
 * The first three read the hook's JSON on stdin and write at most one JSON object
 * on stdout, in the shape Claude Code's hooks read (`hookSpecificOutput`); with
 * `--tool <name>` they read and answer in that tool's dialect (the tool's `HOOKS`
 * declaration names it), which differs in the shape only: the same decisions
 * answer. All three exit 0 whatever happens: a hook that fails must never stop
 * the session, so a parse error, a missing git or a directory outside mc's ground is silence.
 * `install` is run by a person, so it says what it did and exits 1 when it
 * could not write or check. The logic is `../hooks.js`; this file is the door.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from '../atomic-write.js';
import { listServers } from '../dev-servers.js';
import { declared, idsWith, toolShortName } from '../../adapters/index.js';
import {
  agyHookInput, hookDrift, hookTargets, inMcTerritory, pathInKnownRepo, preToolDecision,
  repoHookDecision, reviewStopDecision, sessionStartContext, targetInstall, targetRegistration, worktreeState, worktreesAt,
} from '../hooks.js';
import { programsHome } from '../paths.js';
import { syncSkills } from '../skills.js';
import { commandUsage } from '../command-help.js';

/** Each subcommand and the scan it is read with; '' is the bare verb, '*' a first word that names something. help-routes.test.js walks the help with it. */
export const ROUTES = { 'session-start': { strictValues: ['--tool'] }, 'pre-tool': { strictValues: ['--tool'] }, stop: { strictValues: ['--tool'] }, install: { booleans: ['--check'] } };

/** What each hook dialect reads and answers; the decisions are the same ones (`../hooks.js`). */
const DIALECTS = {
  claude: {
    input: (input) => input,
    context: (context) => ({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }),
    stop: (reason) => ({ decision: 'block', reason }),
    deny: (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  },
  'agy-hooks': {
    input: agyHookInput,
    context: (context) => ({ injectSteps: [{ systemMessage: { systemMessage: context } }] }),
    stop: (reason) => ({ decision: 'continue', reason }),
    deny: (reason) => ({ decision: 'deny', reason }),
  },
};

/** The dialect `--tool <name>` names, `claude` when absent; null when no tool of that name declares hooks. */
function dialectOf(name) {
  if (name === null) return DIALECTS.claude;
  const id = idsWith('HOOKS').find((tool) => toolShortName(tool) === name);
  return (id && DIALECTS[declared(id, 'HOOKS').dialect]) || null;
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const [which, ...extra] = argv;
  if (which === 'install') return install(extra, { stdout, stderr, deps });
  const named = extra.length === 2 && extra[0] === '--tool' ? extra[1] : null;
  const dialect = Object.hasOwn(ROUTES, which) && (extra.length === 0 || named !== null) ? dialectOf(named) : null;
  if (!dialect) {
    stderr.write(`mc: mc hook takes session-start, pre-tool or stop, each with an optional --tool <name> of a tool that has hooks\n${usage()}`);
    return 2;
  }
  let input = {};
  try {
    const raw = await (deps.readStdin || readStdin)();
    input = raw && raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return 0;
  }
  const env = deps.env || process.env;
  const seen = dialect.input(input);
  const cwd = seen.cwd || deps.cwd || process.cwd();
  const say = (value) => stdout.write(`${JSON.stringify(value)}\n`);
  try {
    if (which === 'session-start') {
      // Every session of a tool that has hooks runs this first, launched by mc or opened by
      // hand, so it is where mc's skills are kept current (skills.js). Its own
      // try: a sync that fails must not cost the session its context.
      let synced = [];
      try { synced = (deps.syncSkills || syncSkills)(env) || []; } catch { synced = []; }
      const found = (deps.worktreesAt || worktreesAt)(cwd, deps);
      let servers = [];
      try { servers = (deps.listServers || listServers)({ reap: false }).servers || []; } catch { servers = []; }
      const states = found.worktrees.map((entry) => (deps.worktreeState || worktreeState)(entry.worktree, { servers }));
      const context = sessionStartContext({ cwd, inside: found.inside, states, env, synced });
      if (context) say(dialect.context(context));
      return 0;
    }
    if (which === 'stop') {
      // A goal's review ends only once it has decided and written its proposal.
      const held = (deps.reviewStopDecision || reviewStopDecision)({ env, home: programsHome(env) });
      if (held) say(dialect.stop(`mc: this review cannot end yet — ${held.reason}`));
      return 0;
    }
    if (!(deps.inMcTerritory || inMcTerritory)(cwd, deps)) return 0;
    // The repository's denial comes first: a safety block outranks a turn to an mc verb.
    const borrowed = (deps.repoHookDecision || repoHookDecision)(seen, { cwd, projectDir: env.CLAUDE_PROJECT_DIR || null });
    const decision = borrowed || preToolDecision(seen, {
      inRepo: (path) => (deps.pathInKnownRepo || pathInKnownRepo)(path, deps),
      programs: programsHome(env),
      env,
    });
    if (decision) say(dialect.deny(`mc: ${decision.reason}`));
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
 * Each file is read here, not through `readClaudeSettings`: install must tell a
 * missing file (start from `{}`) from one it cannot parse (refuse), and the
 * refusal names neither the error nor the file's text, which can hold secrets.
 * One line per hook file; the exit is 1 when any file could not be read or, with
 * --check, is not right.
 */
function install(extra, { stdout, stderr, deps }) {
  if (!(extra.length === 0 || (extra.length === 1 && ROUTES.install.booleans.includes(extra[0])))) {
    stderr.write(`mc: mc hook install takes only --check\n${usage()}`);
    return 2;
  }
  const home = deps.home || undefined;
  const env = { ...(deps.env || process.env), ...(deps.home ? { HOME: deps.home, CLAUDE_CONFIG_DIR: join(deps.home, '.claude') } : {}) };
  const targets = (deps.hookTargets || hookTargets)({ env, ...(home ? { home } : {}), ...(deps.installed ? { installed: deps.installed } : {}) })
    .map((target) => (target.dialect === 'claude' && deps.claudeSettingsPath ? { ...target, path: deps.claudeSettingsPath(deps.home) } : target));
  let code = 0;
  for (const target of targets) {
    const done = installSettings(target.path, { check: extra.length === 1, readFile: deps.readFile, writeJson: deps.writeJson, target });
    (done.failed ? stderr : stdout).write(`mc: ${done.line}\n`);
    code = Math.max(code, done.code);
  }
  // The hooks are what keep the skills current; installing them installs the skills once now.
  if (extra.length === 0) {
    try {
      for (const row of (deps.syncSkills || syncSkills)(env)) stdout.write(`mc: ${row.did} ${row.name} (${row.tool})\n`);
    } catch (error) { stderr.write(`mc: skills not synced — ${error.message}\n`); }
  }
  return code;
}

/**
 * `mc hook install` on one hook file, as a function: `{ code, line, failed }`, `failed` when the file
 * could not be read as JSON and nothing was written. `target` is the file's tool entry from
 * `hookTargets`; absent, it is Claude's settings file.
 */
export function installSettings(path, { check = false, readFile = (file) => readFileSync(file, 'utf8'), writeJson = writeJsonAtomic, target = { dialect: 'claude' } } = {}) {
  const unreadable = { code: 1, line: `${path} could not be read as JSON — nothing written`, failed: true };
  let settings;
  try {
    settings = JSON.parse(readFile(path));
  } catch (error) {
    if (error?.code !== 'ENOENT') return unreadable;
    settings = {};
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return unreadable;
  const before = targetRegistration(target, settings);
  if (check) {
    if (before.ok) return { code: 0, line: `hooks registered in ${path}`, failed: false };
    return { code: 1, line: `${hookDrift(before)} — mc hook install writes them`, failed: false };
  }
  if (before.ok) return { code: 0, line: `hooks already registered in ${path}`, failed: false };
  writeJson(path, targetInstall(target, settings));
  return { code: 0, line: `hooks registered in ${path} (${hookDrift(before)} before)`, failed: false };
}

export function usage() {
  return commandUsage('hook');
}
