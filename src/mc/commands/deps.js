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
import { basename } from 'node:path';

import { defaultRepos } from '../brief-collect.js';
import { bump } from '../deps-bump.js';
import { formatReading, hasLockfile, readDeps } from '../deps.js';
import { scanArgs } from './flags.js';
import { resolveRepoPath } from './repo.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;

  if (argv[0] === 'bump') return runBump(argv.slice(1), { ...deps, stdout, stderr, env });
  const scanned = scanArgs(argv, { booleans: ['--json', '--refresh'] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const { flags, positional } = scanned;
  if (positional.length > 1) {
    stderr.write(`mc: one repository at a time (${positional.slice(1).join(' ')} is extra)\n${usage()}`);
    return 2;
  }

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
      const { reading } = await readDeps({ repoPath, repo: basename(repoPath), now, ...options });
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
  const scanned = scanArgs(argv, { booleans: ['--dry-run', '--json'] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const { flags, positional } = scanned;
  if (positional.length !== 2) {
    stderr.write(`mc: mc deps bump takes a repository and what to bump\n${usage()}`);
    return 2;
  }
  const repoPath = await (deps.resolveRepo || resolveRepoPath)(positional[0]);
  if (!repoPath) {
    stderr.write(`mc: no repository called "${positional[0]}" — mc repo status lists the ones mc can see\n`);
    return 1;
  }
  return bump({
    repo: basename(repoPath),
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
  return [
    'usage — mc deps [<repo>] [--json] [--refresh]\n',
    '  Which dependencies of <repo>\'s origin/main need updating: npm audit and npm view\n',
    '  of its lockfile, in three groups — security within the major, patch/minor, major —\n',
    '  each row runtime or tool, with the repository\'s declared notes. No repo reads\n',
    '  every one with a package-lock.json. A saved reading of the same sha younger than\n',
    '  6 h is reused; --refresh reads anew. Saved in ~/.memoro/mc/deps/<repo>.json.\n',
    '\n',
    'usage — mc deps bump <repo> security|minor|<package>[@<version>] [--dry-run] [--json]\n',
    '  A fresh reading, then a workarea deps-<repo>-<what>-<yyyymmdd> on origin/main where\n',
    '  npm changes package.json and package-lock.json with --package-lock-only only; one\n',
    '  commit, mc publish, mc merge <repo> <pr>. A group never crosses a major; only a\n',
    '  named <package>@<version> may. --dry-run prints the change and makes nothing.\n',
  ].join('');
}
