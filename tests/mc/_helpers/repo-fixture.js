/**
 * The fixture the `mc repo` tests share.
 *
 * A throwaway repository with a bare "origin" beside it, a work root of its
 * own, and a PATH holding only the tools under test — so a machine with (or
 * without) gh installed reads the same either way.
 *
 * `gh` is written as a shell script rather than mocked in-process: the view
 * shells out exactly as a user's machine would, and the script records every
 * call so a test can assert that `--offline` made none.
 */
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { git, makeTempRepo } from './git-fixture.js';

const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * A repository, one piece of work with a worktree on it, and a PATH.
 *
 * `gh` is written as a shell script rather than mocked in-process: the view
 * shells out exactly as a user's machine would, and the script records every
 * call so a test can assert that `--offline` made none.
 */
export function fixture({ gh = false, prs = [], name = 'repo-view' } = {}) {
  const repo = makeTempRepo({ name });
  const workRoot = join(repo.root, 'work');
  const bin = join(repo.root, 'bin');
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(bin, { recursive: true });

  const ghLog = join(repo.root, 'gh-calls.log');
  const prsPath = join(repo.root, 'prs.json');
  if (gh) {
    writeFileSync(prsPath, JSON.stringify(prs));
    writeFileSync(join(bin, 'gh'), [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${ghLog}"`,
      `if [ "$1" = "pr" ]; then cat "${prsPath}"; exit 0; fi`,
      'exit 1',
    ].join('\n'));
    chmodSync(join(bin, 'gh'), 0o755);
  }

  return {
    ...repo,
    // git reports the resolved path, and on macOS the temporary directory is
    // reached through a symlink — so every comparison uses this one.
    dir: realpathSync(repo.dir),
    workRoot,
    bin,
    ghLog,
    prsPath,
    env: {
      MC_HOME: repo.mcHome,
      MC_WORK_ROOT: workRoot,
      CLAUDE_CONFIG_DIR: join(repo.root, 'claude'),
      CODEX_HOME: join(repo.root, 'codex'),
      PATH: `${bin}:${SAFE_PATH}`,
    },
  };
}

/** Put a worktree of the fixture repository under a piece of work. */
export function addArea(fx, name, branch) {
  const area = join(fx.workRoot, name);
  mkdirSync(area, { recursive: true });
  git(fx.dir, `worktree add -q -b ${branch} "${join(area, 'repo')}" main`);
  return join(area, 'repo');
}

/** One more commit on origin's main, which this checkout has not seen. */
export function moveOriginMain(fx, message = 'Moved on') {
  const clone = join(fx.root, `push-${Math.random().toString(36).slice(2, 8)}`);
  git(fx.root, `clone -q "${fx.root}/origin.git" "${clone}"`);
  writeFileSync(join(clone, 'moved.txt'), `${message}\n`);
  git(clone, 'add moved.txt');
  git(clone, `commit -q -m "${message}"`);
  git(clone, 'push -q origin main');
  return git(clone, 'rev-parse HEAD');
}

export function json(result) {
  assert.equal(result.status, 0, `exit ${result.status}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

/**
 * Every file under a directory, with its size and modification time.
 *
 * `.git` is left out on purpose: a fetch is allowed to move remote-tracking
 * refs, and `git status` refreshes the index's stat cache as it reads. What
 * must not move is asserted separately and exactly — the working tree, HEAD,
 * and every local branch.
 */
export function snapshot(root, { skipGit = false } = {}) {
  const seen = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipGit && entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const stat = statSync(full);
      seen[relative(root, full)] = `${stat.size}:${stat.mtimeMs}`;
    }
  };
  if (existsSync(root)) walk(root);
  return seen;
}

