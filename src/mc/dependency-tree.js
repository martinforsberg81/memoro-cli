/**
 * Can the declared dependencies be resolved from here?
 *
 * A suite run where they cannot does not fail — it runs the tests that happen
 * to need nothing and prints a number with the right shape (D-0152: 2162
 * tests, 30 fail, where 206 never ran and were not counted as skipped;
 * 2368/2368 once the tree was linked). Four of twenty-seven worktrees had no
 * tree at all. A number from such a run is not low, it is invalid, and nothing
 * about the number says so.
 *
 * The question used to be asked of one directory: is there a `node_modules`
 * *here*. That is not the question node answers. Node resolves a bare
 * specifier by walking `node_modules` up every parent of the importing file,
 * which is the whole mechanism `~/mc/node_modules` rests on — one tree above
 * every workarea and above the gate's candidate, and nothing inside either.
 * Asked the old way, every one of those directories reads as missing while its
 * imports resolve perfectly well, and the round would stop on a suite that was
 * about to run in full.
 *
 * So each declared name is looked for the way node looks for it: `node_modules/<name>`
 * in this directory, then in every directory above it. A manifest that declares
 * nothing needs no tree — the gate table's own proof for an undeclared
 * repository (`nothingToInstall`) — and a directory with no manifest is not a
 * Node project.
 *
 * It offers no opinion about what to do. `repo-gate.js` stops a round on the
 * answer; `work-status.js` puts a word on the page.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * `{ manifest, declares, present, unresolved, missing }`:
 *   manifest   — a `package.json` could be read
 *   declares   — how many dependencies + devDependencies it names
 *   present    — `node_modules` exists in *this* directory (a directory, or a
 *                link to one). Says where a tree is, not whether one is found.
 *   unresolved — the declared names that are in no `node_modules` from here up
 *   missing    — declares some and cannot resolve them all: the state D-0152
 *                is about, and the one that makes a suite number invalid
 */
export function dependencyTree(directory) {
  let names = [];
  let manifest = false;
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    manifest = true;
    names = [...Object.keys(parsed.dependencies || {}), ...Object.keys(parsed.devDependencies || {})];
  } catch {
    // No manifest, or one that does not parse: not a Node project as far as
    // this question goes. The gate has its own word for an unreadable one.
  }
  const unresolved = names.filter((name) => !resolvesFrom(directory, name));
  return {
    manifest,
    declares: names.length,
    present: isDirectory(join(directory, 'node_modules')),
    unresolved,
    missing: manifest && names.length > 0 && unresolved.length > 0,
  };
}

/**
 * One name, looked for where node would look: `node_modules/<name>` in this
 * directory and in every directory above it, up to the filesystem root.
 *
 * A half-installed tree is caught by this and was not caught by the old
 * question: an empty `node_modules` is a directory, and answered "present".
 */
function resolvesFrom(directory, name) {
  let at = directory;
  for (;;) {
    if (existsSync(join(at, 'node_modules', name))) return true;
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
}

function isDirectory(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
