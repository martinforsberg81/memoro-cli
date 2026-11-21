/** Only a current reviewed repair draft can be released to the runner's cut. */
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

import { readTextOrNull } from './goals.js';
import { workRoot } from './paths.js';
import { changeProgrammeRecord } from './programme-record.js';
import { interruptedRepairCut } from './repair-cut.js';
import { isRepairAuthor } from './repair-authority.js';
import { repairSnapshot } from './repair-manifest.js';
import { currentRepairReview, REPAIR_REVIEW_FILE } from './repair-review.js';

export const needsRepairReview = name => `repair programme ${name} needs review — mc repair --resume ${name}`;
const refused = problem => ({ problems: [problem] });
export const isDesk = env => env.MC_ROLE === 'martin' && env.MC_HEADLESS !== '1';
export const deskRepairDraft = (env, record) => isDesk(env) && record?.state === 'draft' && record.repair?.desk === true;

/** Null for an ordinary programme, a refusal or the current release and its fixed inputs otherwise. */
export function repairReleaseState(dir, record) {
  if (!record?.repair) return null;
  const { release, stop_item: stop } = record.repair;
  const name = basename(dir);
  if (stop) return refused(`repair programme ${name} is at Martin (item ${stop})`);
  if (record.repair.disposition?.action === 'decline') return refused(`repair programme ${name} was declined at the desk`);
  if (!['ready', 'done'].includes(record.state)) return refused(`repair programme ${name} is ${record.state} — mc repair --resume ${name}`);
  try {
    const snapshot = repairSnapshot(dir);
    if (release?.manifest.revision === snapshot.manifest.revision) return { release, snapshot };
  } catch { /* A missing or unreadable input cannot be current. */ }
  return refused(needsRepairReview(name));
}

export function releaseRepair(dir, env, { lock, alive, read = readTextOrNull } = {}) {
  const name = basename(dir);
  return changeProgrammeRecord(dir, record => {
    if (!record.repair) return refused(`${name} is not a repair-owned programme`);
    if (record.repair.desk || !isRepairAuthor(env, name, alive)) return refused('only the assigned repair session may release this repair order');
    if (record.state !== 'draft' || record.repair.stop_item) return refused(repairReleaseState(dir, record)?.problems?.[0]
      ?? `repair programme ${name} is already ${record.state}`);
    if (record.repair.pending_scope) return refused(`repair programme ${name} has a pending scope stop — mc repair --resume ${name}`);
    let reading;
    try { reading = currentRepairReview(dir, { read }); } catch { /* no current reading */ }
    if (!reading || reading.findings.length) return refused(needsRepairReview(name));
    const interrupted = interruptedRepairCut(dir, record.repair, { read });
    if (interrupted.problems) return interrupted;
    const release = { revision: randomUUID(), manifest: reading.snapshot.manifest, ...interrupted };
    return { ...record, state: 'ready', repair: { ...record.repair, release } };
  }, { root: workRoot(env), lock, read }, 'repair-release');
}

/** A current ready release is left alone so resume can retry only source archival. */
export function reopenRepair(dir, env, { lock, alive } = {}) {
  const name = basename(dir);
  return changeProgrammeRecord(dir, record => {
    if (!record.repair) return refused(`${name} is not a repair-owned programme`);
    if (record.repair.desk || !isRepairAuthor(env, name, alive)) return refused('only the assigned repair session may resume this repair order');
    if (record.repair.stop_item || record.repair.disposition?.action === 'decline' || !['draft', 'ready'].includes(record.state)) return refused(repairReleaseState(dir, record)?.problems?.[0]
      ?? `repair programme ${name} is ${record.state}`);
    if (record.state === 'draft' || repairReleaseState(dir, record)?.release) return record;
    return { ...record, state: 'draft' };
  }, { root: workRoot(env), lock }, 'repair-reopen', {
    beforeWrite: write => write(join(dir, REPAIR_REVIEW_FILE), '{}\n'),
  });
}
