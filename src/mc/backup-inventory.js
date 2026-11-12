/** Conservative no-follow filesystem inventory for local programme content. */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { validateMemberPath } from './backup-archive.js';

/**
 * Read a programme tree as typed archive members. Git administration is never
 * treated as ordinary content: callers must capture its objects and worktree
 * state through the repository bundle mechanism before claiming completeness.
 */
export function inventoryProgrammeTree(root, programme) {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`programme inventory root is not a real directory: ${root}`);
  const members = [];
  const repositories = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join('/');
      if (entry.name === '.git') {
        repositories.push({ path: `${programme}/${relative(root, directory).split(sep).join('/')}`.replace(/\/$/u, ''), admin: absolute });
        continue;
      }
      const path = validateMemberPath(`${programme}/${rel}`);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        members.push({ path, type: 'symlink', target: readlinkSync(absolute) });
      } else if (stat.isDirectory()) {
        members.push({ path, type: 'directory', mode: stat.mode & 0o7777 });
        visit(absolute);
      } else if (stat.isFile()) {
        const bytes = readFileSync(absolute);
        members.push({ path, type: 'file', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode: stat.mode & 0o7777, bytes });
      } else {
        throw new Error(`unsupported filesystem member ${path}`);
      }
    }
  };
  visit(root);
  return { members, repositories };
}
