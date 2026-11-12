/** Conservative content capture behind the durable programme writer fence. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createArchive } from './backup-archive.js';
import { inventoryProgrammeTree } from './backup-inventory.js';
import { beginBackup, backupStatus, resumeBackup } from './programme-lifecycle.js';
import { planHome, programsHome } from './paths.js';

const digest = (members) => createHash('sha256').update(JSON.stringify(members.map(({ bytes, ...member }) => member))).update(members.filter((member) => member.type === 'file').map((member) => member.bytes).reduce((all, bytes) => Buffer.concat([all, bytes]), Buffer.alloc(0))).digest('hex');

/**
 * Capture selected current and legacy planning trees only when neither holds Git worktrees.
 * Git repository reconstruction and external-process census remain required
 * before this path can claim a complete recoverable programme backup.
 */
export function createProgrammeBackup(selection, output, { env = process.env, id, inventory = inventoryProgrammeTree, create = createArchive, begin = beginBackup, status = backupStatus, resume = resumeBackup } = {}) {
  if (!isAbsolute(output)) throw new Error('backup output must be an absolute path');
  // Reject a known occupied destination before acquiring the durable lifecycle
  // fence. A failed publication must not strand otherwise runnable work just
  // because the caller selected an archive path that already exists (including
  // a dangling symlink, which existsSync intentionally does not report).
  try {
    lstatSync(output);
    throw new Error(`archive output already exists: ${output}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const transaction = begin(selection, { env, ...(id ? { id } : {}) });
  const pending = status(transaction.id, { env });
  if (pending.pending_writers.length) {
    return { state: 'draining', transaction, pending_writers: pending.pending_writers };
  }
  const held = resume(transaction.id, { env });
  const roots = [
    { base: programsHome(env), memberRoot: (programme) => programme },
    { base: planHome(env), memberRoot: (programme) => `${programme}/legacy-plan` },
  ];
  const localTrees = (programme) => roots.flatMap(({ base, memberRoot }) => {
    const directory = join(base, programme);
    try {
      lstatSync(directory);
      return [{ directory, memberRoot: memberRoot(programme) }];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  });
  const members = [];
  for (const programme of held.selection) {
    const selectedRoots = localTrees(programme);
    if (!selectedRoots.length) throw new Error(`programme ${programme} has no local programme or legacy planning directory; listing-only and archived inventory is not yet supported`);
    const first = [];
    const second = [];
    for (const { directory, memberRoot } of selectedRoots) {
      const inventoryOptions = { memberRoot };
      const before = inventory(directory, programme, inventoryOptions);
      if (before.repositories.length) throw new Error(`programme ${programme} contains Git worktrees; bundle/index reconstruction is not yet available`);
      first.push(...before.members);
      const after = inventory(directory, programme, inventoryOptions);
      second.push(...after.members);
    }
    if (digest(first) !== digest(second)) throw new Error(`programme ${programme} changed during backup capture`);
    const finalRoots = localTrees(programme);
    if (JSON.stringify(finalRoots.map(({ memberRoot }) => memberRoot)) !== JSON.stringify(selectedRoots.map(({ memberRoot }) => memberRoot))) {
      throw new Error(`programme ${programme} local tree set changed during backup capture`);
    }
    members.push(...second);
  }
  const archive = create(output, {
    programmes: held.selection,
    members,
    metadata: { capture: 'programme-content-only', lifecycle_transaction: held.id, lifecycle_generation: held.generation },
  });
  return { state: 'held', completeness: 'content-only', transaction: held, archive };
}
