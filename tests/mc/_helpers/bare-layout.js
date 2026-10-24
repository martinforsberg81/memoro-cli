/**
 * The second repository layout (repos.js) in a temporary `MC_REPOS_HOME`:
 * `<home>/<name>.git`, a bare repository with `origin/main` fetched from an
 * upstream beside it, and — for the names in `self` — `<home>/self/<name>`, a
 * worktree of it on `main`. `clones` are ordinary checkouts instead, the
 * first layout, under `<home>/<name>`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { git } from './git-fixture.js';

/** An upstream repository with one commit holding `files`, at `<root>/upstream/<name>`. */
function upstream(root, name, files) {
  const dir = join(root, 'upstream', name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init -q -b main');
  for (const [file, text] of Object.entries({ 'README.md': `# ${name}\n`, ...files })) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  git(dir, 'add -A');
  git(dir, 'commit -q -m "Initial commit"');
  return dir;
}

export function makeRepoLayout({ bare = [], self = [], clones = [], files = {} } = {}) {
  // Real, so the paths here are the ones git names (`/private/var` on macOS).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-repos-layout-')));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  for (const name of bare) {
    const source = upstream(root, name, files[name] || {});
    const dir = join(home, `${name}.git`);
    git(root, `clone -q --bare "${source}" "${dir}"`);
    // A bare clone has no remote-tracking refs; mc reads `origin/main`.
    git(dir, 'config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"');
    git(dir, 'fetch -q origin');
    if (self.includes(name)) {
      mkdirSync(join(home, 'self'), { recursive: true });
      git(dir, `worktree add -q "${join(home, 'self', name)}" main`);
    }
  }
  for (const name of clones) {
    const source = upstream(root, name, files[name] || {});
    git(root, `clone -q "${source}" "${join(home, name)}"`);
  }
  return {
    root,
    home,
    env: { MC_REPOS_HOME: home, MC_WORK_ROOT: join(root, 'mc') },
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}
