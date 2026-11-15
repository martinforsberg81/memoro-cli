/**
 * Two small things two callers need and that stand on git and tar alone:
 * `exportAtRev`, a path as a revision has it, and `reasonLine`, the line of a
 * failed command's output that says why. They are here and not in
 * `ios-build.js` because that module imports the deploy verb, and the deploy
 * verb makes the release reading (`take-back.js`), which writes memoro's
 * `scripts/` out with `exportAtRev`. `ios-build.js` re-exports both.
 */
import { spawnSync } from 'node:child_process';

import { run as runGit } from './git.js';

/**
 * The line of a failed command's output that says why: Node prints where it
 * threw before the error itself, so a first line can be
 * `node:internal/modules/esm/resolve:274`, which names nothing. The first
 * line that starts with an error's name, else the first line.
 */
export function reasonLine(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /^(?:[A-Z]\w*)?Error\b/u.test(line)) || lines[0] || '';
}

/**
 * `path` as `rev` has it, written under `dir`: `git archive` into `tar -x`.
 * Null when it was written, else the line that says why not.
 */
export function exportAtRev(repoPath, rev, path, dir) {
  const archive = runGit(undefined, ['-C', repoPath, 'archive', '--format=tar', rev, '--', path], {
    timeoutMs: 60_000, maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer',
  });
  if (archive.error || archive.status !== 0) {
    return `git archive ${rev} ${path}: ${reasonLine(archive.error?.message || String(archive.stderr || '')) || `exit ${archive.status}`}`;
  }
  const tar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout, timeout: 60_000 });
  if (tar.error || tar.status !== 0) {
    return `tar -x: ${reasonLine(tar.error?.message || String(tar.stderr || '')) || `exit ${tar.status}`}`;
  }
  return null;
}
