/**
 * Write a file whole or not at all.
 *
 * Temp file in the same directory, then rename — rename is atomic within a
 * directory, so a reader holding the path sees the previous contents whole or
 * the new ones whole, never half of either. Two things in mc depend on that
 * and a third has just arrived: the watcher's snapshots, the repository lease,
 * and now a message dropped in somebody's inbox while they are reading it.
 *
 * It lives here rather than in any one of them because a second copy of this
 * mechanism is a second chance to get it subtly wrong.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeFileAtomic(path, contents, { mode = 0o600, dirMode = 0o700 } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: dirMode });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { mode });
  renameSync(temporary, path);
  return path;
}

export function writeJsonAtomic(path, value, options = {}) {
  return writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}
