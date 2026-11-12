/** Conservative no-follow filesystem inventory for local programme content. */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { validateMemberPath } from './backup-archive.js';

const EXCLUDED_NAMES = new Map([
  ['.dev.vars', { classification: 'credential', source: 'approved backup design: credential material stays local' }],
  ['.env', { classification: 'credential', source: 'approved backup design: credential material stays local' }],
  ['.wrangler', { classification: 'host-dependency', source: 'test-databases.md and local-d1-bootstrap.mjs: local D1 state stays on the source host' }],
  ['node_modules', { classification: 'generated', source: '.gitignore: dependency receipts are regenerated from package manifests' }],
  ['.DS_Store', { classification: 'host-metadata', source: '.gitignore: macOS metadata' }],
  ['.test-timing', { classification: 'generated', source: 'approved backup design: test timing output is generated' }],
]);

function excludedMember(name, relativePath) {
  if (name === '.dev.vars' || name === '.env' || name.startsWith('.env.')) {
    return EXCLUDED_NAMES.get(name) || { classification: 'credential', source: 'approved backup design: credential material stays local' };
  }
  const byName = EXCLUDED_NAMES.get(name);
  if (byName) return byName;
  if (name === '__pycache__') return { classification: 'generated', source: 'approved backup design: Python bytecode cache is generated' };
  if (name.startsWith('.venv-')) return { classification: 'generated', source: 'mc tidy Rule P: virtual-environment residue is regenerated' };
  if (/(?:^|\/)public\/(?:dist|modules)$/u.test(relativePath)) return { classification: 'generated', source: 'approved backup design: generated public build output' };
  if (/(?:^|\/)scripts\/dev\/local-schema\.sql$/u.test(relativePath)) return { classification: 'generated', source: 'generate-local-schema.mjs: local schema is generated' };
  return null;
}

/**
 * Read a programme tree as typed archive members. Git administration is never
 * treated as ordinary content: callers must capture its objects and worktree
 * state through the repository bundle mechanism before claiming completeness.
 */
export function inventoryProgrammeTree(root, programme, { memberRoot = programme } = {}) {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`programme inventory root is not a real directory: ${root}`);
  const members = [];
  const repositories = [];
  const omissions = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join('/');
      const exclusion = excludedMember(entry.name, rel);
      if (exclusion) {
        // Classify before lstat/read/recursion: secrets and host-local state
        // must never be opened merely to decide not to archive them.
        omissions.push({ path: `${memberRoot}/${rel}`, ...exclusion });
        continue;
      }
      if (entry.name === '.git') {
        repositories.push({ path: `${memberRoot}/${relative(root, directory).split(sep).join('/')}`.replace(/\/$/u, ''), admin: absolute });
        continue;
      }
      const path = validateMemberPath(`${memberRoot}/${rel}`);
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
  return { members, repositories, omissions };
}
