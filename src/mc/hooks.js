/**
 * The coding-agent hooks mc answers: what a session is told when it starts,
 * and which shell commands are turned towards the mc verb that does the same
 * work in fewer calls.
 *
 * Mechanics belong in logic, not in a model's memory (Martin, 2026-10-15:
 * "mc programmen ska vara första valet … flytta mekaniska delar från modell
 * till logik"). A session that started in a workarea never loaded the
 * repository's CLAUDE.md or its `.claude/settings.json`, and a session on a
 * merged branch 1025 commits behind main read and measured the wrong code for
 * an hour — the same day, in the session this was written from. Both are facts
 * git already knows, so mc says them before the first turn, every time.
 *
 * Everything here is pure over its inputs (a git runner, the dev-server
 * inventory, the clock), so the rules are testable without a session; the
 * command (`commands/hook.js`) reads stdin and writes the one JSON answer.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import { defaultRepos, gitDirOf } from './repos.js';
import { programsHome, workRoot } from './paths.js';

/** A branch this far behind origin/main is old enough to be the wrong code. */
export const BEHIND_WARNING = 50;

/** The escape a command carries when the turn really means the raw tool. */
export const ALLOW_MARK = 'MC_HOOK_ALLOW=1';

const gitIn = (cwd) => (args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000 });

/**
 * The repository a directory belongs to, when it is one mc knows: the name
 * from `defaultRepos`, decided by the shared git directory, so every worktree
 * of a repository is that repository wherever it stands.
 */
export function knownRepo(dir, { env = process.env, git = gitIn(dir) } = {}) {
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return null;
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.status !== 0) return null;
  const commonDir = resolve(String(common.stdout).trim());
  const repo = defaultRepos(env).find((candidate) => resolve(gitDirOf(candidate)) === commonDir);
  return repo ? { name: repo.name, worktree: resolve(String(top.stdout).trim()) } : null;
}

/**
 * The worktrees a session at `cwd` works in: the one it stands in, or — when
 * it stands in a workarea, a directory holding worktrees — each of those.
 */
