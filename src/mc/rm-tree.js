/**
 * Remove a tree, read-only files and all.
 *
 * `rm -r` fails on a read-only file inside a read-only directory: memoro's
 * dependency cache copies are read-only, and a session's `depcache/` under
 * scratch made the chore pass's removal fail with EACCES on 2026-10-25. So
 * every directory and regular file under `path` gets its owner-write bit back
 * first, and then the tree goes.
 *
 * A symbolic link is never touched and never followed: its target is not part
 * of the tree, and a link into a read-only file outside it must leave that
 * file as it was. `rmSync` removes the link itself.
 *
 * True when `path` is gone afterwards, false on any error.
 */
import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function makeWritable(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, stat.mode | 0o200);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
    return;
  }
  if (stat.isFile()) chmodSync(path, stat.mode | 0o200);
}

/** Whether nothing is at `path` any more, a dangling link included. */
function absent(path) {
  try { lstatSync(path); return false; } catch (error) { return error?.code === 'ENOENT'; }
}

export function rmTree(path) {
  try {
    if (absent(path)) return true;
    makeWritable(path);
    rmSync(path, { recursive: true, force: true });
    return absent(path);
  } catch {
    return false;
  }
}
