/**
 * `mc deps [<repo>] [--json] [--refresh]` — which of a repository's
 * dependencies need updating, and how urgently (ruling 29).
 *
 * The reading is `src/mc/deps.js`: npm's audit and `npm view` of the lockfile
 * on `origin/main`, in three groups, with the repository's declared notes.
 * It is saved under `~/.memoro/mc/deps/<repo>.json` for `mc deploy` to quote,
 * and a saved reading of the same sha younger than six hours is printed as it
 * is unless `--refresh` asks for a new one.
 *
 * No repository means every one of `defaultRepos` whose `origin/main` has a
 * `package-lock.json`. `mc deps bump` turns a group into a pull request
 * through the gate — `src/mc/deps-bump.js`.
 */
import { defaultRepos } from '../brief-collect.js';
import { bump } from '../deps-bump.js';
import { formatReading, hasLockfile, readDeps } from '../deps.js';
import { repoNameOf } from '../repos.js';
import { scanArgs } from './flags.js';
import { resolveRepoPath } from './repo.js';
import { commandUsage } from '../command-help.js';

/** Each subcommand and the scan it is read with; '' is the bare verb, '*' a first word that names something. help-routes.test.js walks the help with it. */
/** `check`: what the scanned arguments may not be — null, or what is wrong; the verb runs it, and help-routes.test.js walks the help with it. */
export const ROUTES = {
  '': {
    booleans: ['--json', '--refresh'],
    check: ({ positional }) => (positional.length > 1 ? `one repository at a time (${positional.slice(1).join(' ')} is extra)` : null),
  },
  bump: { booleans: ['--dry-run', '--json'], check: ({ positional }) => (positional.length !== 2 ? 'mc deps bump takes a repository and what to bump' : null) },
};
ROUTES['*'] = ROUTES[''];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;

  if (argv[0] === 'bump') return runBump(argv.slice(1), { ...deps, stdout, stderr, env });
  const scanned = scanArgs(argv, ROUTES['']);
  const refused = scanned.error || ROUTES[''].check(scanned);
  if (refused) { stderr.write(`mc: ${refused}\n${usage()}`); return 2; }
  const { flags, positional } = scanned;

  const options = {
    refresh: flags.refresh,
    env,
    ...(deps.git ? { git: deps.git } : {}),
    ...(deps.npm ? { npm: deps.npm } : {}),
    ...(deps.runNote ? { runNote: deps.runNote } : {}),
    ...(deps.root ? { root: deps.root } : {}),
  };
  const now = deps.now || (() => new Date());

  let paths = [];
  if (positional.length) {
    const repoPath = await (deps.resolveRepo || resolveRepoPath)(positional[0]);
    if (!repoPath) {
      stderr.write(`mc: no repository called "${positional[0]}" — mc repo status lists the ones mc can see\n`);
      return 1;
    }
    paths = [repoPath];
  } else {
    for (const repo of (deps.repos || defaultRepos(env))) {
      if (await hasLockfile(repo.path, options)) paths.push(repo.path);
    }
    if (!paths.length) {
      stderr.write('mc: no repository here has a package-lock.json on origin/main\n');
      return 1;
    }
  }

  const readings = [];
  let code = 0;
  for (const repoPath of paths) {
    try {
      const { reading } = await readDeps({ repoPath, repo: repoNameOf(repoPath), now, ...options });
      readings.push(reading);
      if (!flags.json) stdout.write(`${readings.length > 1 ? '\n' : ''}${formatReading(reading, { now: now() })}`);
    } catch (error) {
      stderr.write(`mc: ${error.message}\n`);
      code = 1;
    }
  }
  if (flags.json && readings.length) {
    stdout.write(`${JSON.stringify(positional.length ? readings[0] : readings, null, 2)}\n`);
  }
  return code;
}

async function runBump(argv, deps) {
  const { stdout, stderr, env } = deps;
  const scanned = scanArgs(argv, ROUTES.bump);
  const refused = scanned.error || ROUTES.bump.check(scanned);
  if (refused) { stderr.write(`mc: ${refused}\n${usage()}`); return 2; }
  const { flags, positional } = scanned;
  const repoPath = await (deps.resolveRepo || resolveRepoPath)(positional[0]);
  if (!repoPath) {
    stderr.write(`mc: no repository called "${positional[0]}" — mc repo status lists the ones mc can see\n`);
    return 1;
  }
  return bump({
    repo: repoNameOf(repoPath),
    repoPath,
    what: positional[1],
    dryRun: flags['dry-run'],
    json: flags.json,
    env,
    stdout,
    stderr,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.git ? { git: deps.git } : {}),
    ...(deps.npm ? { npm: deps.npm } : {}),
    ...(deps.reading ? { reading: deps.reading } : {}),
    ...(deps.addWorktree ? { addWorktree: deps.addWorktree } : {}),
    ...(deps.publish ? { publish: deps.publish } : {}),
    ...(deps.merge ? { merge: deps.merge } : {}),
  });
}

export function usage() {
  return commandUsage('deps');
}