export function worktreesAt(cwd, deps = {}) {
  const env = deps.env || process.env;
  const known = deps.knownRepo || knownRepo;
  const here = known(cwd, { env, ...(deps.git ? { git: deps.git(cwd) } : {}) });
  if (here) return { inside: true, worktrees: [here] };
  let names = [];
  try {
    names = (deps.readdirSync || readdirSync)(cwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return { inside: false, worktrees: [] };
  }
  const worktrees = [];
  for (const name of names) {
    const dir = join(cwd, name);
    const found = known(dir, { env, ...(deps.git ? { git: deps.git(dir) } : {}) });
    if (found && found.worktree === resolve(dir)) worktrees.push(found);
  }
  return { inside: false, worktrees };
}

/** One worktree's state, as git has it locally — no fetch, so it is instant. */
export function worktreeState(worktree, { git = gitIn(worktree), servers = [], now = Date.now(), stat = statSync } = {}) {
  const text = (args) => {
    const ran = git(args);
    return ran.status === 0 ? String(ran.stdout || '').trim() : null;
  };
  const branch = text(['branch', '--show-current']) || null;
  const upstream = text(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  // A branch that tracked something which no longer resolves: GitHub removed it
  // on merge (deleteBranchOnMerge), so the work on it has landed.
  const configured = branch ? text(['config', '--get', `branch.${branch}.merge`]) : null;
  const upstreamGone = Boolean(configured && !upstream);
  const behindText = text(['rev-list', '--count', 'HEAD..origin/main']);
  const aheadText = text(['rev-list', '--count', 'origin/main..HEAD']);
  const dirtyText = text(['status', '--porcelain=v1', '--untracked-files=normal']);
  const commonDir = text(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  let fetchedAgeH = null;
  if (commonDir) {
    try {
      fetchedAgeH = Math.round((now - stat(join(commonDir, 'FETCH_HEAD')).mtimeMs) / 3_600_000);
    } catch {
      fetchedAgeH = null;
    }
  }
  const server = servers.find((entry) => entry.live && resolve(entry.worktree_path || '') === resolve(worktree)) || null;
  return {
    worktree,
    branch,
    upstream: upstream || null,
    upstreamGone,
    behind: behindText === null ? null : Number(behindText),
    ahead: aheadText === null ? null : Number(aheadText),
    dirty: dirtyText ? dirtyText.split('\n').filter(Boolean).length : 0,
    fetchedAgeH,
    server: server ? { url: server.url, service: server.service || null } : null,
  };
}

/** The warnings a state earns, each with the one command that answers it. */
export function warningsFor(state) {
  const out = [];
  const fresh = 'git fetch origin && git switch -c <new-branch> origin/main';
  if (state.branch === 'main' || state.branch === 'master') {
    out.push(`on ${state.branch} — never commit here; branch first: git switch -c <new-branch> origin/main`);
  }
  if (state.upstreamGone) {
    out.push(`${state.branch} tracked a remote branch that is gone — its PR has merged. Do not build on it: ${fresh}`);
  } else if (state.behind !== null && state.behind >= BEHIND_WARNING) {
    out.push(`${state.branch || 'HEAD'} is ${state.behind} commits behind origin/main — you would read and measure old code. Unless this branch is the work in hand: ${fresh}`);
  }
  if (state.fetchedAgeH !== null && state.fetchedAgeH >= 24) {
    out.push(`origin was last fetched ${state.fetchedAgeH} h ago, so the counts above may be low: git fetch origin`);
  }
  return out;
}

/**
 * The toolbox, in the order a session reaches for it. One line each, the
 * command first: a session reads this once, at the start, and the line has to
 * be the answer.
 */
export const TOOLBOX = [
  'mc is the first choice for every mechanical step; the raw tool only when mc cannot (say why).',
  '  see the app       mc shot dev <target|/app/path> [--viewport iphone] [--measure <css>] [--keep → mc shot next …]',
  '                    serves the worktree you stand in, restarts it after edits, prints which tree it served',
  '  step a flow       mc shot next [<id>] --click/--fill/--press/--upload/--eval <js> … — errors back in the same call',
  '  a server URL      mc test dev --here --url',
  '  run tests         mc gate <files…> [--test-name-pattern …]   (in the gate lane, at most 30 files, 2 KB verdict)',
  '                    mc gate alone: the test files this branch changed; no whole suite — that is the merger\'s',
  '  publish + land    mc publish [--title … --body-file … --base …]   (push, open/update the PR, queue it for the merger)',
  '  what runs where   mc dev list · mc prs · mc status <name>',
  'Every verb: mc <verb> --help.',
];

/** The SessionStart context: the worktrees' state, the warnings, the toolbox. */
export function sessionStartContext({ cwd, inside, states }) {
  if (!states.length) return null;
  const lines = ['mc — session start'];
  if (!inside) {
    lines.push(`This session started in ${cwd}, outside the repositories: their CLAUDE.md was NOT loaded; their PreToolUse hooks are run by mc hook pre-tool.`);
    lines.push(`Read ${states.map((state) => join(state.worktree, 'CLAUDE.md')).join(' and ')} before changing anything, and run commands from inside the worktree.`);
  }
  for (const state of states) {
    const parts = [`${state.worktree}: ${state.branch || '(detached)'}`];
    if (state.behind !== null) parts.push(`${state.behind} behind / ${state.ahead} ahead of origin/main`);
    parts.push(state.dirty ? `${state.dirty} changed file${state.dirty === 1 ? '' : 's'}` : 'clean');
    if (state.server) parts.push(`dev server ${state.server.url}`);
    lines.push(parts.join(' · '));
    for (const warning of warningsFor(state)) lines.push(`  WARNING: ${warning}`);
  }
  lines.push('', ...TOOLBOX);
  return lines.join('\n');
}

/**
 * A programme's plan, draft, state and closeout files are written by the verbs
 * only (ruling 51): `mc project`, `mc step`, the runner and the merger. The hook
 * catches a session's hand-edit of one — a mistake, not an intent: a codex
 * session has no mc hook, and a Bash rule is a regular expression.
 */
const PROTECTED = /^(PLAN|DRAFT|STATE|CLOSEOUT)\.json$/u;

/** The reason a plan-file refusal gives, whichever tool made it. */
const PLAN_FILE_REASON = 'This file is mc\'s: a plan changes through `mc project` (new, edit, criterion add, step add, step edit, send), a step\'s state through `mc step`, a criterion through `mc project criterion met`. Run `mc project <name>` to read it.';

/** Whether `path` is one of those files anywhere under `programs`. */
export function protectedPlanFile(path, { programs = programsHome() } = {}) {
  const file = resolve(String(path));
  return file.startsWith(`${resolve(programs)}${sep}`) && PROTECTED.test(basename(file));
}

/**
 * The shell commands that have an mc verb, and the verb. Matched on the
 * command's words, not its whole text, so `echo "gh pr create"` is left alone
 * only as far as a regular expression can tell — the escape covers the rest.
 */
/**
 * What a session is told when it reaches for the suite: there is none to run
 * in a worktree. The merger measures the pull request once, in its lane.
 */
const SUITE_REASON = 'The whole suite is the merger\'s, not this session\'s: `mc publish` queues the pull request and the merge round measures it once, in its lane. Run the tests your change reaches with `mc gate <files…>` (or bare `mc gate`: the test files this branch changed).';

/**
 * What a session is told when it installs the tree itself: a memoro checkout
 * is attached to the per-lockfile cache, and memoro-cli resolves the one tree.
 */
const DEPS_REASON = 'Dependencies are mc\'s: in a memoro checkout run `npm run deps:ensure` — it links node_modules to the shared cache for this lockfile in about a second, instead of a 500 MB install of your own. A memoro-cli checkout resolves ~/mc/node_modules and needs nothing. `npm install <package>` to add a dependency passes.';

export const BASH_RULES = [
  {
    id: 'pr-create',
    test: /(^|[;&|(]\s*|\s)gh\s+pr\s+create\b/u,
    reason: 'Use `mc publish` — it pushes this branch without force and opens its PR (title and body from the last commit, or --title/--body-file), and ends with the mc merge line.',
  },
  {
    id: 'pr-edit',
    test: /(^|[;&|(]\s*|\s)gh\s+pr\s+edit\b/u,
    reason: 'Use `mc publish` — on an open pull request `--title`, `--body-file` and `--base` each edit only their own field, and without a body it lists the commits after the description.',
  },
  {
    id: 'push',
    test: /(^|[;&|(]\s*|\s)git\s+push\b/u,
    reason: 'Use `mc publish` — it pushes without force, refuses on main, a dirty tree or a moved remote, and opens or updates the PR; `--branch <name>` from a detached HEAD. A deliberate force-with-lease (a rebased stack) carries MC_HOOK_ALLOW=1.',
  },
  {
    id: 'pr-merge',
    test: /(^|[;&|(]\s*|\s)gh\s+pr\s+merge\b(?![^\n]*--admin)/u,
    reason: 'Use `mc merge <repo> <pr>` — it measures the candidate and merges the head it measured. `gh pr merge --admin` stays the documented fallback when the gate livelocks (AGENTS.md).',
  },
  {
    id: 'ci',
    // `--list` asks why each file was chosen, which mc gate does not answer.
    test: /(^|[;&|(]\s*|\s)npm\s+run\s+ci\b(?![^\n]*--list)/u,
    reason: SUITE_REASON,
  },
  {
    // The suite, or a run of test files beside the gate lane: every test run
    // a session starts goes through `mc gate`, which waits its turn in the
    // lane (2026-10-24). `npm run test:<x>` is a script of its own and passes.
    id: 'npm-test',
    test: /(^|[;&|(]\s*|\s)npm\s+(run\s+)?test(?![\w:-])/u,
    reason: SUITE_REASON,
  },
  {
    // A whole-tree install in a checkout: memoro's are attached to its
    // per-lockfile cache (`npm run deps:ensure`) and memoro-cli's resolve
    // the one tree above the workareas (work-deps.js). Adding a package
    // (`npm install <pkg>`) and a lockfile-only install pass.
    id: 'npm-install',
    test: /(^|[;&|(]\s*|\s)npm\s+(ci|clean-install|install|i)(?![\w:-])(?![^\n;&|]*--package-lock-only)(\s+--?[\w-]+(=\S+)?)*\s*(\d?>|[;&|)]|$)/u,
    reason: DEPS_REASON,
  },
  {
    id: 'node-test',
    test: /(^|[;&|(]\s*|\s)node\s+(?:[^\n;&|]*\s)?--test(?![\w-])/u,
    reason: 'Use `mc gate <files…> [--test-name-pattern …]` — the same node --test with the repository\'s flags, run in the gate lane (one run at a time beside merge rounds and other sessions), the whole output in a file and the failures printed.',
  },
  {
    id: 'dev-server',
    test: /(^|[;&|(]\s*|\s)npm\s+run\s+dev(:agent)?\b/u,
    reason: 'Use `mc test dev --here --url` for a server for this worktree (started if down, restarted when its tree moved or was edited), or `mc shot dev …` to look at the app. `npm run dev` is for a person at a terminal.',
  },
  {
    // One simulator, reused (2026-10-24): every session that made its own
    // left a device behind, one of them 2.3 GB. Only the device named `mc`
    // is ever created; a fresh phone is that device erased, not a new one.
    id: 'simulator',
    test: /(^|[;&|(]\s*|\s)(xcrun\s+)?simctl\s+(clone\b|create\b(?!\s+(['"]?)mc\4\s))/u,
    reason: 'Use the one simulator, the device named `mc`: `xcrun simctl boot mc`, then `xcrun simctl install mc <app>` and `xcrun simctl launch mc <bundle id>`. A clean phone is `xcrun simctl shutdown mc && xcrun simctl erase mc`, not a new device. When it does not exist yet, create exactly that one: `xcrun simctl create mc "iPhone 17"`.',
  },
  {
    id: 'plan-file',
    // A write verb naming a plan file: a redirect, tee, sed -i, or a move, copy, removal or install of it.
    test: /(>>?|\btee\b|\bsed\s+-i|\b(mv|cp|rm|truncate|install)\b)[^;&|\n]*\b(PLAN|DRAFT|STATE|CLOSEOUT)\.json\b/u,
    reason: PLAN_FILE_REASON,
  },
];

/** Playwright written into a scratch file is a shot mc already takes. */
const PLAYWRIGHT = /\bfrom\s+['"][^'"]*playwright[^'"]*['"]|require\(\s*['"][^'"]*playwright/u;

/*
 * Claude in Chrome against a local dev server is a flow `mc shot --keep` and
 * `mc shot next` step through, one call each with the errors in the answer
 * (2026-10-24: three sessions in ten days, 76 Chrome calls). Only a navigation
 * to a local host is turned; a real site, a published artifact and a tab that
 * is already open pass.
 */
const CHROME = 'mcp__claude-in-chrome__';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const CHROME_REASON = 'Use `mc shot dev <path> --keep` and then `mc shot next [--click|--fill|--press|--upload|--eval <js>|--goto <path>|--wait-for <css>|--measure <css>] [--timeout <s>]`: one call per step, the same browser, every page, request, server and dialog error back in the same call, and the server restarted after your edits. If mc shot cannot do what you need, say what is missing so mc can learn it; a call that still needs Chrome carries #MC_HOOK_ALLOW=1 on its URL and says why.';

/** Whether `url` names a server on this machine; a bare `localhost:8920/app` counts. */
function localUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  const text = url.trim();
  try {
    return LOCAL_HOSTS.has(new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : `http://${text}`).hostname);
  } catch {
    return false;
  }
}

/** Whether one `browser_batch` action is a navigate to a local server, whatever shape it is written in. */
function localNavigateAction(action) {
  if (!isPlainObject(action)) return false;
  const named = ['tool', 'name', 'action', 'type', 'tool_name'].some((key) => typeof action[key] === 'string' && /(^|__)navigate$/u.test(action[key]));
  if (!named) return false;
  return [action, action.input, action.args, action.arguments, action.params, action.parameters]
    .some((place) => isPlainObject(place) && localUrl(place.url));
}

/** Whether a Claude in Chrome call sends the browser to a local server. */
function chromeToLocal(tool, args) {
  const verb = tool.slice(CHROME.length);
  if (verb === 'navigate' || verb === 'tabs_create_mcp') return localUrl(args.url);
  if (verb === 'browser_batch') return Array.isArray(args.actions) && args.actions.some(localNavigateAction);
  return false;
}

/**
 * The PreToolUse answer for one tool call: `null` to let it run, or the reason
 * it is turned to an mc verb. `inRepo` says whether a written file lands inside
 * a known repository, where a Playwright script is the repository's own code.
 */
export function preToolDecision(input, { inRepo = () => false, programs = programsHome() } = {}) {
  const tool = input?.tool_name;
  const args = input?.tool_input || {};
  if (typeof tool === 'string' && tool.startsWith(CHROME)) {
    if (JSON.stringify(args).includes(ALLOW_MARK) || !chromeToLocal(tool, args)) return null;
    return { id: 'chrome-dev', reason: CHROME_REASON };
  }
  if (tool === 'Bash') {
    const command = String(args.command || '');
    if (command.includes(ALLOW_MARK)) return null;
    for (const rule of BASH_RULES) {
      if (rule.test.test(command)) return { id: rule.id, reason: `${rule.reason} (Escape, when the raw command is really meant: put ${ALLOW_MARK} in it and say why.)` };
    }
    return null;
  }
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
    // A relative path lands where the session's own cwd says, so it is resolved there.
    if (protectedPlanFile(resolve(String(input?.cwd || ''), String(args.file_path || '')), { programs })) {
      return { id: 'plan-file', reason: PLAN_FILE_REASON };
    }
  }
  if (tool === 'Write') {
    const content = String(args.content || '');
    const path = String(args.file_path || '');
    if (PLAYWRIGHT.test(content) && !inRepo(path) && !content.includes(ALLOW_MARK)) {
      return {
        id: 'playwright',
        reason: 'Use `mc shot dev <target> [--viewport iphone] [--safe-area t,r,b,l] [--wait-for <css>] [--scroll <css>[@end]] [--measure <css>] [--account seeded|new] [--onboarding]` — it serves this worktree, signs in, and prints the PNG path and the measured boxes. If it cannot answer the question, say what is missing so mc can learn it; a scratch script that still has to be written carries a comment with MC_HOOK_ALLOW=1.',
      };
    }
  }
  return null;
}

/*
 * A session that started outside a repository (a plan directory, a workarea)
 * never loaded that repository's hooks, and memoro's are its data-access
 * policy, so mc runs them. `CLAUDE_PROJECT_DIR` is the worktree, so their
 * `$CLAUDE_PROJECT_DIR/.claude/hooks/...` paths resolve.
 */

/** The PreToolUse hook commands a worktree's `.claude/settings.json` names for a tool, in file order. */
export function repoPreToolHooks(worktree, tool, { readFileSync: read = readFileSync } = {}) {
  let settings;
  try {
    settings = JSON.parse(read(join(worktree, '.claude', 'settings.json'), 'utf8'));
  } catch {
    return [];
  }
  const entries = settings?.hooks?.PreToolUse;
  if (!Array.isArray(entries)) return [];
  const matches = (matcher) => {
    if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
    try {
      return new RegExp(`^(?:${matcher})$`, 'u').test(tool);
    } catch {
      return false;
    }
  };
  const commands = [];
  for (const entry of entries) {
    if (!entry || !matches(entry.matcher) || !Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (hook?.type === 'command' && typeof hook.command === 'string' && hook.command) commands.push(hook.command);
    }
  }
  return commands;
}

/**
 * The first denial the PreToolUse hooks of the worktrees at `cwd` give a tool
 * call — `{ id: 'repo-hook', reason }` — or `null`. The worktree `projectDir`
 * names is skipped: Claude Code already ran its hooks.
 */
export function repoHookDecision(input, {
  cwd, projectDir = null, worktreesAt: find = worktreesAt, readFileSync: read = readFileSync,
  spawnSync: spawn = spawnSync, env = process.env, findDeps = {},
} = {}) {
  const tool = input?.tool_name;
  if (!tool) return null;
  const { worktrees } = find(cwd, findDeps);
  for (const entry of worktrees || []) {
    if (projectDir && resolve(entry.worktree) === resolve(projectDir)) continue;
    for (const command of repoPreToolHooks(entry.worktree, tool, { readFileSync: read })) {
      const r = spawn('/bin/sh', ['-c', command], {
        cwd: entry.worktree,
        input: JSON.stringify(input),
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...env, CLAUDE_PROJECT_DIR: entry.worktree },
      });
      if (r.status === 2) {
        return { id: 'repo-hook', reason: `${entry.name} hook: ${String(r.stderr || '').trim() || command}` };
      }
      let parsed = null;
      try {
        parsed = JSON.parse(String(r.stdout || '').trim());
      } catch {
        parsed = null;
      }
      if (parsed?.hookSpecificOutput?.permissionDecision === 'deny') {
        return { id: 'repo-hook', reason: `${entry.name} hook: ${parsed.hookSpecificOutput.permissionDecisionReason || command}` };
      }
    }
  }
  return null;
}

/** Whether a path lies inside a worktree of a repository mc knows. */
export function pathInKnownRepo(path, deps = {}) {
  let dir = resolve(String(path || ''));
  // The file may not exist yet: ask about the nearest directory that does.
  while (dir && !(deps.existsSync || existsSync)(dir)) {
    const parent = resolve(dir, '..');
    if (parent === dir) return false;
    dir = parent;
  }
  return Boolean((deps.knownRepo || knownRepo)(dir, deps.env ? { env: deps.env } : {}));
}

/** mc's ground: a known repository's worktree, or anything under ~/mc. */
export function inMcTerritory(cwd, deps = {}) {
  const env = deps.env || process.env;
  const mcRoot = resolve(workRoot(env));
  const here = resolve(String(cwd || ''));
  if (here === mcRoot || here.startsWith(`${mcRoot}${sep}`)) return true;
  return Boolean((deps.knownRepo || knownRepo)(here, { env }));
}

/*
 * The two entries `mc hook install` writes into `~/.claude/settings.json`, and
 * the ones `--check` and the page compare the file against. `|| true`: a hook
 * must never stand between a session and its work. `Read` is in the matcher so
 * the repositories' Read hooks (memoro's block-sqlite-state.sh) answer through
 * `mc hook pre-tool`. `Edit` and `MultiEdit` are in it so the plan-file refusal
 * sees them, and the Claude in Chrome tools so a dev-server flow is turned to
 * `mc shot next`.
 */
export const MC_HOOKS = Object.freeze([
  Object.freeze({ event: 'SessionStart', which: 'session-start', matcher: null, command: 'mc hook session-start 2>/dev/null || true' }),
  Object.freeze({ event: 'PreToolUse', which: 'pre-tool', matcher: 'Bash|Write|Read|Edit|MultiEdit|mcp__claude-in-chrome__.*', command: 'mc hook pre-tool 2>/dev/null || true' }),
]);

/** Claude Code's user settings file. */
export function claudeSettingsPath(home = homedir()) {
  return join(home, '.claude', 'settings.json');
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The settings file as an object, or `null` when it is missing, unreadable, not
 * JSON or not a plain object. It never throws, and it never says what it read:
 * a parse error quotes the file, and the file can hold secrets.
 */
export function readClaudeSettings(path, { readFileSync: read = readFileSync } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(read(path, 'utf8'));
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}

/** Whether a hook is the mc command for `which`: `mc hook <which>` and nothing longer. */
const isMcHook = (hook, which) => hook?.type === 'command'
  && typeof hook.command === 'string'
  && new RegExp(`^mc hook ${which}\\b`, 'u').test(hook.command);

/**
 * The state of mc's entries in a settings object: `{ ok, problems }`, where a
 * problem is `{ which, have, want }` — `have` is `null` when there is no entry,
 * `'twice'` when there are two, else the matcher and command there are.
 */
export function hookRegistration(settings) {
  const problems = [];
  for (const want of MC_HOOKS) {
    const entries = Array.isArray(settings?.hooks?.[want.event]) ? settings.hooks[want.event] : [];
    const mine = entries.filter((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((hook) => isMcHook(hook, want.which)));
    if (mine.length === 0) {
      problems.push({ which: want.which, have: null, want });
    } else if (mine.length > 1) {
      problems.push({ which: want.which, have: 'twice', want });
    } else {
      const matcher = mine[0].matcher || null;
      const command = mine[0].hooks.find((hook) => isMcHook(hook, want.which)).command;
      if (matcher !== want.matcher || command !== want.command) {
        problems.push({ which: want.which, have: { matcher, command }, want });
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/** One short phrase per problem, or `null` when the registration is right. */
export function hookDrift({ problems }) {
  if (!problems.length) return null;
  return problems.map(({ which, have, want }) => {
    if (have === null) return `${which} not registered`;
    if (have === 'twice') return `${which} registered twice`;
    if (have.matcher !== want.matcher) return `${which} on ${have.matcher || 'every tool'}, want ${want.matcher || 'every tool'}`;
    return `${which} runs another command`;
  }).join(', ');
}

/**
 * The settings object with mc's entries written: the first mc entry for each
 * event takes the want's matcher and command, the other mc entries for it are
 * removed, and everything else keeps its value and its order. Returns a copy;
 * the argument is not changed.
 */
export function installHooks(settings) {
  const next = structuredClone(settings);
  if (!isPlainObject(next.hooks)) next.hooks = {};
  for (const want of MC_HOOKS) {
    if (!Array.isArray(next.hooks[want.event])) next.hooks[want.event] = [];
    const entries = next.hooks[want.event];
    const first = entries.find((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((hook) => isMcHook(hook, want.which)));
    if (!first) {
      entries.push({ ...(want.matcher ? { matcher: want.matcher } : {}), hooks: [{ type: 'command', command: want.command }] });
      continue;
    }
    if (want.matcher) first.matcher = want.matcher;
    else delete first.matcher;
    first.hooks[first.hooks.findIndex((hook) => isMcHook(hook, want.which))] = { type: 'command', command: want.command };
    next.hooks[want.event] = entries.flatMap((entry) => {
      if (entry === first || !Array.isArray(entry?.hooks) || !entry.hooks.some((hook) => isMcHook(hook, want.which))) return [entry];
      const hooks = entry.hooks.filter((hook) => !isMcHook(hook, want.which));
      return hooks.length ? [{ ...entry, hooks }] : [];
    });
  }
  return next;
}
