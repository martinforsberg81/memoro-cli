/** Conservative content capture behind the durable programme writer fence. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createArchive } from './backup-archive.js';
import { inventoryProgrammeTree } from './backup-inventory.js';
import { beginBackup, backupStatus, resumeBackup } from './programme-lifecycle.js';
import { programsHome } from './paths.js';

const digest = (members) => createHash('sha256').update(JSON.stringify(members.map(({ bytes, ...member }) => member))).update(members.filter((member) => member.type === 'file').map((member) => member.bytes).reduce((all, bytes) => Buffer.concat([all, bytes]), Buffer.alloc(0))).digest('hex');

/**
 * Capture only a fully inventoried programme tree that has no Git worktrees.
 * Git repository reconstruction and external-process census remain required
 * before this path can claim a complete recoverable programme backup.
 */
export function createProgrammeBackup(selection, output, { env = process.env, id, inventory = inventoryProgrammeTree, create = createArchive, begin = beginBackup, status = backupStatus, resume = resumeBackup } = {}) {
  if (!isAbsolute(output)) throw new Error('backup output must be an absolute path');
  const transaction = begin(selection, { env, ...(id ? { id } : {}) });
  const pending = status(transaction.id, { env });
  if (pending.pending_writers.length) {
    return { state: 'draining', transaction, pending_writers: pending.pending_writers };
  }
  const held = resume(transaction.id, { env });
  const root = programsHome(env);
  const members = [];
  for (const programme of held.selection) {
    const directory = join(root, programme);
    if (!existsSync(directory)) throw new Error(`programme ${programme} has no local programme directory; listing-only and archived inventory is not yet supported`);
    const first = inventory(directory, programme);
    if (first.repositories.length) throw new Error(`programme ${programme} contains Git worktrees; bundle/index reconstruction is not yet available`);
    const second = inventory(directory, programme);
    if (digest(first.members) !== digest(second.members)) throw new Error(`programme ${programme} changed during backup capture`);
    members.push(...second.members);
  }
  const archive = create(output, {
    programmes: held.selection,
    members,
    metadata: { capture: 'programme-content-only', lifecycle_transaction: held.id, lifecycle_generation: held.generation },
  });
  return { state: 'held', completeness: 'content-only', transaction: held, archive };
}
