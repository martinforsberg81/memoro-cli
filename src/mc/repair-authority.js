/** One live entrance owns the repair session and its programme writes. */
import { randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { workRoot } from './paths.js';
import { NAME_RE } from './plan-schema.js';
import { repairDigest } from './repair-manifest.js';
import { realLock } from './runner-lock.js';
import { pidAlive } from './status-collect.js';

const leasePath = (env, name) => join(workRoot(env), 'runner', 'repair-authors', `${name}.json`);
const readLease = (env, name) => {
  try { return JSON.parse(readFileSync(leasePath(env, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

export function isRepairAuthor(env, name, alive = pidAlive) {
  if (env.MC_ROLE !== 'repair' || env.MC_HEADLESS !== '1' || env.MC_PROGRAMME !== name
    || !NAME_RE.test(name) || !/^[a-f0-9]{48}$/u.test(env.MC_REPAIR_TOKEN ?? '')) return false;
  const lease = readLease(env, name);
  return Boolean(lease && Number.isInteger(lease.pid) && lease.pid > 0 && alive(lease.pid)
    && lease.digest === repairDigest(env.MC_REPAIR_TOKEN));
}

export async function withRepairAuthor(env, name, fn, { lock = realLock, alive = pidAlive } = {}) {
  if (!NAME_RE.test(name)) throw new Error('not a programme name');
  const path = leasePath(env, name);
  const token = randomBytes(24).toString('hex');
  const digest = repairDigest(token);
  const locked = action => lock(workRoot(env), action, { strict: true, name: 'repair-author' });
  locked(() => {
    const prior = readLease(env, name);
    if (Number.isInteger(prior?.pid) && prior.pid > 0 && alive(prior.pid)) throw new Error(`a repair session already owns ${name}`);
    writeJsonAtomic(path, { pid: process.pid, digest });
  });
  try { return await fn({ ...env, MC_ROLE: 'repair', MC_HEADLESS: '1', MC_PROGRAMME: name, MC_REPAIR_TOKEN: token }); }
  finally { locked(() => { if (readLease(env, name)?.digest === digest) unlinkSync(path); }); }
}
