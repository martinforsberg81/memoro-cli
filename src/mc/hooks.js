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
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { defaultRepos } from './brief-collect.js';
import { workRoot } from './paths.js';

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
  const repo = defaultRepos(env).find((candidate) => resolve(candidate.path, '.git') === commonDir);
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
  '  see the app       mc shot dev <target|/app/path> [--viewport iphone] [--scroll <css>] [--measure <css>]',
  '                    serves the worktree you stand in, restarts it after edits, prints which tree it served',
  '  a server URL      mc test dev --here --url',
  '  check the tree    mc gate            (npm run ci for this worktree, 2 KB verdict)',
  '  run some tests    mc gate <files…> [--test-name-pattern …]   (whole output in a file, the failures printed)',
  '  publish           mc publish [--title … --body-file …]   (push + open/update the PR, never force)',
  '  land              mc merge <repo> <pr>   (the gate, then the merge)',
  '  what runs where   mc dev list · mc prs · mc status <name>',
  'Every verb: mc <verb> --help.',
];

/** The SessionStart context: the worktrees' state, the warnings, the toolbox. */
export function sessionStartContext({ cwd, inside, states }) {
  if (!states.length) return null;
  const lines = ['mc — session start'];
  if (!inside) {
    lines.push(`This session started in ${cwd}, outside the repositories: their CLAUDE.md and .claude/settings.json were NOT loaded.`);
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
 * The shell commands that have an mc verb, and the verb. Matched on the
 * command's words, not its whole text, so `echo "gh pr create"` is left alone
 * only as far as a regular expression can tell — the escape covers the rest.
 */
export const BASH_RULES = [
  {
    id: 'pr-create',
    test: /(^|[;&|(]\s*|\s)gh\s+pr\s+create\b/u,
    reason: 'Use `mc publish` — it pushes this branch without force and opens its PR (title and body from the last commit, or --title/--body-file), and ends with the mc merge line.',
  },
  {
    id: 'push',
    test: /(^|[;&|(]\s*|\s)git\s+push\b/u,
    reason: 'Use `mc publish` — it pushes without force, refuses on main, a dirty tree or a moved remote, and opens or updates the PR. A deliberate force-with-lease (a rebased stack) carries MC_HOOK_ALLOW=1.',
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
    reason: 'Use `mc gate` — the same `npm run ci -- --base-ref origin/main`, with the whole output in a file and a 2 KB verdict printed.',
  },
  {
    id: 'dev-server',
    test: /(^|[;&|(]\s*|\s)npm\s+run\s+dev(:agent)?\b/u,
    reason: 'Use `mc test dev --here --url` for a server for this worktree (started if down, restarted when its tree moved or was edited), or `mc shot dev …` to look at the app. `npm run dev` is for a person at a terminal.',
  },
];

/** Playwright written into a scratch file is a shot mc already takes. */
const PLAYWRIGHT = /\bfrom\s+['"][^'"]*playwright[^'"]*['"]|require\(\s*['"][^'"]*playwright/u;

/**
 * The PreToolUse answer for one tool call: `null` to let it run, or the reason
 * it is turned to an mc verb. `inRepo` says whether a written file lands inside
 * a known repository, where a Playwright script is the repository's own code.
 */
export function preToolDecision(input, { inRepo = () => false } = {}) {
  const tool = input?.tool_name;
  const args = input?.tool_input || {};
  if (tool === 'Bash') {
    const command = String(args.command || '');
    if (command.includes(ALLOW_MARK)) return null;
    for (const rule of BASH_RULES) {
      if (rule.test.test(command)) return { id: rule.id, reason: `${rule.reason} (Escape, when the raw command is really meant: put ${ALLOW_MARK} in it and say why.)` };
    }
    return null;
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
