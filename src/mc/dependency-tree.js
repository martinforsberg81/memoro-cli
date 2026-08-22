/**
 * Is the dependency tree there?
 *
 * A suite run in a worktree without `node_modules` does not fail — it runs the
 * tests that happen to need nothing and prints a number with the right shape
 * (D-0152: 2162 tests, 30 fail, where 206 never ran and were not counted as
 * skipped; 2368/2368 once the tree was linked). Four of twenty-seven worktrees
 * had no tree at all. A number from such a run is not low, it is invalid, and
 * nothing about the number says so.
 *
 * This answers one question, from the manifest and the filesystem, and offers
 * no opinion about what to do: whether the declared dependencies have a tree
 * to be found in. A manifest that declares nothing needs no tree — the gate
 * table's own proof for an undeclared repository (`nothingToInstall`) — and a
 * directory with no manifest is not a Node project.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `{ manifest, declares, present, missing }`:
 *   manifest — a `package.json` could be read
 *   declares — how many dependencies + devDependencies it names
 *   present  — `node_modules` exists (a directory, or a link to one)
 *   missing  — declares some and has none: the state D-0152 is about
 */
export function dependencyTree(directory) {
  let declares = 0;
  let manifest = false;
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    manifest = true;
    declares = Object.keys(parsed.dependencies || {}).length + Object.keys(parsed.devDependencies || {}).length;
  } catch {
    // No manifest, or one that does not parse: not a Node project as far as
    // this question goes. The gate has its own word for an unreadable one.
  }
  const present = isDirectory(join(directory, 'node_modules'));
  return { manifest, declares, present, missing: manifest && declares > 0 && !present };
}

function isDirectory(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
